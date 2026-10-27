import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig } from '../config';
import { REPO_ROOT } from './functions';

/** Runtime configuration consumed by the SPA (written as /config.json). */
export interface WebRuntimeConfig {
  stage: string;
  region: string;
  /** IANA time zone the dashboard shows times in (the deployment's `timeZone`). */
  timeZone: string;
  apiUrl: string;
  cognito: { authority: string; clientId: string; domain: string };
}

/** Static hosting for the React app: private S3 bucket behind CloudFront (OAC). */
export class WebConstruct extends Construct {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;
  readonly url: string;

  constructor(scope: Construct, id: string, config: AppConfig) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const customDomain =
      config.customDomainName && config.customDomainCertificateArn
        ? {
            domainNames: [config.customDomainName],
            certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', config.customDomainCertificateArn),
            minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
          }
        : {};

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `bio-majesty ${config.stage} dashboard`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      // Client-side routes (/settings, /auth/callback) fall back to index.html.
      errorResponses: [403, 404].map((httpStatus) => ({
        httpStatus,
        responseHttpStatus: 200,
        responsePagePath: '/index.html',
        ttl: Duration.seconds(0),
      })),
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      ...customDomain,
    });

    this.url = `https://${config.customDomainName ?? this.distribution.distributionDomainName}`;
  }

  /** Upload the built SPA plus a generated /config.json. */
  deploy(runtimeConfig: WebRuntimeConfig): void {
    const dist = frontendDist();
    new s3deploy.BucketDeployment(this, 'DeployAssets', {
      destinationBucket: this.bucket,
      sources: [s3deploy.Source.asset(dist, { exclude: ['index.html', 'config.json'] })],
      cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
      prune: false,
      memoryLimit: 512,
    });
    new s3deploy.BucketDeployment(this, 'DeployIndex', {
      destinationBucket: this.bucket,
      sources: [
        s3deploy.Source.asset(dist, { exclude: ['*', '!index.html'] }),
        s3deploy.Source.jsonData('config.json', runtimeConfig),
      ],
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/index.html', '/config.json'],
    });
  }
}

/** frontend/dist, or a placeholder page when the frontend has not been built yet. */
function frontendDist(): string {
  const dist = path.join(REPO_ROOT, 'frontend', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  const placeholder = path.join(os.tmpdir(), 'bio-majesty-frontend-placeholder');
  fs.mkdirSync(placeholder, { recursive: true });
  fs.writeFileSync(
    path.join(placeholder, 'index.html'),
    '<!doctype html><title>bio-majesty</title><p>Frontend not built. Run <code>npm run build</code> and redeploy.</p>',
  );
  return placeholder;
}
