import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { GitHubCiStack } from '../lib/github-ci-stack';

const template = Template.fromStack(
  new GitHubCiStack(new App(), 'Ci', {
    env: { account: '111122223333', region: 'ap-southeast-1' },
    repository: 'acme/dashboard',
    subjectPrefix: 'repo:acme@11/dashboard@22',
    branch: 'main',
  }),
);

describe('GitHubCiStack', () => {
  it('lets only workflows on the main branch of the repository assume the deploy role', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bio-majesty-github-deploy',
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRoleWithWebIdentity',
            Effect: 'Allow',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub': 'repo:acme@11/dashboard@22:ref:refs/heads/main',
              },
            },
          },
        ],
      },
    });
  });

  it('only allows assuming the CDK bootstrap roles', () => {
    const arn = (kind: string) => ({
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, `:iam::111122223333:role/cdk-hnb659fds-${kind}-role-111122223333-ap-southeast-1`]],
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: ['sts:AssumeRole', 'sts:TagSession'],
            Effect: 'Allow',
            Resource: ['deploy', 'file-publishing', 'image-publishing', 'lookup'].map(arn),
          },
        ],
      },
    });
  });
});
