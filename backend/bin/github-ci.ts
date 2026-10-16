import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config';
import { GitHubCiStack } from '../lib/github-ci-stack';

// Separate CDK app for the GitHub Actions deploy role (one per account/region):
//   npm run deploy:github-ci -w backend
// Override the repository or branch with -c githubRepository=owner/name -c githubBranch=main.
const app = new App();
const config = loadConfig(app);

new GitHubCiStack(app, 'BioMajesty-GitHubCi', {
  env: { account: config.account, region: config.region },
  description: 'GitHub Actions OIDC deploy role for the Prodia exec dashboard',
  repository: String(app.node.tryGetContext('githubRepository') ?? 'dreonic/bio-majesty'),
  branch: String(app.node.tryGetContext('githubBranch') ?? 'main'),
});

Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
