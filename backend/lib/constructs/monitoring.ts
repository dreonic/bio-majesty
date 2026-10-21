import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import type { AppConfig } from '../config';

export interface MonitoringProps {
  config: AppConfig;
  stateMachines: sfn.StateMachine[];
  dispatcher: lambda.IFunction;
  stockIngest: lambda.IFunction;
  indexer: lambda.IFunction;
  apiFunctions: lambda.IFunction[];
}

/**
 * Operational alarms (for whoever maintains the stack; the exec gets run
 * failures on Telegram). Set `alarmEmail` in cdk.json to receive them.
 */
export class MonitoringConstruct extends Construct {
  readonly topic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringProps) {
    super(scope, id);
    this.topic = new sns.Topic(this, 'Alarms', { displayName: `bio-majesty ${props.config.stage} alarms`, enforceSSL: true });
    if (props.config.alarmEmail) this.topic.addSubscription(new subscriptions.EmailSubscription(props.config.alarmEmail));
    const action = new actions.SnsAction(this.topic);

    for (const machine of props.stateMachines) {
      machine
        .metricFailed({ period: Duration.minutes(5), statistic: 'Sum' })
        .createAlarm(this, `${machine.node.id}Failed`, {
          threshold: 1,
          evaluationPeriods: 1,
          treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmDescription: 'A news pipeline run failed',
        })
        .addAlarmAction(action);
    }

    props.dispatcher
      .metricErrors({ period: Duration.hours(1), statistic: 'Sum' })
      .createAlarm(this, 'NewsDispatchErrors', {
        threshold: 2,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: "The dispatcher can't start the accounts' daily news runs",
      })
      .addAlarmAction(action);

    props.stockIngest
      .metricErrors({ period: Duration.hours(1), statistic: 'Sum' })
      .createAlarm(this, 'StockIngestErrors', {
        threshold: 3,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Stock data refresh is failing (Yahoo rate limits or outage?)',
      })
      .addAlarmAction(action);

    props.indexer
      .metricErrors({ period: Duration.minutes(15), statistic: 'Sum' })
      .createAlarm(this, 'IndexerErrors', {
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Approved articles are failing to index for chat',
      })
      .addAlarmAction(action);

    const apiErrors = new cloudwatch.MathExpression({
      expression: props.apiFunctions.map((_, i) => `e${i}`).join(' + '),
      usingMetrics: Object.fromEntries(
        props.apiFunctions.map((fn, i) => [`e${i}`, fn.metricErrors({ period: Duration.minutes(15), statistic: 'Sum' })]),
      ),
      period: Duration.minutes(15),
      label: 'API Lambda errors',
    });
    apiErrors
      .createAlarm(this, 'ApiErrors', {
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'API Lambda functions are throwing errors',
      })
      .addAlarmAction(action);
  }
}
