/**
 * Pre-deployment guard (logic). Pure functions, so every rule is unit-tested.
 *
 * It DEPLOYS NOTHING and talks to NO network or account. It reads the repository's
 * production configuration and refuses (exit code 1, via check-production.mjs) when a
 * setting that keeps production safe is missing or has drifted. It cannot see the
 * Cloudflare account, so what it cannot verify (that the two secrets exist, that the
 * Access destinations were changed) is stated as a reminder, not silently assumed.
 */

/** Must equal WORKER_ROUTES in shared/routes.ts (a unit test keeps the two identical). */
export const EXPECTED_WORKER_ROUTES = ['/api/*', '/ws', '/login'];

/** Secrets that must never appear under "vars": a deploy would overwrite a secret-like var with whatever the file says. */
export const SECRET_NAMES = ['ACCESS_AUD', 'SUPER_ADMIN_EMAILS'];

/** Variables that switch on development behaviour and must never be in the production config. */
export const DEV_ONLY_VARS = ['ENVIRONMENT', 'DEV_EMAIL', 'ALLOWED_ORIGINS'];

const DOMAIN_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/** Same rule as parseManagedDomains in shared/tenancy.ts (a unit test keeps them identical). */
export function parseDomains(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  for (const part of raw.split(',')) {
    const d = part.normalize('NFKC').trim().toLowerCase();
    if (DOMAIN_SHAPE.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** JSONC -> JSON text: removes // and /* comments and trailing commas, but never touches text inside strings. */
export function stripJsonComments(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonComments(text));
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * @param {Record<string, any>} config  the parsed top-level wrangler config
 * @param {{ distHasIndex: boolean, docsText: string }} context
 * @returns {{ errors: string[], notes: string[] }}
 */
export function checkProduction(config, context) {
  const errors = [];
  const notes = [];
  const vars = config.vars ?? {};

  // ---- Cloudflare Access: who may even reach the Worker ----
  const team = typeof vars.ACCESS_TEAM_DOMAIN === 'string' ? vars.ACCESS_TEAM_DOMAIN : '';
  let teamOk = false;
  try {
    const u = new URL(team);
    teamOk = u.protocol === 'https:' && u.hostname.endsWith('.cloudflareaccess.com') && (u.pathname === '/' || u.pathname === '') && u.search === '' && !team.endsWith('/');
  } catch {
    teamOk = false;
  }
  if (!teamOk) errors.push('vars.ACCESS_TEAM_DOMAIN must be an https://<team>.cloudflareaccess.com URL with no path and no trailing slash (the Worker rejects every sign-in without it).');

  // ---- the account-provisioning gate ----
  const domains = parseDomains(vars.MANAGED_USER_EMAIL_DOMAINS);
  if (domains.length === 0) errors.push('vars.MANAGED_USER_EMAIL_DOMAINS must list at least one valid organisation domain (e.g. "rakuten.com"); empty means nobody can be provisioned.');
  else {
    const entries = String(vars.MANAGED_USER_EMAIL_DOMAINS).split(',').filter((s) => s.trim() !== '');
    if (entries.length !== domains.length) errors.push('vars.MANAGED_USER_EMAIL_DOMAINS contains entries that are not plain domain names (wildcards, paths, duplicates or typos are ignored by the Worker).');
  }

  // ---- secrets must stay secrets ----
  for (const name of SECRET_NAMES) {
    if (Object.prototype.hasOwnProperty.call(vars, name)) errors.push(`vars.${name} must NOT be in the config: it is a Worker secret, and a plain deploy would overwrite it with the file's value.`);
  }
  const required = Array.isArray(config.secrets?.required) ? config.secrets.required : [];
  for (const name of SECRET_NAMES) {
    if (!required.includes(name)) errors.push(`secrets.required must list ${name} so a deployment without it is refused.`);
  }
  for (const name of DEV_ONLY_VARS) {
    if (Object.prototype.hasOwnProperty.call(vars, name)) errors.push(`vars.${name} is development-only and must not be in the production config.`);
  }

  // ---- bindings ----
  const bindings = config.durable_objects?.bindings ?? [];
  const bound = (name, cls) => bindings.some((b) => b.name === name && b.class_name === cls);
  if (!bound('WORKSPACE', 'WorkspaceRoom')) errors.push('durable_objects.bindings must bind WORKSPACE to WorkspaceRoom.');
  if (!bound('REGISTRY', 'RegistryRoom')) errors.push('durable_objects.bindings must bind REGISTRY to RegistryRoom.');
  if (config.assets?.binding !== 'ASSETS') errors.push('assets.binding must be ASSETS.');

  // ---- Durable Object migrations: only ever append; never destructive ----
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  const created = (tag, cls) => migrations.some((m) => m.tag === tag && Array.isArray(m.new_sqlite_classes) && m.new_sqlite_classes.includes(cls));
  if (!created('v1', 'WorkspaceRoom')) errors.push('migrations: v1 must create WorkspaceRoom (SQLite).');
  if (!created('v2', 'RegistryRoom')) errors.push('migrations: v2 must create RegistryRoom (SQLite).');
  for (const m of migrations) {
    for (const key of ['deleted_classes', 'renamed_classes', 'transferred_classes']) {
      if (Array.isArray(m[key]) && m[key].length > 0) errors.push(`migrations: ${m.tag} uses ${key}, which can destroy or move production data. Review it manually and remove it from this guard only deliberately.`);
    }
  }

  // ---- public vs authenticated routes ----
  const first = config.assets?.run_worker_first;
  if (!Array.isArray(first) || !sameSet(first, EXPECTED_WORKER_ROUTES)) {
    errors.push(`assets.run_worker_first must be exactly ${JSON.stringify(EXPECTED_WORKER_ROUTES)} (the Worker-handled, Access-protected routes).`);
  }
  if (config.assets?.not_found_handling !== 'single-page-application') errors.push('assets.not_found_handling must be "single-page-application" (the public sign-in page is the SPA).');
  if (config.preview_urls !== false) errors.push('preview_urls must be false: a preview hostname is a second hostname Access does not protect.');
  if (config.workers_dev !== true) errors.push('workers_dev must be true (the workers.dev hostname is the application URL).');
  if (config.account_id !== undefined || config.routes !== undefined || config.route !== undefined) errors.push('account_id / routes must not be committed (a custom domain is out of scope).');

  // ---- the built SPA ----
  if (!context.distHasIndex) errors.push('The production SPA is missing: run `npm run build` in the repository root first (../dist/index.html).');

  // ---- observability ----
  const sampling = config.observability?.head_sampling_rate;
  if (config.observability?.enabled !== true) errors.push('observability.enabled must be true (security events are logged).');
  if (typeof sampling !== 'number' || !(sampling > 0 && sampling <= 1)) errors.push('observability.head_sampling_rate must be a number in (0, 1].');

  // ---- documentation of the expectations ----
  for (const needle of [...SECRET_NAMES, 'MANAGED_USER_EMAIL_DOMAINS', '/login', '/api', '/ws']) {
    if (!context.docsText.includes(needle)) errors.push(`docs/DEPLOYMENT_PLAN.md must document ${needle}.`);
  }

  // What this guard cannot see.
  notes.push('Not verifiable from here: the secrets ACCESS_AUD and SUPER_ADMIN_EMAILS exist on the Worker; the Access destinations are /login, /api and /ws (docs/DEPLOYMENT_PLAN.md).');
  return { errors, notes };
}
