import { useEffect, useRef, useState } from 'react';
import App from './App';
import type { PersistenceBoot } from '../lib/storage/db/bootstrap';
import type { SharedBoot } from './shared-sync';
import type { Identity } from '../../shared/protocol';
import type { Language } from '../types';
import { detectServer, fetchServerWorkspace, websocketUrl, type ServerWorkspace } from '../lib/sync/serverMode';
import { readLink, readMirror } from '../lib/sync/device';
import {
  REPLACE_CONFIRMATION,
  firstStateFor,
  needsLocalBackup,
  planLink,
  validateLinkChoice,
  type LinkChoice,
  type LinkPlan,
} from '../lib/sync/link';
import { emptySharedState, starterWorkspace } from '../lib/sync/starter';
import type { WorkspaceCounts } from '../lib/sync/records';
import { createBackupPayload } from '../lib/backup/backup';
import { downloadTextFile } from '../lib/export/download';
import { t } from '../i18n';

/** History retention shown to the user (the server's default, see wrangler.jsonc). */
const HISTORY_DAYS = 30;

type Phase =
  | { kind: 'detecting' }
  | { kind: 'ready'; boot: PersistenceBoot; shared: SharedBoot | null }
  | { kind: 'link'; identity: Identity; plan: LinkPlan; server: ServerWorkspace }
  | { kind: 'problem'; problem: 'unreachable' | 'login' | 'error' | 'export'; status?: number };

/**
 * Decides, before the app renders, whether it runs local-only (no shared
 * backend here — exactly the previous behaviour) or against the shared
 * workspace, and walks a first-time device through linking.
 *
 *  - A device that is already linked starts straight from its own saved copy
 *    (offline-first) and syncs in the background.
 *  - A new device is NEVER silently merged or overwritten: see planLink().
 */
export function Startup({ boot }: { boot: PersistenceBoot }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'detecting' });
  const lang = boot.workspace.app.language;
  const started = useRef(false);

  const detect = async (): Promise<void> => {
    setPhase({ kind: 'detecting' });
    const detection = await detectServer();
    const origin = window.location.origin;
    const link = readLink(origin);
    const mirror = readMirror();
    const wsUrl = websocketUrl(window.location);
    const resume = (identity: Identity): Phase => ({
      kind: 'ready',
      boot,
      shared: { identity, wsUrl, origin, firstState: 'apply', resume: mirror },
    });

    switch (detection.mode) {
      case 'local':
        setPhase({ kind: 'ready', boot, shared: null });
        return;
      case 'server': {
        if (link !== null && mirror !== null) {
          setPhase(resume(detection.identity)); // linked device: start from its own copy
          return;
        }
        const server = await fetchServerWorkspace();
        if (server === null) {
          setPhase({ kind: 'problem', problem: 'export' });
          return;
        }
        const plan = planLink({ local: boot.workspace.reports, serverRecords: server.records, role: detection.identity.role });
        if (plan.kind === 'adopt') {
          // Nothing of value on this device: take the shared workspace without asking.
          setPhase(execute(boot, detection.identity, 'use-shared', origin, wsUrl).phase);
          return;
        }
        setPhase({ kind: 'link', identity: detection.identity, plan, server });
        return;
      }
      case 'unreachable':
      case 'login-required':
        // A linked device keeps working from its own copy; the sync client
        // reports "offline" or "sign-in expired" and recovers on its own.
        if (link !== null && mirror !== null) {
          setPhase(resume({ email: link.email, role: 'editor' }));
          return;
        }
        setPhase({ kind: 'problem', problem: detection.mode === 'unreachable' ? 'unreachable' : 'login' });
        return;
      case 'error':
        setPhase({ kind: 'problem', problem: 'error', status: detection.status });
        return;
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (phase.kind === 'ready') return <App boot={phase.boot} shared={phase.shared} />;

  return (
    <main className="link-screen">
      <div className="link-card">
        {phase.kind === 'detecting' ? (
          <p role="status">{t(lang, 'shared.link.checking')}</p>
        ) : phase.kind === 'problem' ? (
          <ProblemView lang={lang} problem={phase.problem} status={phase.status} onRetry={() => void detect()} onLocal={() => setPhase({ kind: 'ready', boot, shared: null })} />
        ) : (
          <LinkView
            lang={lang}
            boot={boot}
            identity={phase.identity}
            plan={phase.plan}
            server={phase.server}
            onChosen={(next) => setPhase(next)}
            onLocal={() => setPhase({ kind: 'ready', boot, shared: null })}
          />
        )}
      </div>
    </main>
  );
}

/** Execute a validated choice: returns the workspace the app starts with and how the client must treat the first server state. */
function execute(boot: PersistenceBoot, identity: Identity, choice: LinkChoice, origin: string, wsUrl: string): { phase: Phase; backedUp: boolean } {
  const { app, reports } = boot.workspace;
  let backedUp = false;
  if (needsLocalBackup(choice, reports)) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '');
    downloadTextFile(`ganttchart-before-sharing-${stamp}.json`, 'application/json', JSON.stringify(createBackupPayload(app, reports), null, 2));
    backedUp = true;
  }
  let workspace = { app, reports };
  if (choice === 'use-shared') workspace = { app, reports: emptySharedState(reports) };
  else if (choice === 'create' || choice === 'start-fresh') workspace = starterWorkspace(app.language, reports, new Date().toISOString());
  return {
    backedUp,
    phase: {
      kind: 'ready',
      boot: { ...boot, workspace },
      shared: { identity, wsUrl, origin, firstState: firstStateFor(choice), resume: null },
    },
  };
}

function countsLine(lang: Language, c: WorkspaceCounts): string {
  return t(lang, 'shared.link.counts', { projects: c.projects, reports: c.reports, attendance: c.attendance, topics: c.topics, members: c.members });
}

function ProblemView(props: { lang: Language; problem: 'unreachable' | 'login' | 'error' | 'export'; status?: number; onRetry: () => void; onLocal: () => void }) {
  const { lang } = props;
  const [titleKey, bodyKey] =
    props.problem === 'login'
      ? (['shared.link.loginTitle', 'shared.link.loginBody'] as const)
      : props.problem === 'error'
        ? (['shared.link.errorTitle', 'shared.link.errorBody'] as const)
        : props.problem === 'export'
          ? (['shared.link.unreachableTitle', 'shared.link.failedExport'] as const)
          : (['shared.link.unreachableTitle', 'shared.link.unreachableBody'] as const);
  return (
    <>
      <h1>{t(lang, titleKey)}</h1>
      <p role="alert">{t(lang, bodyKey, { status: props.status ?? 0 })}</p>
      <div className="link-actions">
        {props.problem === 'login' ? (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t(lang, 'shared.link.reload')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={props.onRetry}>
            {t(lang, 'shared.link.retry')}
          </button>
        )}
        <button type="button" className="btn" onClick={props.onLocal}>
          {t(lang, 'shared.link.localOnly')}
        </button>
      </div>
    </>
  );
}

function LinkView(props: {
  lang: Language;
  boot: PersistenceBoot;
  identity: Identity;
  plan: LinkPlan;
  server: ServerWorkspace;
  onChosen: (phase: Phase) => void;
  onLocal: () => void;
}) {
  const { lang, identity, plan } = props;
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const origin = window.location.origin;
  const wsUrl = websocketUrl(window.location);

  const choose = (choice: LinkChoice): void => {
    const verdict = validateLinkChoice(plan, choice, identity.role, typed);
    if (!verdict.ok) {
      setMessage(t(lang, verdict.reason === 'role' ? 'shared.link.replaceAdminOnly' : 'shared.link.notAllowed'));
      return;
    }
    props.onChosen(execute(props.boot, identity, choice, origin, wsUrl).phase);
  };

  return (
    <>
      <h1>{t(lang, 'shared.link.title')}</h1>
      <p>{t(lang, 'shared.link.signedIn', { email: identity.email, role: t(lang, `shared.role.${identity.role}`) })}</p>

      {plan.kind === 'create' ? (
        <section>
          <h2>{t(lang, 'shared.link.createTitle')}</h2>
          <p>{t(lang, 'shared.link.createBody')}</p>
          <button type="button" className="btn btn-primary" onClick={() => choose('create')} disabled={identity.role === 'viewer'}>
            {t(lang, 'shared.link.createButton')}
          </button>
        </section>
      ) : null}

      {plan.kind === 'initialize' ? (
        <section>
          <h2>{t(lang, 'shared.link.initTitle')}</h2>
          <p>{t(lang, 'shared.link.initBody')}</p>
          <p className="link-counts">
            <strong>{t(lang, 'shared.link.thisBrowser')}:</strong> {countsLine(lang, plan.local)}
          </p>
          <div className="link-option">
            <button type="button" className="btn btn-primary" onClick={() => choose('initialize')} disabled={identity.role === 'viewer'}>
              {t(lang, 'shared.link.initShare')}
            </button>
            <p className="link-help">{t(lang, 'shared.link.initShareHelp')}</p>
          </div>
          <div className="link-option">
            <button type="button" className="btn" onClick={() => choose('start-fresh')} disabled={identity.role === 'viewer'}>
              {t(lang, 'shared.link.initFresh')}
            </button>
            <p className="link-help">{t(lang, 'shared.link.initFreshHelp')}</p>
          </div>
        </section>
      ) : null}

      {plan.kind === 'choose' ? (
        <section>
          <h2>{t(lang, 'shared.link.chooseTitle')}</h2>
          <p>{t(lang, 'shared.link.chooseBody')}</p>
          <p className="link-counts">
            <strong>{t(lang, 'shared.link.thisBrowser')}:</strong> {countsLine(lang, plan.local)}
          </p>
          <p className="link-counts">
            <strong>{t(lang, 'shared.link.sharedWorkspace')}:</strong> {countsLine(lang, plan.server)}
          </p>

          <div className="link-option">
            <button type="button" className="btn btn-primary" onClick={() => choose('use-shared')}>
              {t(lang, 'shared.link.useShared')}
            </button>
            <p className="link-help">{t(lang, 'shared.link.useSharedHelp')}</p>
          </div>

          <div className="link-option">
            <button type="button" className="btn" onClick={() => choose('merge')} disabled={identity.role === 'viewer'}>
              {t(lang, 'shared.link.merge')}
            </button>
            <p className="link-help">{t(lang, 'shared.link.mergeHelp')}</p>
          </div>

          <div className="link-option link-danger">
            <strong>{t(lang, 'shared.link.replace')}</strong>
            <p className="link-help">{t(lang, 'shared.link.replaceHelp', { days: HISTORY_DAYS })}</p>
            {plan.canReplace ? (
              <>
                <label className="link-confirm">
                  {t(lang, 'shared.link.replaceConfirmLabel', { word: REPLACE_CONFIRMATION })}
                  <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
                <button type="button" className="btn btn-danger" disabled={typed !== REPLACE_CONFIRMATION} onClick={() => choose('replace-shared')}>
                  {t(lang, 'shared.link.replaceButton')}
                </button>
              </>
            ) : (
              <p className="link-help">{t(lang, 'shared.link.replaceAdminOnly')}</p>
            )}
          </div>
        </section>
      ) : null}

      {message === null ? null : (
        <p role="alert" className="link-error">
          {message}
        </p>
      )}
      <div className="link-actions">
        <button type="button" className="btn btn-ghost" onClick={props.onLocal}>
          {t(lang, 'shared.link.localOnly')}
        </button>
      </div>
    </>
  );
}
