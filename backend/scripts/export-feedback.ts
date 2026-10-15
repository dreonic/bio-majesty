/**
 * Export the exec's review decisions (training data) as JSONL.
 *
 * Usage (reads the deployed table; needs AWS credentials):
 *   TABLE_NAME=<stack table> AWS_REGION=ap-southeast-1 npm run export:feedback -w backend > feedback.jsonl
 *   ... -- --corrections   (only decisions where the exec changed something)
 */
import { listFeedback } from '../src/repo/feedback';

const onlyCorrections = process.argv.includes('--corrections');
const items = await listFeedback({ limit: 1_000_000, onlyCorrections });
for (const item of items) process.stdout.write(`${JSON.stringify(item)}\n`);
console.error(`Exported ${items.length} decision(s)${onlyCorrections ? ' with corrections' : ''}.`);
