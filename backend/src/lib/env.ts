import { DEFAULT_TIME_ZONE } from '@bio-majesty/shared';

/**
 * Typed access to Lambda environment variables (set by CDK in lib/constructs).
 * Values are read lazily so modules can be imported by tests and scripts.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}

export const env = {
  get stage() {
    return optional('STAGE', 'dev');
  },
  get region() {
    return optional('AWS_REGION', optional('AWS_DEFAULT_REGION', 'ap-southeast-1'));
  },
  /** The dashboard's IANA time zone: daily-run times, "today" in chat, news date filters. */
  get timeZone() {
    return optional('TIME_ZONE', DEFAULT_TIME_ZONE);
  },
  get tableName() {
    return required('TABLE_NAME');
  },
  get dataBucket() {
    return required('DATA_BUCKET');
  },
  get vectorBucket() {
    return required('VECTOR_BUCKET');
  },
  get vectorIndex() {
    return required('VECTOR_INDEX');
  },
  /** SSM parameter (SecureString, JSON) holding provider API keys and the Telegram bot token. */
  get apiKeysParameter() {
    return optional('API_KEYS_PARAMETER');
  },
  get dashboardUrl() {
    return optional('DASHBOARD_URL', 'http://localhost:5173');
  },
  /** Comma-separated list of origins allowed to call the API (dashboard URL, plus localhost in dev). */
  get allowedOrigins() {
    return optional('ALLOWED_ORIGINS', '*')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
  },
  get dailyStateMachineArn() {
    return required('DAILY_STATE_MACHINE_ARN');
  },
  get backfillStateMachineArn() {
    return required('BACKFILL_STATE_MACHINE_ARN');
  },
  /** Cognito user pool: its `dashboard-users` group is the list of accounts. */
  get userPoolId() {
    return required('USER_POOL_ID');
  },
  get embeddingModel() {
    return optional('EMBEDDING_MODEL', 'google:gemini-embedding-2');
  },
  get embeddingDimensions() {
    return Number(optional('EMBEDDING_DIMENSIONS', '768'));
  },
  get stockIngestFunction() {
    return required('STOCK_INGEST_FUNCTION');
  },
};
