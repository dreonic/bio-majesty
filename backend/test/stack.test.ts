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

  it('creates the dashboard access group and no Google login by default', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'dashboard-users' });
    template.resourceCountIs('AWS::Cognito::UserPoolIdentityProvider', 0);
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', { SupportedIdentityProviders: ['COGNITO'] });
  });

  it('adds Sign in with Google when googleClientId is set', () => {
    const t = synth({ googleClientId: '1234-abc.apps.googleusercontent.com' });
    t.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderName: 'Google',
      ProviderType: 'Google',
      ProviderDetails: Match.objectLike({
        client_id: '1234-abc.apps.googleusercontent.com',
        client_secret: '{{resolve:ssm:/news-accumulator/test/google-client-secret}}',
        authorize_scopes: 'openid email profile',
      }),
      AttributeMapping: { email: 'email', email_verified: 'email_verified', name: 'name' },
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { SupportedIdentityProviders: ['COGNITO', 'Google'] });
    expect(() => loadConfig(new App({ context: { googleClientId: 'not-a-client-id' } }))).toThrow(/Invalid googleClientId/);
  }, 60_000);

  it('reads the API keys from the SSM parameter, with no Secrets Manager secret', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    const fns = Object.values(template.findResources('AWS::Lambda::Function'));
    const withKeys = fns.filter((f) => f.Properties.Environment?.Variables?.API_KEYS_PARAMETER === '/news-accumulator/test/api-keys');
    expect(withKeys.length).toBeGreaterThan(5);
    const grants = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p.Properties.PolicyDocument).includes(':parameter/news-accumulator/test/api-keys'),
    );
    expect(grants.length).toBeGreaterThan(5);
  });

  it('protects every non-preflight API method with the Cognito authorizer', () => {
    const methods = template.findResources('AWS::ApiGateway::Method');
    const unprotected = Object.values(methods).filter(
      (m) => m.Properties.HttpMethod !== 'OPTIONS' && m.Properties.AuthorizationType !== 'COGNITO_USER_POOLS',
    );
    expect(Object.keys(methods).length).toBeGreaterThan(20);
    expect(unprotected).toEqual([]);
  });

  it('compresses API responses of 1 KB or more', () => {
    template.hasResourceProperties('AWS::ApiGateway::RestApi', { MinimumCompressionSize: 1024 });
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

  it("feeds only the accounts' article items to the indexer", () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FilterCriteria: {
        Filters: [{ Pattern: JSON.stringify({ dynamodb: { Keys: { PK: { S: [{ prefix: 'USER#' }] }, SK: { S: [{ prefix: 'ART#' }] } } } }) }],
      },
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

  it("checks every 15 minutes on the exec's clock for due daily runs and market data", () => {
    expect(schedules(template)).toEqual({
      'news-accumulator-test-news-dispatch': { expression: 'cron(0/15 * * * ? *)', timeZone: 'Asia/Singapore' },
      'news-accumulator-test-stock-refresh': { expression: 'cron(0/15 * * * ? *)', timeZone: 'Asia/Singapore' },
    });
    expect(schedules(synth({ timeZone: 'Asia/Tokyo' }))['news-accumulator-test-news-dispatch']?.timeZone).toBe('Asia/Tokyo');
  }, 60_000);

  it('tells every function that starts a state machine which one it is', () => {
    const functions = Object.entries(template.findResources('AWS::Lambda::Function'));
    const env = (name: string) => functions.find(([id]) => id.startsWith(name))?.[1].Properties.Environment?.Variables ?? {};
    for (const [name, variable, machine] of [
      ['NewsDispatch', 'DAILY_STATE_MACHINE_ARN', 'Daily'],
      ['ApiSettings', 'DAILY_STATE_MACHINE_ARN', 'Daily'],
      ['ApiCategories', 'BACKFILL_STATE_MACHINE_ARN', 'Backfill'],
    ]) {
      expect(JSON.stringify(env(name!)[variable!] ?? 'missing'), `${name} ${variable}`).toContain(machine);
    }
  });

  const withAction = (action: string) =>
    Object.values(template.findResources('AWS::IAM::Policy'))
      .filter((p) => JSON.stringify(p.Properties.PolicyDocument).includes(`"${action}"`))
      .map((p) => (p.Properties.PolicyName as string).replace(/[A-F0-9]{8}$/, ''))
      .sort();

  it('lets only the background jobs and the admin API list the accounts (the dashboard-users group)', () => {
    expect(withAction('cognito-idp:ListUsersInGroup')).toEqual([
      'ApiAdminServiceRoleDefaultPolicy',
      'NewsDispatchServiceRoleDefaultPolicy',
      'StockIngestServiceRoleDefaultPolicy',
    ]);
  });

  it('lets only the admin API manage users, and only the account-delete worker delete them', () => {
    for (const action of ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminDisableUser']) {
      expect(withAction(action), action).toEqual(['ApiAdminServiceRoleDefaultPolicy']);
    }
    expect(withAction('cognito-idp:AdminDeleteUser')).toEqual(['AccountDeleteServiceRoleDefaultPolicy']);
    template.hasResourceProperties('AWS::Cognito::UserPoolGroup', { GroupName: 'admins' });
  });

  it('passes the time zone to the functions', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ TIME_ZONE: 'Asia/Singapore' }) },
    });
  });

  it('pins the AWS account from cdk.json and rejects a malformed one', () => {
    expect(loadConfig(new App({ context: { account: '297580066575' } })).account).toBe('297580066575');
    expect(() => loadConfig(new App({ context: { account: 'acme' } }))).toThrow(/Invalid account/);
  });

  it("reads a stage's settings from its stages block, under top-level keys and -c flags", () => {
    const stages = {
      dev: { stackName: 'BioMajesty-dev', resourcePrefix: 'bio-majesty', alarmEmail: 'dev@example.com' },
      prod: { stackName: 'news-accumulator', resourcePrefix: 'news-accumulator' },
    };
    const dev = loadConfig(new App({ context: { stage: 'dev', stages } }));
    expect([dev.stackName, dev.resourcePrefix, dev.alarmEmail, dev.retainData]).toEqual(['BioMajesty-dev', 'bio-majesty', 'dev@example.com', false]);
    const prod = loadConfig(new App({ context: { stage: 'prod', stages } }));
    expect([prod.stackName, prod.resourcePrefix, prod.alarmEmail, prod.retainData, prod.localDevOrigin]).toEqual([
      'news-accumulator',
      'news-accumulator',
      null,
      true,
      null,
    ]);
    expect(loadConfig(new App({ context: { stage: 'prod', stages, alarmEmail: 'ops@example.com' } })).alarmEmail).toBe('ops@example.com');
    expect(loadConfig(new App({ context: { stage: 'qa' } })).stackName).toBe('news-accumulator-qa');
  });

  it('serves the dashboard and the login page on custom domains', () => {
    const certificateArn = 'arn:aws:acm:us-east-1:123456789012:certificate/0f1e2d3c-aaaa-bbbb-cccc-123456789abc';
    const t = synth({ domainName: 'news.example.com', authDomainName: 'login.news.example.com', certificateArn });
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: ['news.example.com'], ViewerCertificate: Match.objectLike({ AcmCertificateArn: certificateArn }) }),
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'login.news.example.com',
      CustomDomainConfig: { CertificateArn: certificateArn },
      ManagedLoginVersion: 2,
    });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: ['https://news.example.com/auth/callback', 'http://localhost:5173/auth/callback'],
    });
    // The dashboard sends people to the custom login domain, not the prefix one.
    expect(JSON.stringify(t.findOutputs('CognitoDomain'))).toMatch(/"AuthUsersCustomDomain[0-9A-F]{8}"/);
    t.hasOutput('DashboardDnsTarget', {});
    t.hasOutput('LoginDnsTarget', {});
    expect(Object.keys(template.findOutputs('*'))).not.toContain('LoginDnsTarget');
  }, 60_000);

  it('offers only Google sign-in when password sign-in is off', () => {
    const googleClientId = '1234-abc.apps.googleusercontent.com';
    const t = synth({ googleClientId, passwordSignIn: 'false' });
    t.hasResourceProperties('AWS::Cognito::UserPoolClient', { SupportedIdentityProviders: ['Google'] });
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ PASSWORD_SIGN_IN: 'false' }) } });
    expect(() => loadConfig(new App({ context: { passwordSignIn: false } }))).toThrow(/needs googleClientId/);
    expect(loadConfig(new App({ context: { googleClientId, passwordSignIn: false } })).passwordSignIn).toBe(false);
  }, 60_000);

  it('rejects custom domains without a us-east-1 certificate', () => {
    expect(() => loadConfig(new App({ context: { domainName: 'news.example.com' } }))).toThrow(/need certificateArn/);
    const elsewhere = 'arn:aws:acm:ap-southeast-1:123456789012:certificate/0f1e2d3c-aaaa-bbbb-cccc-123456789abc';
    expect(() => loadConfig(new App({ context: { domainName: 'news.example.com', certificateArn: elsewhere } }))).toThrow(/us-east-1/);
    expect(() => loadConfig(new App({ context: { authDomainName: 'https://login.example.com' } }))).toThrow(/Invalid domain name/);
  });

  it('rejects an invalid time zone', () => {
    expect(() => loadConfig(new App({ context: { timeZone: 'Mars/Olympus_Mons' } }))).toThrow(/Invalid timeZone/);
  });

  it('defines daily and backfill state machines', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
  });
});

/** Schedule name -> expression and time zone, for all EventBridge schedules in the template. */
function schedules(t: Template): Record<string, { expression: string; timeZone: string }> {
  return Object.fromEntries(
    Object.values(t.findResources('AWS::Scheduler::Schedule')).map((s) => [
      s.Properties.Name,
      { expression: s.Properties.ScheduleExpression, timeZone: s.Properties.ScheduleExpressionTimezone },
    ]),
  );
}
