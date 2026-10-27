import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config';
import { GitHubCiStack } from '../lib/github-ci-stack';

// Separate CDK app for the GitHub Actions deploy role (one per account/region):
//   npm run deploy:github-ci -w backend
// Override with -c githubRepository=owner/name -c githubSubjectPrefix=repo:owner@id/name@id
// -c githubBranch=main (subject prefix: see GitHubCiStackProps.subjectPrefix).
const app = new App();
const config = loadConfig(app);

new GitHubCiStack(app, 'BioMajesty-GitHubCi', {
  env: { account: config.account, region: config.region },
  description: 'GitHub Actions OIDC deploy role for News Accumulator',
  repository: String(app.node.tryGetContext('githubRepository') ?? 'dreonic/bio-majesty'),
  subjectPrefix: String(app.node.tryGetContext('githubSubjectPrefix') ?? 'repo:dreonic@106462413/bio-majesty@1418969105'),
  branch: String(app.node.tryGetContext('githubBranch') ?? 'main'),
});

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
