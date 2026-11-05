/**
 * Regenerate the sample GeM bid PDFs in this folder:
 *   cd packages/core && pnpm exec tsx test/fixtures/bids/generate.ts
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAMPLE_BID_SPECS, generateBidPdf } from '../../../src/analyse/sample-bid';

const dir = dirname(fileURLToPath(import.meta.url));
for (const spec of SAMPLE_BID_SPECS) {
  const bytes = await generateBidPdf(spec);
  await writeFile(join(dir, `${spec.key}.pdf`), bytes);
  console.log(`${spec.key}.pdf  ${bytes.length} bytes  ${spec.bidNumber}`);
}
