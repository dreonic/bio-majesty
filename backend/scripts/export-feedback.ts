/**
 * Export one account's review decisions (training data) as JSONL.
 *
 * Usage (reads the deployed table; needs AWS credentials). The account is its Cognito
 * user's `sub` (User ID in the Cognito console):
 *   TABLE_NAME=<stack table> AWS_REGION=ap-southeast-1 npm run export:feedback -w backend -- --sub <sub> > feedback.jsonl
 *   ... -- --sub <sub> --corrections   (only decisions where the reviewer changed something)
 */
import { listFeedback } from '../src/repo/feedback';

const args = process.argv.slice(2);
const sub = args.includes('--sub') ? args[args.indexOf('--sub') + 1] : undefined;
if (!sub) {
  console.error('Usage: npm run export:feedback -w backend -- --sub <sub> [--corrections]');
  process.exit(1);
}
const onlyCorrections = args.includes('--corrections');
const items = await listFeedback(sub, { limit: 1_000_000, onlyCorrections });
for (const item of items) process.stdout.write(`${JSON.stringify(item)}\n`);
console.error(`Exported ${items.length} decision(s)${onlyCorrections ? ' with corrections' : ''}.`);
