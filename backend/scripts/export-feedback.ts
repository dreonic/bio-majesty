/**
 * Export one profile's review decisions (training data) as JSONL.
 *
 * Usage (reads the deployed table; needs AWS credentials). The profile is its ID (shown in
 * Settings → This profile):
 *   TABLE_NAME=<stack table> AWS_REGION=ap-southeast-1 npm run export:feedback -w backend -- --profile-id <id> > feedback.jsonl
 *   ... -- --profile-id <id> --corrections   (only decisions where the reviewer changed something)
 */
import { listFeedback } from '../src/repo/feedback';
import { asProfileId } from '../src/repo/keys';

const args = process.argv.slice(2);
const id = args.includes('--profile-id') ? args[args.indexOf('--profile-id') + 1] : undefined;
if (!id) {
  console.error('Usage: npm run export:feedback -w backend -- --profile-id <id> [--corrections]');
  process.exit(1);
}
const onlyCorrections = args.includes('--corrections');
const items = await listFeedback(asProfileId(id), { limit: 1_000_000, onlyCorrections });
for (const item of items) process.stdout.write(`${JSON.stringify(item)}\n`);
console.error(`Exported ${items.length} decision(s)${onlyCorrections ? ' with corrections' : ''}.`);
