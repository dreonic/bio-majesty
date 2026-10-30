import type { SubjectContext } from '../src/ai/prompts';

/** A fictional subject and asset for scripts that run without AWS (new profiles start with a blank subject). */
export const SAMPLE_SUBJECT_CONTEXT: SubjectContext = {
  subject: {
    name: 'Acme Group',
    context: `A fictional company group in Indonesia, used to try the prompts. Its listed parent, PT Acme Laboratorium Tbk ("Acme", ticker ACME), runs clinical laboratories and health checks; PT Acme Digital is its digital health subsidiary.

Not related, despite the name: other businesses called Acme, and cartoon references.

News is mostly Indonesian-language with some English coverage.`,
    sentimentAsset: 'yahoo:ACME.JK',
  },
  asset: { id: 'yahoo:ACME.JK', name: 'PT Acme Laboratorium Tbk', type: 'EQUITY' },
};
