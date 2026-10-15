import { App, Validations } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { loadConfig } from '../lib/config';
import { DashboardStack } from '../lib/dashboard-stack';

const app = new App();
const config = loadConfig(app);

new DashboardStack(app, `BioMajesty-${config.stage}`, {
  config,
  env: { account: config.account, region: config.region },
  description: `Prodia exec dashboard (${config.stage}): news curation, chat over saved news, PRDA stock panel`,
});

// cdk-nag (AWS Solutions rule pack); disable with `-c nag=false`.
if (app.node.tryGetContext('nag') !== 'false') {
  Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
}
