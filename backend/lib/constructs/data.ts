import { Duration, RemovalPolicy, SecretValue, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import type { AppConfig } from '../config';

/** Placeholder keys created in the secret; fill in the ones you use after deploying. */
export const SECRET_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'EODHD_API_KEY',
] as const;

export class DataConstruct extends Construct {
  readonly table: dynamodb.TableV2;
  readonly dataBucket: s3.Bucket;
  readonly vectorBucketName: string;
  readonly vectorIndexName: string;
  readonly vectorIndexArn: string;
  readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, config: AppConfig) {
    super(scope, id);
    const removalPolicy = config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;
    const { account } = Stack.of(this);

    this.table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'expiresAt',
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: config.retainData,
      removalPolicy,
      globalSecondaryIndexes: [
        {
          indexName: 'GSI1',
          partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
        },
      ],
    });

    this.dataBucket = new s3.Bucket(this, 'DataBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy,
      autoDeleteObjects: !config.retainData,
      lifecycleRules: [
        { id: 'raw-search-results', prefix: 'raw/', expiration: Duration.days(90) },
        { id: 'run-scratch', prefix: 'runs/', expiration: Duration.days(90) },
      ],
    });

    // Vector store for the chat agent (S3 Vectors). The index is tied to the
    // embedding model + dimensions; changing either creates a new index.
    this.vectorBucketName = `bio-majesty-${config.stage}-vectors-${account}`;
    const vectorBucket = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      vectorBucketName: this.vectorBucketName,
    });
    vectorBucket.applyRemovalPolicy(removalPolicy);

    const modelSlug = config.embeddingModel.split(':')[1]!.replace(/[^a-z0-9-]/g, '-');
    this.vectorIndexName = `articles-${modelSlug}-${config.embeddingDimensions}`.slice(0, 63);
    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketName: this.vectorBucketName,
      indexName: this.vectorIndexName,
      dataType: 'float32',
      dimension: config.embeddingDimensions,
      distanceMetric: 'cosine',
      metadataConfiguration: { nonFilterableMetadataKeys: ['title', 'text', 'source'] },
    });
    index.addDependency(vectorBucket);
    index.applyRemovalPolicy(removalPolicy);
    this.vectorIndexArn = index.attrIndexArn;

    this.secret = new secretsmanager.Secret(this, 'ApiKeys', {
      description: `bio-majesty ${config.stage}: LLM provider API keys and Telegram bot token (replace REPLACE_ME values)`,
      secretObjectValue: Object.fromEntries(SECRET_KEYS.map((k) => [k, SecretValue.unsafePlainText('REPLACE_ME')])),
      removalPolicy,
    });
  }
}
