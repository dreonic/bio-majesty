import { Aws, Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import type { AppConfig } from '../config';

export interface AuthProps {
  config: AppConfig;
  /** Origins allowed as OAuth redirect targets (dashboard URL, plus localhost in dev). */
  origins: string[];
}

/**
 * Cognito user pool for the exec (and any colleagues you invite). No public
 * sign-up: create users with `aws cognito-idp admin-create-user` (see README).
 */
export class AuthConstruct extends Construct {
  readonly userPool: cognito.UserPool;
  readonly client: cognito.UserPoolClient;
  readonly domain: cognito.UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthProps) {
    super(scope, id);
    const { config, origins } = props;

    this.userPool = new cognito.UserPool(this, 'Users', {
      userPoolName: `bio-majesty-${config.stage}`,
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
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      idTokenValidity: Duration.hours(1),
      accessTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: { domainPrefix: `bio-majesty-${config.stage}-${Aws.ACCOUNT_ID}` },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Managed login needs a branding style; use Cognito's default look.
    new cognito.CfnManagedLoginBranding(this, 'Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
  }

  /** Hosted login base URL, e.g. https://<prefix>.auth.<region>.amazoncognito.com */
  get domainUrl(): string {
    return this.domain.baseUrl();
  }
}
