// Lists the licenses of the PRODUCTION dependencies (what ships in the browser bundle) of the root package and of the Worker.
// Read-only: it inspects node_modules, installs nothing and calls no network. Run: npm run licenses
// Output: one line per package ("name@version  license"), then a short list of anything that needs a human / legal look
// (copyleft families, unknown or missing licenses, attribution-heavy licenses). It makes no legal conclusion.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REVIEW = [
  { pattern: /GPL|AGPL|LGPL|MPL|EPL|CDDL|SSPL|OSL|EUPL/i, why: 'copyleft family' },
  { pattern: /UNLICENSED|UNKNOWN|^$/i, why: 'no license declared' },
  { pattern: /CC-BY|BSD-4|OFL|Apache/i, why: 'attribution / notice requirements' },
];

function collect(dir) {
  const raw = execSync('npm ls --omit=dev --all --json --long', { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  const tree = JSON.parse(raw);
  const out = new Map();
  const walk = (deps) => {
    for (const [name, info] of Object.entries(deps ?? {})) {
      if (info.extraneous) continue; // present in node_modules but not required by the package: not shipped
      const key = `${name}@${info.version}`;
      if (!out.has(key)) {
        let license = typeof info.license === 'string' ? info.license : info.license?.type ?? '';
        if (license === '' && info.path) {
          try {
            const pkg = JSON.parse(readFileSync(join(info.path, 'package.json'), 'utf8'));
            license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? '';
          } catch {
            /* unreadable: stays empty and is flagged */
          }
        }
        out.set(key, license);
      }
      walk(info.dependencies);
    }
  };
  walk(tree.dependencies);
  return out;
}

let flagged = 0;
for (const [label, dir] of [['root (browser bundle)', '.'], ['worker', 'worker']]) {
  const rows = collect(dir);
  console.log(`# ${label}: ${rows.size} production packages`);
  for (const [pkg, license] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
    const why = REVIEW.filter((r) => r.pattern.test(license)).map((r) => r.why);
    if (why.length > 0) flagged += 1;
    console.log(`${pkg}  ${license === '' ? '(none)' : license}${why.length > 0 ? `   <-- review: ${why.join(', ')}` : ''}`);
  }
}
console.log(flagged === 0 ? '\nNo production dependency needs special review under these rules.' : `\n${flagged} package(s) flagged for human / legal review (not a legal conclusion).`);
