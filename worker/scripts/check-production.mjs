/**
 * Pre-deployment guard (command). Run by wrangler before every `wrangler deploy` of
 * wrangler.jsonc (see "build" there) and by `npm run validate`. It changes nothing and
 * deploys nothing. Exit code 1 stops the deployment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProduction, parseJsonc } from './prodcheck.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const worker = resolve(here, '..');
const root = resolve(worker, '..');

function main() {
  let config;
  try {
    config = parseJsonc(readFileSync(resolve(worker, 'wrangler.jsonc'), 'utf8'));
  } catch (e) {
    console.error(`[guard] cannot read worker/wrangler.jsonc: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const docsPath = resolve(root, 'docs', 'DEPLOYMENT_PLAN.md');
  const docsText = existsSync(docsPath) ? readFileSync(docsPath, 'utf8') : '';
  const { errors, notes } = checkProduction(config, { distHasIndex: existsSync(resolve(root, 'dist', 'index.html')), docsText });

  if (errors.length > 0) {
    console.error('[guard] PRODUCTION SAFETY CHECK FAILED - nothing was deployed:');
    for (const e of errors) console.error(`  x ${e}`);
    return 1;
  }
  console.log('[guard] production safety check passed (nothing deployed, no account contacted).');
  for (const n of notes) console.log(`[guard] note: ${n}`);
  return 0;
}

process.exit(main());
