import { ArnFormat, Duration, Size, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import type { AppConfig } from '../config';
import type { DataConstruct } from './data';
import type { FunctionFactory } from './functions';
import type { PipelineConstruct } from './pipeline';

export interface ApiProps {
  config: AppConfig;
  data: DataConstruct;
  pipeline: PipelineConstruct;
  functions: FunctionFactory;
  userPool: cognito.IUserPool;
  allowedOrigins: string[];
}

/** REST API (regional) with a Cognito authorizer on every route and a streaming chat endpoint. */
export class ApiConstruct extends Construct {
  readonly api: apigateway.RestApi;
  readonly url: string;
  readonly functions: lambda.IFunction[] = [];
  /** Deletes a profile's data, or an account's profiles and user, invoked asynchronously by the API. */
  readonly deleteWorkerFn: lambda.IFunction;
  /** The /profiles API (its environment also serves the migration scripts). */
  readonly profilesFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { config, data, pipeline, functions, allowedOrigins } = props;

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention: logs.RetentionDays.ONE_MONTH });
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${config.resourcePrefix}-${config.stage}`,
      description: 'News Accumulator API',
      endpointConfiguration: { types: [apigateway.EndpointType.REGIONAL] },
      // gzip JSON responses of 1 KB or more for browsers that accept it (e.g. MAX history,
      // CSV downloads). Streamed chat responses are never compressed by API Gateway.
      minCompressionSize: Size.kibibytes(1),
      cloudWatchRole: true,
      deployOptions: {
        stageName: 'api',
        throttlingRateLimit: 20,
        throttlingBurstLimit: 40,
        metricsEnabled: true,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      },
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowHeaders: ['Authorization', 'Content-Type', 'X-Profile-Id'],
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        maxAge: Duration.hours(1),
      },
    });
    // Errors produced by API Gateway itself (401, 429, 5xx) also need CORS headers.
    for (const type of [apigateway.ResponseType.DEFAULT_4XX, apigateway.ResponseType.DEFAULT_5XX]) {
      this.api.addGatewayResponse(`Cors${type.responseType}`, {
        type,
        responseHeaders: {
          'Access-Control-Allow-Origin': 'method.request.header.origin',
          'Access-Control-Allow-Headers': "'Authorization,Content-Type,X-Profile-Id'",
        },
      });
    }

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
      cognitoUserPools: [props.userPool],
    });
    const auth: apigateway.MethodOptions = { authorizer, authorizationType: apigateway.AuthorizationType.COGNITO };

    const make = (name: string, entry: string, opts: { timeout?: Duration; memorySize?: number; environment?: Record<string, string> } = {}) => {
      const fn = functions.create(`Api${name}`, {
        entry,
        description: `API: ${name}`,
        timeout: opts.timeout ?? Duration.seconds(29),
        memorySize: opts.memorySize,
        environment: opts.environment,
      });
      data.table.grantReadWriteData(fn);
      data.apiKeys.grantRead(fn);
      this.functions.push(fn);
      return fn;
    };

    const news = make('News', 'api/news.ts');
    data.dataBucket.grantRead(news);
    // Deleting skipped/filtered articles also removes their extracted text (profiles/<id>/articles/*).
    data.dataBucket.grantDelete(news, 'profiles/*');

    const categories = make('Categories', 'api/categories.ts', {
      environment: { BACKFILL_STATE_MACHINE_ARN: pipeline.backfillMachine.stateMachineArn },
    });
    pipeline.backfillMachine.grantStartExecution(categories);
    // Cancelling (or deleting) a category stops its running backfill.
    pipeline.backfillMachine.grant(categories, 'states:ListExecutions');
    pipeline.backfillMachine.grantExecution(categories, 'states:StopExecution');

    // Each profile's daily run is started by its own schedule, which follows the run time in its Settings.
    const scheduleEnv = {
      DAILY_STATE_MACHINE_ARN: pipeline.dailyMachine.stateMachineArn,
      DAILY_SCHEDULE_GROUP: pipeline.dailyScheduleGroup.scheduleGroupName,
      SCHEDULER_ROLE_ARN: pipeline.schedulerRole.roleArn,
    };
    const writeSchedules = (fn: lambda.IFunction) => {
      pipeline.dailyScheduleGroup.grants.writeSchedules(fn);
      pipeline.schedulerRole.grantPassRole(fn.grantPrincipal);
    };
    const settings = make('Settings', 'api/settings.ts', { environment: scheduleEnv });
    pipeline.dailyMachine.grantStartExecution(settings);
    writeSchedules(settings);

    const stock = make('Stock', 'api/stock.ts', {
      environment: { STOCK_INGEST_FUNCTION: pipeline.stockIngestFn.functionName },
    });
    pipeline.stockIngestFn.grantInvoke(stock);

    const telegram = make('Telegram', 'api/telegram.ts');

    const chatHistory = make('ChatHistory', 'api/chat-history.ts');
    data.dataBucket.grantReadWrite(chatHistory);

    const chat = make('ChatStream', 'chat-stream.ts', { timeout: Duration.minutes(10), memorySize: 1024 });
    data.dataBucket.grantReadWrite(chat);
    chat.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:QueryVectors', 's3vectors:GetVectors'],
        resources: [data.vectorIndexArn],
      }),
    );

    // Deleting a profile (Settings) or a user (Admin page) hands the data to a worker that isn't
    // bound by the API's 29 seconds; an account with many profiles carries on in a new invocation of
    // itself (hence its fixed name).
    const deleteWorkerName = `${config.resourcePrefix}-${config.stage}-delete-worker`;
    const deleteWorker = functions.create('DeleteWorker', {
      entry: 'delete-worker.ts',
      functionName: deleteWorkerName,
      description: "Delete a profile's data, or an account's profiles and then its user",
      timeout: Duration.minutes(15),
      environment: {
        DAILY_SCHEDULE_GROUP: pipeline.dailyScheduleGroup.scheduleGroupName,
        DAILY_STATE_MACHINE_ARN: pipeline.dailyMachine.stateMachineArn,
        BACKFILL_STATE_MACHINE_ARN: pipeline.backfillMachine.stateMachineArn,
      },
    });
    data.table.grantReadWriteData(deleteWorker);
    data.dataBucket.grantRead(deleteWorker);
    data.dataBucket.grantDelete(deleteWorker, 'profiles/*');
    props.userPool.grant(deleteWorker, 'cognito-idp:AdminDeleteUser');
    pipeline.dailyScheduleGroup.grants.deleteSchedules(deleteWorker);
    for (const machine of [pipeline.dailyMachine, pipeline.backfillMachine]) {
      machine.grant(deleteWorker, 'states:ListExecutions');
      machine.grantExecution(deleteWorker, 'states:DescribeExecution', 'states:StopExecution');
    }
    deleteWorker.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [Stack.of(this).formatArn({ service: 'lambda', resource: 'function', resourceName: deleteWorkerName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      }),
    );
    this.functions.push(deleteWorker);
    this.deleteWorkerFn = deleteWorker;

    // The account's profiles: list, create (with its schedule), rename, delete.
    const profiles = make('Profiles', 'api/profiles.ts', { environment: { ...scheduleEnv, DELETE_WORKER_FUNCTION: deleteWorker.functionName } });
    writeSchedules(profiles);
    pipeline.dailyScheduleGroup.grants.deleteSchedules(profiles);
    this.profilesFn = profiles;
    // Taking back a profile whose schedule couldn't be created deletes its (few) items and objects.
    data.dataBucket.grantRead(profiles);
    data.dataBucket.grantDelete(profiles, 'profiles/*');
    deleteWorker.grantInvoke(profiles);

    // User management for the admins group.
    const admin = make('Admin', 'api/admin.ts', {
      environment: { DELETE_WORKER_FUNCTION: deleteWorker.functionName, PASSWORD_SIGN_IN: String(config.passwordSignIn) },
    });
    props.userPool.grant(
      admin,
      'cognito-idp:ListUsers',
      'cognito-idp:ListUsersInGroup',
      'cognito-idp:AdminGetUser',
      'cognito-idp:AdminListGroupsForUser',
      'cognito-idp:AdminCreateUser',
      'cognito-idp:AdminAddUserToGroup',
      'cognito-idp:AdminRemoveUserFromGroup',
      'cognito-idp:AdminEnableUser',
      'cognito-idp:AdminDisableUser',
      'cognito-idp:AdminUserGlobalSignOut',
    );
    deleteWorker.grantInvoke(admin);

    const integrate = (fn: lambda.IFunction) => new apigateway.LambdaIntegration(fn, { scopePermissionToMethod: false });
    const route = (path: string, methods: Record<string, lambda.IFunction>) => {
      const resource = this.api.root.resourceForPath(path);
      for (const [method, fn] of Object.entries(methods)) resource.addMethod(method, integrate(fn), auth);
    };

    route('/news', { GET: news });
    route('/news/counts', { GET: news });
    route('/news/bulk', { POST: news });
    route('/news/delete', { POST: news });
    route('/news/{id}', { GET: news, PATCH: news });
    route('/digest/latest', { GET: news });
    route('/feedback/stats', { GET: news });

    route('/categories', { GET: categories, POST: categories });
    route('/categories/suggest-queries', { POST: categories });
    route('/categories/{id}', { PATCH: categories, DELETE: categories });
    route('/categories/{id}/backfill', { POST: categories });

    route('/settings', { GET: settings, PUT: settings });
    route('/settings/models', { GET: settings });
    route('/settings/test-model', { POST: settings });
    route('/runs', { GET: settings });
    route('/runs/daily', { POST: settings });

    route('/stock/assets', { GET: stock, POST: stock, DELETE: stock });
    route('/stock/search', { GET: stock });
    route('/stock/history', { GET: stock });
    route('/stock/anomalies', { GET: stock });
    route('/stock/export', { GET: stock });
    route('/stock/resync', { POST: stock });

    route('/telegram/link', { POST: telegram });
    route('/telegram/link/verify', { POST: telegram });
    route('/telegram/links/{id}', { DELETE: telegram });
    route('/telegram/links/{id}/test', { POST: telegram });

    route('/profiles', { GET: profiles, POST: profiles });
    route('/profiles/{id}', { PATCH: profiles, DELETE: profiles });

    route('/admin/users', { GET: admin, POST: admin });
    route('/admin/users/{username}', { PATCH: admin, DELETE: admin });
    route('/admin/users/{username}/invite', { POST: admin });

    route('/chat/conversations', { GET: chatHistory });
    route('/chat/conversations/{id}', { GET: chatHistory, DELETE: chatHistory });

    // Streaming chat (API Gateway REST response streaming, up to 15 minutes).
    this.api.root.resourceForPath('/chat').addMethod(
      'POST',
      new apigateway.LambdaIntegration(chat, {
        responseTransferMode: apigateway.ResponseTransferMode.STREAM,
        timeout: Duration.minutes(15),
        scopePermissionToMethod: false,
      }),
      auth,
    );

    this.url = this.api.urlForPath('/');
  }
}
