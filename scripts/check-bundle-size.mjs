// Production bundle size budget (gzip). Exits non-zero when a chunk exceeds
// its reviewed limit so CI prevents accidental bundle regressions.
// Budgets are in docs/RELEASING.md; raise one only with a reason (and say so in the release notes).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = 'dist/assets';
const KB = 1024;
const BUDGET = [
  { match: /^index-.*\.js$/, label: 'main app chunk', gzipKb: 150 },
  { match: /^state-contexts-.*\.js$/, label: 'shared application state', gzipKb: 65 },
  { match: /^locales-.*\.js$/, label: 'locale dictionaries', gzipKb: 130 },
  { match: /^vendor-.*\.js$/, label: 'vendor (React)', gzipKb: 60 },
  { match: /\.js$/, label: 'any other (lazy) chunk', gzipKb: 40 },
];

let files;
try {
  files = readdirSync(dir);
} catch {
  console.log('dist/assets not found - run `npm run build` first.');
  process.exit(0);
}
let over = 0;
for (const f of files.filter((x) => x.endsWith('.js')).sort()) {
  const kb = gzipSync(readFileSync(join(dir, f))).length / KB;
  const rule = BUDGET.find((b) => b.match.test(f));
  const flag = rule !== undefined && kb > rule.gzipKb;
  if (flag) over += 1;
  console.log(`${flag ? 'OVER ' : 'ok   '} ${f.padEnd(44)} ${kb.toFixed(1).padStart(7)} kB gzip${rule === undefined ? '' : `  (budget ${rule.gzipKb}: ${rule.label})`}`);
}
console.log(over === 0 ? '\nAll chunks are within budget.' : `\n${over} chunk(s) over budget.`);
if (over > 0) process.exitCode = 1;
