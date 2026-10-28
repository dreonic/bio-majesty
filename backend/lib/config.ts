import { DEFAULT_TIME_ZONE, EMBEDDING_MODELS, isValidTimeZone } from '@bio-majesty/shared';
import type { App } from 'aws-cdk-lib';

/**
 * Deployment configuration, read from CDK context (cdk.json) and overridable
 * per command, e.g.:
 *
 *   npx cdk synth -c stage=prod -c region=ap-southeast-3 -c timeZone=Asia/Jakarta
 *
 * Settings that differ per stage (stack name, names, domains, Google client, alarm
 * email) live in the context's `stages.<stage>` block; a top-level key or `-c` flag
 * of the same name overrides it.
 *
 * The region is the single place to change where everything is deployed; the
 * time zone is the dashboard's clock (daily runs, displayed times, "today"). `account`
 * pins the AWS account: a command run with another account's credentials stops
 * instead of deploying there.
 */
export interface AppConfig {
  stage: string;
  /** CloudFormation stack name. */
  stackName: string;
  /** Start of the stage's resource names (user pool, SSM parameters, schedules, buckets). */
  resourcePrefix: string;
  region: string;
  /** IANA time zone of the dashboard (daily-run times, displayed times). Market data follows each asset's exchange clock. */
  timeZone: string;
  account: string | undefined;
  embeddingModel: string;
  embeddingDimensions: number;
  alarmEmail: string | null;
  /** Custom domain of the dashboard, e.g. news.example.com. */
  domainName: string | null;
  /** Custom domain of the Cognito login page, e.g. login.news.example.com. */
  authDomainName: string | null;
  /** ACM certificate in us-east-1 covering domainName and authDomainName. */
  certificateArn: string | null;
  /** Google OAuth client ID: adds "Sign in with Google" (client secret in Parameter Store, see googleClientSecretParameterName). */
  googleClientId: string | null;
  /** Email-and-password sign-in (and email invitations). Off means Google only. */
  passwordSignIn: boolean;
  /** Keep data (table, buckets, user pool) when the stack is deleted. */
  retainData: boolean;
  /** Extra origin allowed to call the API and to receive Cognito redirects (local dev). */
  localDevOrigin: string | null;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

const HOSTNAME = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function loadConfig(app: App): AppConfig {
  const stage = text(app.node.tryGetContext('stage')) || 'dev';
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new Error(`Invalid stage "${stage}" (lowercase, 2-16 chars)`);
  const stageBlock = (app.node.tryGetContext('stages') as Record<string, Record<string, unknown>> | undefined)?.[stage] ?? {};
  const setting = (key: string): string => text(app.node.tryGetContext(key)) || text(stageBlock[key]);

  const resourcePrefix = setting('resourcePrefix') || 'news-accumulator';
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(resourcePrefix)) throw new Error(`Invalid resourcePrefix "${resourcePrefix}" (lowercase, 2-24 chars)`);
  const stackName = setting('stackName') || `${resourcePrefix}-${stage}`;
  if (!/^[A-Za-z][A-Za-z0-9-]{0,127}$/.test(stackName)) throw new Error(`Invalid stackName "${stackName}"`);

  const region = setting('region') || process.env.CDK_DEFAULT_REGION || 'ap-southeast-1';
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`Invalid region "${region}"`);

  const account = setting('account') || process.env.CDK_DEFAULT_ACCOUNT;
  if (account && !/^\d{12}$/.test(account)) throw new Error(`Invalid account "${account}" (12 digits)`);

  const timeZone = setting('timeZone') || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid timeZone "${timeZone}" (expected an IANA name such as Asia/Singapore)`);

  const embeddingModel = setting('embeddingModel') || 'google:gemini-embedding-2';
  const model = EMBEDDING_MODELS.find((m) => m.id === embeddingModel);
  if (!model) throw new Error(`Unknown embeddingModel "${embeddingModel}". Options: ${EMBEDDING_MODELS.map((m) => m.id).join(', ')}`);
  const embeddingDimensions = Number(setting('embeddingDimensions') || model.dimensions[0]);
  if (!model.dimensions.includes(embeddingDimensions)) {
    throw new Error(`embeddingDimensions for ${embeddingModel} must be one of ${model.dimensions.join(', ')}`);
  }

  const googleClientId = setting('googleClientId') || null;
  if (googleClientId && !googleClientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error(`Invalid googleClientId "${googleClientId}" (expected ...apps.googleusercontent.com)`);
  }

  const passwordSignIn = setting('passwordSignIn') !== 'false';
  if (!passwordSignIn && !googleClientId) throw new Error('passwordSignIn=false needs googleClientId (Google would be the only way to sign in)');

  const domainName = setting('domainName').toLowerCase() || null;
  const authDomainName = setting('authDomainName').toLowerCase() || null;
  for (const name of [domainName, authDomainName]) {
    if (name && !HOSTNAME.test(name)) throw new Error(`Invalid domain name "${name}"`);
  }
  const certificateArn = setting('certificateArn') || null;
  if ((domainName || authDomainName) && !certificateArn) {
    throw new Error('domainName/authDomainName need certificateArn (an ACM certificate in us-east-1 covering them)');
  }
  // CloudFront and Cognito custom domains only take certificates from us-east-1.
  if (certificateArn && !/^arn:aws:acm:us-east-1:\d{12}:certificate\/[\w-]+$/.test(certificateArn)) {
    throw new Error(`Invalid certificateArn "${certificateArn}" (expected an ACM certificate in us-east-1)`);
  }

  return {
    stage,
    stackName,
    resourcePrefix,
    region,
    timeZone,
    account,
    embeddingModel,
    embeddingDimensions,
    alarmEmail: setting('alarmEmail') || null,
    domainName,
    authDomainName,
    certificateArn: domainName || authDomainName ? certificateArn : null,
    googleClientId,
    passwordSignIn,
    retainData: stage === 'prod' || setting('retainData') === 'true',
    localDevOrigin: stage === 'prod' ? null : setting('localDevOrigin') || 'http://localhost:5173',
  };
}

/**
 * SSM parameter (SecureString) holding the API keys and the Telegram bot token as JSON. Created by
 * hand: CloudFormation can't create SecureStrings.
 */
export function apiKeysParameterName(config: Pick<AppConfig, 'resourcePrefix' | 'stage'>): string {
  return `/${config.resourcePrefix}/${config.stage}/api-keys`;
}

/**
 * SSM parameter holding the Google OAuth client secret; create it before deploying with googleClientId.
 * A plain String: CloudFormation can't pass a SecureString to Cognito (and Cognito returns the secret
 * to anyone allowed to describe the identity provider anyway).
 */
export function googleClientSecretParameterName(config: Pick<AppConfig, 'resourcePrefix' | 'stage'>): string {
  return `/${config.resourcePrefix}/${config.stage}/google-client-secret`;
}
