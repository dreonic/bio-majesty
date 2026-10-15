import { Duration, TimeZone } from 'aws-cdk-lib';
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
}

type PipelineFunctions = Record<
  'start' | 'search' | 'collect' | 'prefilter' | 'enrich' | 'digest' | 'finish' | 'fail',
  lambda.IFunction
>;

/**
 * News ingestion (daily + backfill state machines), stock refresh schedules,
 * and the vector indexer fed by the DynamoDB stream.
 */
export class PipelineConstruct extends Construct {
  readonly dailyMachine: sfn.StateMachine;
  readonly backfillMachine: sfn.StateMachine;
  readonly dailySchedule: scheduler.Schedule;
  readonly schedulerRole: iam.Role;
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
      data.secret.grantRead(fn);
    }

    const logGroup = new logs.LogGroup(this, 'StateMachineLogs', { retention: logs.RetentionDays.ONE_MONTH });
    this.dailyMachine = this.buildMachine('Daily', fns, data, logGroup, { searchConcurrency: 3, timeout: Duration.hours(2) });
    this.backfillMachine = this.buildMachine('Backfill', fns, data, logGroup, { searchConcurrency: 2, timeout: Duration.hours(10) });

    // Daily ingest schedule, 06:00 on the exec's clock. The time is editable in Settings
    // (UpdateSchedule at runtime).
    this.schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Lets EventBridge Scheduler start the daily news run and stock refreshes',
    });
    this.dailySchedule = new scheduler.Schedule(this, 'DailyIngestSchedule', {
      scheduleName: `bio-majesty-${config.stage}-daily-ingest`,
      description: 'Daily news run (time editable in the dashboard Settings page)',
      schedule: scheduler.ScheduleExpression.cron({ minute: '0', hour: '6', timeZone: TimeZone.of(config.timeZone) }),
      target: new schedulerTargets.StepFunctionsStartExecution(this.dailyMachine, {
        role: this.schedulerRole,
        input: scheduler.ScheduleTargetInput.fromObject({ mode: 'daily', trigger: 'schedule' }),
      }),
    });

    // Stock data refresh (Yahoo by default; ~30 calls/day keeps rate limits happy).
    this.stockIngestFn = functions.create('StockIngest', {
      entry: 'stock-ingest.ts',
      description: 'Refresh PRDA prices (intraday / end-of-day / full history)',
      timeout: Duration.minutes(2),
    });
    data.table.grantReadWriteData(this.stockIngestFn);
    data.secret.grantRead(this.stockIngestFn);
    const stockTarget = (mode: string) =>
      new schedulerTargets.LambdaInvoke(this.stockIngestFn, {
        role: this.schedulerRole,
        input: scheduler.ScheduleTargetInput.fromObject({ mode }),
        retryAttempts: 0,
      });
    // IDX trades on Jakarta time wherever the exec is, so these stay on Asia/Jakarta
    // (09:00–16:45 and 17:30 WIB = 10:00–17:45 and 18:30 in Singapore).
    new scheduler.Schedule(this, 'StockIntradaySchedule', {
      scheduleName: `bio-majesty-${config.stage}-stock-intraday`,
      description: 'PRDA intraday refresh every 15 minutes during IDX trading hours (WIB)',
      schedule: scheduler.ScheduleExpression.cron({ minute: '0/15', hour: '9-16', weekDay: 'MON-FRI', timeZone: TimeZone.ASIA_JAKARTA }),
      target: stockTarget('intraday'),
    });
    new scheduler.Schedule(this, 'StockEodSchedule', {
      scheduleName: `bio-majesty-${config.stage}-stock-eod`,
      description: 'PRDA end-of-day refresh after the IDX close (17:30 WIB)',
      schedule: scheduler.ScheduleExpression.cron({ minute: '30', hour: '17', weekDay: 'MON-FRI', timeZone: TimeZone.ASIA_JAKARTA }),
      target: stockTarget('eod'),
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
    data.secret.grantRead(this.indexerFn);
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
          // Only article items (PK starts with ART#) matter to the index.
          lambda.FilterCriteria.filter({ dynamodb: { Keys: { PK: { S: lambda.FilterRule.beginsWith('ART#') } } } }),
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
        itemSelector: { 'runId.$': '$.runId', 'task.$': '$$.Map.Item.Value' },
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
