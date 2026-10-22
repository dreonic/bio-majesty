import { DEFAULT_TIME_ZONE, EMBEDDING_MODELS, isValidTimeZone } from '@bio-majesty/shared';
import type { App } from 'aws-cdk-lib';

/**
 * Deployment configuration, read from CDK context (cdk.json) and overridable
 * per command, e.g.:
 *
 *   npx cdk synth -c stage=prod -c region=ap-southeast-3 -c timeZone=Asia/Jakarta
 *
 * The region is the single place to change where everything is deployed; the
 * time zone is the exec's clock (daily run, displayed times, "today"). `account`
 * pins the AWS account: a command run with another account's credentials stops
 * instead of deploying there.
 */
export interface AppConfig {
  stage: string;
  region: string;
  /** IANA time zone of the exec (daily-run times, displayed times). Market data follows each asset's exchange clock. */
  timeZone: string;
  account: string | undefined;
  embeddingModel: string;
  embeddingDimensions: number;
  alarmEmail: string | null;
  customDomainName: string | null;
  customDomainCertificateArn: string | null;
  /** Google OAuth client ID: adds "Sign in with Google" (client secret in Secrets Manager, see googleClientSecretName). */
  googleClientId: string | null;
  /** Keep data (table, buckets, secret, user pool) when the stack is deleted. */
  retainData: boolean;
  /** Extra origin allowed to call the API and to receive Cognito redirects (local dev). */
  localDevOrigin: string | null;
}

function ctx(app: App, key: string): string {
  const value = app.node.tryGetContext(key);
  return value === undefined || value === null ? '' : String(value).trim();
}

export function loadConfig(app: App): AppConfig {
  const stage = ctx(app, 'stage') || 'dev';
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new Error(`Invalid stage "${stage}" (lowercase, 2-16 chars)`);

  const region = ctx(app, 'region') || process.env.CDK_DEFAULT_REGION || 'ap-southeast-1';
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) throw new Error(`Invalid region "${region}"`);

  const account = ctx(app, 'account') || process.env.CDK_DEFAULT_ACCOUNT;
  if (account && !/^\d{12}$/.test(account)) throw new Error(`Invalid account "${account}" (12 digits)`);

  const timeZone = ctx(app, 'timeZone') || DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid timeZone "${timeZone}" (expected an IANA name such as Asia/Singapore)`);

  const embeddingModel = ctx(app, 'embeddingModel') || 'google:gemini-embedding-2';
  const model = EMBEDDING_MODELS.find((m) => m.id === embeddingModel);
  if (!model) throw new Error(`Unknown embeddingModel "${embeddingModel}". Options: ${EMBEDDING_MODELS.map((m) => m.id).join(', ')}`);
  const embeddingDimensions = Number(ctx(app, 'embeddingDimensions') || model.dimensions[0]);
  if (!model.dimensions.includes(embeddingDimensions)) {
    throw new Error(`embeddingDimensions for ${embeddingModel} must be one of ${model.dimensions.join(', ')}`);
  }

  const googleClientId = ctx(app, 'googleClientId') || null;
  if (googleClientId && !googleClientId.endsWith('.apps.googleusercontent.com')) {
    throw new Error(`Invalid googleClientId "${googleClientId}" (expected ...apps.googleusercontent.com)`);
  }

  return {
    stage,
    region,
    timeZone,
    account,
    embeddingModel,
    embeddingDimensions,
    alarmEmail: ctx(app, 'alarmEmail') || null,
    customDomainName: ctx(app, 'customDomainName') || null,
    customDomainCertificateArn: ctx(app, 'customDomainCertificateArn') || null,
    googleClientId,
    retainData: stage === 'prod' || ctx(app, 'retainData') === 'true',
    localDevOrigin: stage === 'prod' ? null : ctx(app, 'localDevOrigin') || 'http://localhost:5173',
  };
}

/** Secrets Manager secret (plain string) holding the Google OAuth client secret; create it before deploying with googleClientId. */
export function googleClientSecretName(stage: string): string {
  return `bio-majesty/${stage}/google-client-secret`;
}
