import { Duration, TimeZone } from 'aws-cdk-lib';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import type { AppConfig } from '../config';
import type { DataConstruct } from './data';
import type { FunctionFactory } from './functions';

export interface PipelineProps {
  config: AppConfig;
  data: DataConstruct;
  functions: FunctionFactory;
  /** Its `dashboard-users` group is the list of accounts the background jobs work for. */
  userPool: cognito.IUserPool;
}

type PipelineFunctions = Record<
  'start' | 'search' | 'collect' | 'prefilter' | 'enrich' | 'digest' | 'finish' | 'fail',
  lambda.IFunction
>;

/**
 * News ingestion (daily + backfill state machines, one execution per account), the
 * dispatcher that starts each account's daily run, the stock refresh schedule, and
 * the vector indexer fed by the DynamoDB stream.
 */
export class PipelineConstruct extends Construct {
  readonly dailyMachine: sfn.StateMachine;
  readonly backfillMachine: sfn.StateMachine;
  readonly schedulerRole: iam.Role;
  readonly dispatchFn: lambda.IFunction;
  readonly stockIngestFn: lambda.IFunction;
  readonly pipelineFunctions: lambda.IFunction[];
  readonly indexerFn: lambda.IFunction;

  constructor(scope: Construct, id: string, props: PipelineProps) {
    super(scope, id);
    const { config, data, functions } = props;

    const make = (name: keyof PipelineFunctions, timeout: Duration, memorySize = 512) =>
      functions.create(`Pipeline${name[0]!.toUpperCase()}${name.slice(1)}`, {
        entry: 'pipeline.ts',
        handler: name,
        description: `News pipeline: ${name}`,
        timeout,
        memorySize,
      });

    const fns: PipelineFunctions = {
      start: make('start', Duration.minutes(1)),
      search: make('search', Duration.minutes(14)),
      collect: make('collect', Duration.minutes(3), 1024),
      prefilter: make('prefilter', Duration.minutes(10), 1024),
      enrich: make('enrich', Duration.minutes(5), 1024),
      digest: make('digest', Duration.minutes(5)),
      finish: make('finish', Duration.minutes(1)),
      fail: make('fail', Duration.minutes(1)),
    };
    this.pipelineFunctions = Object.values(fns);
    for (const fn of this.pipelineFunctions) {
      data.table.grantReadWriteData(fn);
      data.dataBucket.grantReadWrite(fn);
      data.apiKeys.grantRead(fn);
    }

    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH });
    this.dailyMachine = this.buildMachine('Daily', fns, data, logGroup, { searchConcurrency: 3, timeout: Duration.hours(2) });
    this.backfillMachine = this.buildMachine('Backfill', fns, data, logGroup, { searchConcurrency: 2, timeout: Duration.hours(10) });

    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler run the news dispatcher and stock refreshes',
    });
    const every15Minutes = scheduler.ScheduleExpression.cron({ minute: '0/15', timeZone: TimeZone.of(config.timeZone) });
    const readAccounts = (fn: lambda.IFunction) => props.userPool.grant(fn, 'cognito-idp:ListUsersInGroup');

    // Each account picks its daily-run time in Settings (quarter hours on the dashboard's clock):
    // every 15 minutes the dispatcher starts the runs that are due.
    this.dispatchFn = functions.create('NewsDispatch', {
      entry: 'dispatch.ts',
      description: "Start each account's daily news run at its chosen time",
      timeout: Duration.minutes(1),
      environment: { DAILY_STATE_MACHINE_ARN: this.dailyMachine.stateMachineArn },
    });
    data.table.grantReadData(this.dispatchFn);
    readAccounts(this.dispatchFn);
    this.dailyMachine.grantStartExecution(this.dispatchFn);
    new scheduler.Schedule(this, 'NewsDispatchSchedule', {
      scheduleName: `bio-majesty-${config.stage}-news-dispatch`,
      description: "Starts the accounts' daily news runs (each account's time is in its Settings)",
      schedule: every15Minutes,
      target: new schedulerTargets.LambdaInvoke(this.dispatchFn, { role: this.schedulerRole, retryAttempts: 0 }),
    });

    // Market data for every asset any account tracks, each from its own source. Each tick only asks
    // for assets whose market is open, or whose end-of-day refresh is due, to keep requests low.
    this.stockIngestFn = functions.create('StockIngest', {
      entry: 'stock-ingest.ts',
      description: 'Refresh market data of the tracked assets (intraday / end-of-day / full history)',
      timeout: Duration.minutes(5),
    });
    data.table.grantReadWriteData(this.stockIngestFn);
    data.apiKeys.grantRead(this.stockIngestFn);
    readAccounts(this.stockIngestFn);
    new scheduler.Schedule(this, 'StockRefreshSchedule', {
      scheduleName: `bio-majesty-${config.stage}-stock-refresh`,
      description: 'Market-data refresh every 15 minutes (each asset follows its own trading session)',
      schedule: every15Minutes,
      target: new schedulerTargets.LambdaInvoke(this.stockIngestFn, {
        role: this.schedulerRole,
        input: scheduler.ScheduleTargetInput.fromObject({ mode: 'tick' }),
        retryAttempts: 0,
      }),
    });

    // Index approved articles into S3 Vectors.
    this.indexerFn = functions.create('Indexer', {
      entry: 'indexer.ts',
      description: 'Embed approved articles into S3 Vectors (DynamoDB stream consumer)',
      timeout: Duration.minutes(5),
      memorySize: 1024,
    });
    data.table.grantReadWriteData(this.indexerFn);
    data.dataBucket.grantRead(this.indexerFn);
    data.apiKeys.grantRead(this.indexerFn);
    this.indexerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3vectors:PutVectors', 's3vectors:DeleteVectors', 's3vectors:GetVectors', 's3vectors:ListVectors'],
        resources: [data.vectorIndexArn],
      }),
    );
    this.indexerFn.addEventSource(
      new lambdaEventSources.DynamoEventSource(data.table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        retryAttempts: 5,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        filters: [
          // Only the accounts' article items (USER#<sub> / ART#<id>) matter to the index.
          lambda.FilterCriteria.filter({
            dynamodb: { Keys: { PK: { S: lambda.FilterRule.beginsWith('USER#') }, SK: { S: lambda.FilterRule.beginsWith('ART#') } } },
          }),
        ],
      }),
    );
  }

  private buildMachine(
    name: 'Daily' | 'Backfill',
    fns: PipelineFunctions,
    data: DataConstruct,
    logGroup: logs.ILogGroup,
    opts: { searchConcurrency: number; timeout: Duration },
  ): sfn.StateMachine {
    const invoke = (id: string, fn: lambda.IFunction) =>
      new tasks.LambdaInvoke(this, `${name}${id}`, {
        lambdaFunction: fn,
        payloadResponseOnly: true,
        retryOnServiceExceptions: true,
      });

    const fail = invoke('Fail', fns.fail).next(new sfn.Fail(this, `${name}Failed`, { comment: 'Run failed (see the Fail step input)' }));
    const catchAll = <T extends sfn.TaskStateBase | sfn.Map | sfn.DistributedMap>(state: T): T => {
      state.addCatch(fail, { resultPath: '$.error' });
      return state;
    };

    const start = catchAll(invoke('Start', fns.start));

    // Search tasks run in parallel; a failed query is logged and skipped.
    const searchStep = invoke('Search', fns.search).addRetry({ errors: ['States.ALL'], maxAttempts: 2, interval: Duration.seconds(15), backoffRate: 2 });
    searchStep.addCatch(new sfn.Pass(this, `${name}SearchSkipped`), { resultPath: sfn.JsonPath.DISCARD });
    const searchMap = catchAll(
      new sfn.Map(this, `${name}SearchMap`, {
        itemsPath: '$.tasks',
        maxConcurrency: opts.searchConcurrency,
        itemSelector: { 'sub.$': '$.sub', 'runId.$': '$.runId', 'task.$': '$$.Map.Item.Value' },
        resultPath: sfn.JsonPath.DISCARD,
      }),
    );
    searchMap.itemProcessor(searchStep);

    const collect = catchAll(invoke('Collect', fns.collect));
    const prefilter = catchAll(invoke('Prefilter', fns.prefilter));

    // Each relevant candidate is fetched + tagged in its own child execution.
    const enrichStep = invoke('Enrich', fns.enrich).addRetry({ errors: ['States.ALL'], maxAttempts: 2, interval: Duration.seconds(20), backoffRate: 2 });
    enrichStep.addCatch(new sfn.Pass(this, `${name}EnrichSkipped`), { resultPath: sfn.JsonPath.DISCARD });
    const enrichMap = catchAll(
      new sfn.DistributedMap(this, `${name}EnrichMap`, {
        itemReader: new sfn.S3JsonItemReader({ bucket: data.dataBucket, key: sfn.JsonPath.stringAt('$.relevantKey') }),
        itemSelector: {
          'sub.$': '$.sub',
          'runId.$': '$.runId',
          'runType.$': '$.runType',
          'categoryId.$': '$.categoryId',
          'candidateId.$': '$$.Map.Item.Value.id',
        },
        maxConcurrency: 4,
        toleratedFailurePercentage: 50,
        mapExecutionType: sfn.StateMachineType.STANDARD,
        resultPath: sfn.JsonPath.DISCARD,
      }),
    );
    enrichMap.itemProcessor(enrichStep);

    const digest = catchAll(invoke('Digest', fns.digest));
    const finish = catchAll(invoke('Finish', fns.finish));
    digest.next(finish).next(new sfn.Succeed(this, `${name}Done`));

    const hasRelevant = new sfn.Choice(this, `${name}HasRelevant`)
      .when(sfn.Condition.numberGreaterThan('$.relevantCount', 0), enrichMap.next(digest))
      .otherwise(digest);

    const definition = start.next(searchMap).next(collect).next(prefilter).next(hasRelevant);

    return new sfn.StateMachine(this, `${name}Machine`, {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: opts.timeout,
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ERROR, includeExecutionData: false },
      comment: name === 'Daily' ? 'Daily news run' : 'Historical search for a new category',
    });
  }
}
