import { CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { AppConfig } from './config';
import { ApiConstruct } from './constructs/api';
import { AuthConstruct } from './constructs/auth';
import { DataConstruct } from './constructs/data';
import { FunctionFactory } from './constructs/functions';
import { MonitoringConstruct } from './constructs/monitoring';
import { PipelineConstruct } from './constructs/pipeline';
import { WebConstruct } from './constructs/web';
import { applyNagSuppressions } from './nag';

export interface DashboardStackProps extends StackProps {
  config: AppConfig;
}

/** Everything for one stage (dev/prod) in a single stack. */
export class DashboardStack extends Stack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id, props);
    const { config } = props;
    Tags.of(this).add('project', config.resourcePrefix);
    Tags.of(this).add('stage', config.stage);

    const data = new DataConstruct(this, 'Data', config);
    const web = new WebConstruct(this, 'Web', config);
    const origins = [web.url, ...(config.localDevOrigin ? [config.localDevOrigin] : [])];
    const auth = new AuthConstruct(this, 'Auth', { config, origins });

    const functions = new FunctionFactory(this, {
      STAGE: config.stage,
      // The dashboard's time zone (Lambda reserves TZ; code passes zones explicitly).
      TIME_ZONE: config.timeZone,
      TABLE_NAME: data.table.tableName,
      DATA_BUCKET: data.dataBucket.bucketName,
      VECTOR_BUCKET: data.vectorBucketName,
      VECTOR_INDEX: data.vectorIndexName,
      API_KEYS_PARAMETER: data.apiKeys.parameterName,
      DASHBOARD_URL: web.url,
      ALLOWED_ORIGINS: origins.join(','),
      EMBEDDING_MODEL: config.embeddingModel,
      EMBEDDING_DIMENSIONS: String(config.embeddingDimensions),
      // Its dashboard-users group is the list of accounts (read by the stock refresh and scheduled runs).
      USER_POOL_ID: auth.userPool.userPoolId,
      LOG_LEVEL: 'INFO',
    });

    const pipeline = new PipelineConstruct(this, 'Pipeline', { config, data, functions, userPool: auth.userPool });
    const api = new ApiConstruct(this, 'Api', {
      config,
      data,
      pipeline,
      functions,
      userPool: auth.userPool,
      allowedOrigins: origins,
    });

    web.deploy({
      stage: config.stage,
      region: this.region,
      timeZone: config.timeZone,
      apiUrl: api.url,
      cognito: {
        authority: `https://cognito-idp.${this.region}.amazonaws.com/${auth.userPool.userPoolId}`,
        clientId: auth.client.userPoolClientId,
        domain: auth.domainUrl,
        ...(config.passwordSignIn ? {} : { identityProvider: 'Google' }),
      },
    });

    const monitoring = new MonitoringConstruct(this, 'Monitoring', {
      config,
      stateMachines: [pipeline.dailyMachine, pipeline.backfillMachine],
      dailyScheduleGroup: pipeline.dailyScheduleGroup.scheduleGroupName,
      stockIngest: pipeline.stockIngestFn,
      indexer: pipeline.indexerFn,
      apiFunctions: api.functions,
    });

    new CfnOutput(this, 'DashboardUrl', { value: web.url });
    new CfnOutput(this, 'ApiUrl', { value: api.url });
    new CfnOutput(this, 'UserPoolId', { value: auth.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: auth.client.userPoolClientId });
    new CfnOutput(this, 'CognitoDomain', { value: auth.domainUrl });
    if (config.domainName) {
      new CfnOutput(this, 'DashboardDnsTarget', {
        value: web.distribution.distributionDomainName,
        description: `Point ${config.domainName} here (CNAME, or an alias A/AAAA record)`,
      });
    }
    if (auth.customDomain) {
      new CfnOutput(this, 'LoginDnsTarget', {
        value: auth.customDomain.cloudFrontEndpoint,
        description: `Point ${config.authDomainName} here (CNAME, or an alias A/AAAA record)`,
      });
    }
    new CfnOutput(this, 'ApiKeysParameter', { value: data.apiKeys.parameterName, description: 'SSM SecureString to create with the API keys and the Telegram bot token (see README)' });
    new CfnOutput(this, 'StockIngestFunction', { value: pipeline.stockIngestFn.functionName });
    new CfnOutput(this, 'DailyStateMachineArn', { value: pipeline.dailyMachine.stateMachineArn });
    new CfnOutput(this, 'ProfilesFunction', {
      value: api.profilesFn.functionName,
      description: 'Its environment names the table, bucket and schedule group (for migration scripts)',
    });
    new CfnOutput(this, 'AlarmTopicArn', {
      value: monitoring.topic.topicArn,
      description: 'SNS topic of the alarms: subscribe addresses here (or set alarmEmail) to receive them',
    });

    applyNagSuppressions(this, {
      table: data.table,
      buckets: [data.dataBucket, web.bucket],
      invokedFunctions: [...pipeline.pipelineFunctions, pipeline.stockIngestFn, api.deleteWorkerFn],
      stateMachines: [pipeline.dailyMachine, pipeline.backfillMachine],
    });
  }
}
