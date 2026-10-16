import { CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/** Name of the role the GitHub Actions workflow assumes (.github/workflows/ci-cd.yml). */
export const GITHUB_DEPLOY_ROLE_NAME = 'bio-majesty-github-deploy';

export interface GitHubCiStackProps extends StackProps {
  /** GitHub repository allowed to deploy, as owner/name. */
  repository: string;
  /**
   * Start of the OIDC `sub` claim GitHub issues for that repository. With immutable
   * subjects it carries the owner and repository IDs (repo:owner@123/name@456), so a
   * renamed or re-created repository can't deploy. Look it up with
   * `gh api repos/<owner>/<name>/actions/oidc/customization/sub` (sub_claim_prefix).
   */
  subjectPrefix: string;
  /** Only workflows running on this branch may deploy. */
  branch: string;
  /** CDK bootstrap qualifier of the target account/region. */
  bootstrapQualifier?: string;
}

/**
 * Lets GitHub Actions deploy without stored AWS keys: GitHub's OIDC identity
 * provider plus a role that only workflows on `branch` of `repository` can
 * assume. The role itself can only assume the CDK bootstrap roles, so a CI
 * deploy goes through CloudFormation exactly like a local `cdk deploy`.
 *
 * Deployed once per account from a developer machine (npm run deploy:github-ci -w backend),
 * separately from the dashboard stacks, since the pipeline can't create its own role.
 */
export class GitHubCiStack extends Stack {
  constructor(scope: Construct, id: string, props: GitHubCiStackProps) {
    super(scope, id, props);
    const qualifier = props.bootstrapQualifier ?? 'hnb659fds';
    const issuer = 'token.actions.githubusercontent.com';

    const provider = new iam.OidcProviderNative(this, 'GitHubOidc', {
      url: `https://${issuer}`,
      clientIds: ['sts.amazonaws.com'],
    });

    const role = new iam.Role(this, 'DeployRole', {
      roleName: GITHUB_DEPLOY_ROLE_NAME,
      description: `GitHub Actions deploys from ${props.repository}@${props.branch}`,
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(provider.oidcProviderArn, {
        StringEquals: {
          [`${issuer}:aud`]: 'sts.amazonaws.com',
          [`${issuer}:sub`]: `${props.subjectPrefix}:ref:refs/heads/${props.branch}`,
        },
      }),
    });

    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumeCdkBootstrapRoles',
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(
          (kind) => `arn:${this.partition}:iam::${this.account}:role/cdk-${qualifier}-${kind}-role-${this.account}-${this.region}`,
        ),
      }),
    );

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
