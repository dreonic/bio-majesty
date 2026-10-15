import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../lib/config';
import { DashboardStack } from '../lib/dashboard-stack';

function synth(context: Record<string, unknown> = {}): Template {
  // Skip esbuild bundling: these tests only inspect the CloudFormation template.
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [], stage: 'test', region: 'ap-southeast-1', ...context } });
  const config = loadConfig(app);
  const stack = new DashboardStack(app, 'Test', { config, env: { region: config.region } });
  return Template.fromStack(stack);
}

let template: Template;

// Synthesizing the whole stack can take longer than the default 10 s hook timeout on a busy machine.
beforeAll(() => {
  template = synth();
}, 60_000);

describe('DashboardStack', () => {
  it('disables self sign-up and enables TOTP MFA', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      MfaConfiguration: 'OPTIONAL',
      EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
    });
  });

  it('protects every non-preflight API method with the Cognito authorizer', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    const unprotected = Object.values(methods).filter(
      (m) => m.Properties.HttpMethod !== 'OPTIONS' && m.Properties.AuthorizationType !== 'COGNITO_USER_POOLS',
    );
    expect(Object.keys(methods).length).toBeGreaterThan(20);
    expect(unprotected).toEqual([]);
  });

  it('streams the chat endpoint', () => {
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
      Integration: Match.objectLike({ ResponseTransferMode: 'STREAM', TimeoutInMillis: 900000 }),
    });
  });

  it('blocks public access on all buckets', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    for (const bucket of Object.values(buckets)) {
      expect(bucket.Properties.PublicAccessBlockConfiguration).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
    }
  });

  it('creates the single table with GSI1, TTL and a stream', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'GSI1' })],
    });
  });

  it('feeds only article items to the indexer', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ dynamodb: { Keys: { PK: { S: [{ prefix: 'ART#' }] } } } }) }] },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('creates the S3 Vectors index for the configured embedding model', () => {
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      Dimension: 768,
      DistanceMetric: 'cosine',
      IndexName: 'articles-gemini-embedding-2-768',
      MetadataConfiguration: { NonFilterableMetadataKeys: ['title', 'text', 'source'] },
    });
  });

  it("runs the daily news run on the exec's clock and stock refreshes on IDX (Jakarta) hours", () => {
    expect(scheduleZones(template)).toEqual({
      'cron(0 6 * * ? *)': 'Asia/Singapore',
      'cron(0/15 9-16 ? * MON-FRI *)': 'Asia/Jakarta',
      'cron(30 17 ? * MON-FRI *)': 'Asia/Jakarta',
    });
  });

  it('moves only the daily run when the time zone changes', () => {
    expect(scheduleZones(synth({ timeZone: 'Asia/Tokyo' }))).toEqual({
      'cron(0 6 * * ? *)': 'Asia/Tokyo',
      'cron(0/15 9-16 ? * MON-FRI *)': 'Asia/Jakarta',
      'cron(30 17 ? * MON-FRI *)': 'Asia/Jakarta',
    });
  });

  it('passes the time zone to the functions', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ TIME_ZONE: 'Asia/Singapore' }) },
    });
  });

  it('rejects an invalid time zone', () => {
    expect(() => loadConfig(new App({ context: { timeZone: 'Mars/Olympus_Mons' } }))).toThrow(/Invalid timeZone/);
  });

  it('defines daily and backfill state machines', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
  });
});

/** Schedule expression -> time zone, for all EventBridge schedules in the template. */
function scheduleZones(t: Template): Record<string, string> {
  const schedules = Object.values(t.findResources('AWS::Scheduler::Schedule'));
  expect(schedules).toHaveLength(3);
  return Object.fromEntries(schedules.map((s) => [s.Properties.ScheduleExpression, s.Properties.ScheduleExpressionTimezone]));
}
