import { ACCESS_GROUP, ADMIN_GROUP } from '@bio-majesty/shared';
import { Aws, CfnDynamicReference, CfnDynamicReferenceService, Duration, RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { googleClientSecretParameterName, type AppConfig } from '../config';

export interface AuthProps {
  config: AppConfig;
  /** Origins allowed as OAuth redirect targets (dashboard URL, plus localhost in dev). */
  origins: string[];
}

/**
 * Cognito user pool for the dashboard's users (whoever you invite). No public
 * sign-up: create users with `aws cognito-idp admin-create-user` (see README),
 * or let them sign in with Google when googleClientId is set. Either way, only
 * members of the ACCESS_GROUP group can use the dashboard (the API checks it).
 */
export class AuthConstruct extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;
  /** Login page on the stage's own domain (authDomainName), when set. */
  readonly customDomain: cognito.UserPoolDomain | undefined;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);
    const { config, origins } = props;

    this.userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `${config.resourcePrefix}-${config.stage}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      deletionProtection: config.retainData,
      removalPolicy: config.retainData ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.userPool.addGroup('DashboardUsers', {
      groupName: ACCESS_GROUP,
      description: 'People allowed to use the dashboard. Signing in alone is not enough: add each user here (Google users appear after their first sign-in).',
    });
    this.userPool.addGroup('Admins', {
      groupName: ADMIN_GROUP,
      description: 'People who manage users on the Admin page (they also need dashboard-users).',
    });

    const google = config.googleClientId
      ? new cognito.UserPoolIdentityProviderGoogle(this, 'Google', {
          userPool: this.userPool,
          clientId: config.googleClientId,
          // Read by CloudFormation when it creates or changes the identity provider ({{resolve:ssm:...}}).
          clientSecretValue: SecretValue.cfnDynamicReference(
            new CfnDynamicReference(CfnDynamicReferenceService.SSM, googleClientSecretParameterName(config)),
          ),
          scopes: ['openid', 'email', 'profile'],
          attributeMapping: {
            email: cognito.ProviderAttribute.GOOGLE_EMAIL,
            emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
            fullname: cognito.ProviderAttribute.GOOGLE_NAME,
          },
        })
      : undefined;

    this.client = this.userPool.addClient('WebClient', {
      userPoolClientName: 'dashboard',
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: origins.map((o) => `${o}/auth/callback`),
        logoutUrls: origins.map((o) => `${o}/`),
      },
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
        ...(google ? [cognito.UserPoolClientIdentityProvider.GOOGLE] : []),
      ],
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });
    if (google) this.client.node.addDependency(google);

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `${config.resourcePrefix}-${config.stage}-${Aws.ACCOUNT_ID}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // A pool can have a prefix domain and a custom domain at once; the dashboard sends people to the
    // custom one. Cognito checks that the parent domain resolves (an A record, or a CNAME to one).
    this.customDomain =
      config.authDomainName && config.certificateArn
        ? this.userPool.addDomain('CustomDomain', {
            customDomain: {
              domainName: config.authDomainName,
              certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', config.certificateArn),
            },
            managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
          })
        : undefined;

    // Managed login needs a branding style; use Cognito's default look.
    new cognito.CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
  }

  /** Hosted login base URL: https://<authDomainName>, or https://<prefix>.auth.<region>.amazoncognito.com */
  get domainUrl(): string {
    return (this.customDomain ?? this.domain).baseUrl();
  }
}
