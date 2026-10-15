import { Logger } from '@aws-lambda-powertools/logger';

export const logger = new Logger({
  serviceName: 'bio-majesty',
  logLevel: (process.env.LOG_LEVEL as 'INFO' | 'DEBUG' | 'WARN' | 'ERROR' | 'SILENT' | undefined) ?? 'INFO',
});

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
