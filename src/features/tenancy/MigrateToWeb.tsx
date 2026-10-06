import { useEffect, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import { REPLACE_CONFIRMATION } from '../../../shared/tenancy';
import { planLocalToWeb, runLocalToWeb, type LocalToWebPlan, type LocalWorkspace, type MigrationDeps } from '../../lib/tenancy/migration';
import type { Language } from '../../types';
import { countsText } from './format';

const HISTORY_DAYS = 30;

type Phase =
  | { kind: 'inspecting' }
  | { kind: 'problem'; text: string }
  | { kind: 'ready'; plan: LocalToWebPlan }
  | { kind: 'running'; plan: LocalToWebPlan }
  | { kind: 'failed'; plan: LocalToWebPlan; step: string; code: string }
  | { kind: 'done' };

function countsLine(lang: Language, counts: Record<string, number>): string {
  return t(lang, 'tenancy.counts', countsText(counts));
}

/**
 * Local -> Web. Shows both sides first; replaces nothing without a deliberate,
 * typed choice; the workspace only switches after the upload was read back and
 * verified. Any failure leaves the local data exactly as it was.
 */
export function MigrateToWeb({ lang, local, deps, onClose }: { lang: Language; local: LocalWorkspace; deps: MigrationDeps; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'inspecting' });
  const [replace, setReplace] = useState(false);
  const [typed, setTyped] = useState('');

  useEffect(() => {
    let cancelled = false;
    void planLocalToWeb(local, deps.api).then((result) => {
      if (cancelled) return;
      if (result.ok) setPhase({ kind: 'ready', plan: result.plan });
      else setPhase({ kind: 'problem', text: t(lang, result.error === 'server_unreachable' ? 'tenancy.toWeb.unreachable' : 'tenancy.toWeb.invalidLocal') });
    });
    return () => {
      cancelled = true;
    };
    // The plan is made once per opening of this dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = async (plan: LocalToWebPlan): Promise<void> => {
    setPhase({ kind: 'running', plan });
    const result = await runLocalToWeb(local, plan, { replace, typed }, deps);
    if (result.ok) {
      setPhase({ kind: 'done' });
      window.setTimeout(() => window.location.reload(), 1200);
    } else {
      setPhase({ kind: 'failed', plan, step: result.step, code: result.error });
    }
  };

  const plan = phase.kind === 'ready' || phase.kind === 'running' || phase.kind === 'failed' ? phase.plan : null;
  const mustConfirm = plan?.needsReplace === true;
  const canStart = plan !== null && phase.kind !== 'running' && (!mustConfirm || (replace && typed === REPLACE_CONFIRMATION));

  return (
    <section className="link-option" aria-labelledby="tenancy-toweb-title">
      <h3 id="tenancy-toweb-title">{t(lang, 'tenancy.toWeb.title')}</h3>
      <p>{t(lang, 'tenancy.toWeb.intro')}</p>
      {phase.kind === 'inspecting' ? <p role="status">{t(lang, 'tenancy.toWeb.inspecting')}</p> : null}
      {phase.kind === 'problem' ? <p role="alert">{phase.text}</p> : null}
      {plan === null ? null : (
        <>
          <p className="link-counts">
            <strong>{t(lang, 'tenancy.toWeb.local')}:</strong> {countsLine(lang, plan.local.counts)}
          </p>
          <p className="link-counts">
            <strong>{t(lang, 'tenancy.toWeb.cloud')}:</strong> {plan.server.hasData ? countsLine(lang, plan.server.counts) : t(lang, 'tenancy.toWeb.cloudEmpty')}
          </p>
          {plan.alreadyUploaded ? <p>{t(lang, 'tenancy.toWeb.alreadyUploaded')}</p> : null}
          {mustConfirm ? (
            <div className="link-option link-danger">
              <strong>{t(lang, 'tenancy.toWeb.needsReplaceTitle')}</strong>
              <p className="link-help">{t(lang, 'tenancy.toWeb.needsReplaceBody', { days: HISTORY_DAYS })}</p>
              <label>
                <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> {t(lang, 'tenancy.toWeb.replaceChoice')}
              </label>
              {replace ? (
                <label className="link-confirm">
                  {t(lang, 'tenancy.toWeb.typeToConfirm', { word: REPLACE_CONFIRMATION })}
                  <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
              ) : null}
            </div>
          ) : null}
          <p className="link-help">{t(lang, 'tenancy.toWeb.backupNote')}</p>
        </>
      )}
      {phase.kind === 'running' ? <p role="status">{t(lang, 'tenancy.working')}</p> : null}
      {phase.kind === 'failed' ? (
        <div role="alert">
          <p>{t(lang, `tenancy.migration.step.${phase.step}` as TranslationKey)}</p>
          <p>{t(lang, 'tenancy.migration.code', { code: phase.code })}</p>
          <p>{t(lang, 'tenancy.migration.failedIntact')}</p>
        </div>
      ) : null}
      {phase.kind === 'done' ? <p role="status">{t(lang, 'tenancy.toWeb.done')}</p> : null}
      <div className="dr-button-row">
        {plan === null || phase.kind === 'done' ? null : (
          <button type="button" className="btn btn-primary" disabled={!canStart} onClick={() => void start(plan)}>
            {t(lang, 'tenancy.toWeb.start')}
          </button>
        )}
        {phase.kind === 'done' ? null : (
          <button type="button" className="btn btn-ghost" disabled={phase.kind === 'running'} onClick={onClose}>
            {t(lang, 'tenancy.cancel')}
          </button>
        )}
      </div>
    </section>
  );
}
