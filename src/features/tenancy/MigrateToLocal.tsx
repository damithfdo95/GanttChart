import { useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import { SWITCH_TO_LOCAL_CONFIRMATION } from '../../../shared/tenancy';
import { completeWebToLocal, prepareWebToLocal, type LocalWorkspace, type MigrationDeps, type PreparedWebToLocal } from '../../lib/tenancy/migration';
import type { Language } from '../../types';
import { countsText } from './format';

type Phase =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'prepared'; prepared: PreparedWebToLocal }
  | { kind: 'failed'; step: string; code: string; prepared: PreparedWebToLocal | null }
  | { kind: 'done' };

/**
 * Web -> Local. Step 1 downloads the whole cloud copy, validates it and saves it
 * in this browser (read back). Step 2 — only after that, and only with the typed
 * word — switches the workspace. Everyone else loses access; the cloud copy is
 * archived, never deleted.
 */
export function MigrateToLocal({ lang, current, deps, onClose }: { lang: Language; current: LocalWorkspace; deps: MigrationDeps; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [typed, setTyped] = useState('');

  const prepare = async (): Promise<void> => {
    setPhase({ kind: 'working' });
    const result = await prepareWebToLocal(current, deps);
    setPhase(result.ok ? { kind: 'prepared', prepared: result.prepared } : { kind: 'failed', step: result.step, code: result.error, prepared: null });
  };

  const complete = async (prepared: PreparedWebToLocal): Promise<void> => {
    setPhase({ kind: 'working' });
    const result = await completeWebToLocal(prepared, typed, deps);
    if (result.ok) {
      setPhase({ kind: 'done' });
      window.setTimeout(() => window.location.reload(), 1200);
    } else {
      setPhase({ kind: 'failed', step: result.step, code: result.error, prepared });
    }
  };

  const prepared = phase.kind === 'prepared' ? phase.prepared : phase.kind === 'failed' ? phase.prepared : null;

  return (
    <section className="link-option link-danger" aria-labelledby="tenancy-tolocal-title">
      <h3 id="tenancy-tolocal-title">{t(lang, 'tenancy.toLocal.title')}</h3>
      <p role="note">
        <strong>{t(lang, 'tenancy.toLocal.warning')}</strong>
      </p>
      <p>{t(lang, 'tenancy.toLocal.intro')}</p>
      {prepared === null ? null : <p role="status">{t(lang, 'tenancy.toLocal.prepared', { counts: t(lang, 'tenancy.counts', countsText(prepared.counts)) })}</p>}
      {phase.kind === 'working' ? <p role="status">{t(lang, 'tenancy.working')}</p> : null}
      {phase.kind === 'failed' ? (
        <div role="alert">
          <p>{t(lang, phase.code === 'workspace_changed' ? 'tenancy.toLocal.changed' : (`tenancy.migration.step.${phase.step}` as TranslationKey))}</p>
          <p>{t(lang, 'tenancy.migration.code', { code: phase.code })}</p>
        </div>
      ) : null}
      {phase.kind === 'done' ? <p role="status">{t(lang, 'tenancy.toLocal.done')}</p> : null}

      {prepared !== null && phase.kind !== 'done' && !(phase.kind === 'failed' && phase.code === 'workspace_changed') ? (
        <label className="link-confirm">
          {t(lang, 'tenancy.toWeb.typeToConfirm', { word: SWITCH_TO_LOCAL_CONFIRMATION })}
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      ) : null}

      <div className="dr-button-row">
        {phase.kind === 'done' ? null : (
          <>
            {prepared === null || (phase.kind === 'failed' && phase.code === 'workspace_changed') ? (
              <button type="button" className="btn btn-primary" disabled={phase.kind === 'working'} onClick={() => void prepare()}>
                {t(lang, 'tenancy.toLocal.prepare')}
              </button>
            ) : (
              <button type="button" className="btn btn-danger" disabled={phase.kind === 'working' || typed !== SWITCH_TO_LOCAL_CONFIRMATION} onClick={() => void complete(prepared)}>
                {t(lang, 'tenancy.toLocal.confirm')}
              </button>
            )}
            <button type="button" className="btn btn-ghost" disabled={phase.kind === 'working'} onClick={onClose}>
              {t(lang, 'tenancy.cancel')}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
