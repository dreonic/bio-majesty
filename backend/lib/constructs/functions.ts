import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import type { Construct } from 'constructs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACKEND_ROOT = path.resolve(here, '../..');
export const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

export interface FunctionOptions {
  /** Path relative to backend/src/handlers. */
  entry: string;
  handler?: string;
  description: string;
  timeout?: Duration;
  memorySize?: number;
  environment?: Record<string, string>;
}

/** ESM shims so bundled CommonJS dependencies can still use require/__dirname. */
const ESM_BANNER = [
  "import { createRequire as __bmCreateRequire } from 'node:module';",
  "import { fileURLToPath as __bmFileURLToPath } from 'node:url';",
  "import { dirname as __bmDirname } from 'node:path';",
  'const require = __bmCreateRequire(import.meta.url);',
  'const __filename = __bmFileURLToPath(import.meta.url);',
  'const __dirname = __bmDirname(__filename);',
].join(' ');

/** Creates Lambda functions with shared runtime, bundling and environment settings. */
export class FunctionFactory {
  constructor(
    private readonly scope: Construct,
    private readonly baseEnvironment: Record<string, string>,
  ) {}

  create(id: string, opts: FunctionOptions): NodejsFunction {
    const logGroup = new logs.LogGroup(this.scope, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    return new NodejsFunction(this.scope, id, {
      entry: path.join(BACKEND_ROOT, 'src', 'handlers', opts.entry),
      handler: opts.handler ?? 'handler',
      description: opts.description,
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: opts.memorySize ?? 512,
      timeout: opts.timeout ?? Duration.seconds(30),
      logGroup,
      environment: {
        ...this.baseEnvironment,
        ...opts.environment,
        NODE_OPTIONS: '--enable-source-maps',
      },
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
      bundling: {
        format: OutputFormat.ESM,
        target: 'node24',
        minify: true,
        sourceMap: true,
        sourcesContent: false,
        mainFields: ['module', 'main'],
        // Bundle the AWS SDK too, so S3 Vectors and other newer clients are pinned.
        externalModules: [],
        banner: ESM_BANNER,
        tsconfig: path.join(BACKEND_ROOT, 'tsconfig.json'),
      },
    });
  }
}
