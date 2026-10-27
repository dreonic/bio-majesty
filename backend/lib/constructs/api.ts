import { Duration, Size } from 'aws-cdk-lib';
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

  constructor(scope: Construct, id: string, props: ApiProps) {
    super(scope, id);
    const { config, data, pipeline, functions, allowedOrigins } = props;

    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention: logs.RetentionDays.ONE_MONTH });
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `bio-majesty-${config.stage}`,
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
        allowHeaders: ['Authorization', 'Content-Type'],
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
          'Access-Control-Allow-Headers': "'Authorization,Content-Type'",
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
      data.secret.grantRead(fn);
      this.functions.push(fn);
      return fn;
    };

    const news = make('News', 'api/news.ts');
    data.dataBucket.grantRead(news);
    // Deleting skipped/filtered articles also removes their extracted text (users/<sub>/articles/*).
    data.dataBucket.grantDelete(news, 'users/*');

    const categories = make('Categories', 'api/categories.ts', {
      environment: { BACKFILL_STATE_MACHINE_ARN: pipeline.backfillMachine.stateMachineArn },
    });
    pipeline.backfillMachine.grantStartExecution(categories);

    // Run times live in each account's settings (read by the dispatcher): no schedule to update here.
    const settings = make('Settings', 'api/settings.ts', {
      environment: { DAILY_STATE_MACHINE_ARN: pipeline.dailyMachine.stateMachineArn },
    });
    pipeline.dailyMachine.grantStartExecution(settings);

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

    route('/telegram/link', { POST: telegram, DELETE: telegram });
    route('/telegram/link/verify', { POST: telegram });
    route('/telegram/test', { POST: telegram });

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
