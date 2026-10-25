import { useMemo, useState } from 'react';
import { useReportsStateCtx, useAppStateCtx } from '../../app/state-contexts';
import { useSharedSync } from '../../app/shared-sync';
import { useTenant } from '../../app/tenant-context';
import { NAV_ITEMS } from '../../app/navigation';
import { t, type TranslationKey } from '../../i18n';
import { BUILD_INFO, isTaggedRelease } from '../../lib/buildInfo';
import { readAutoBackupRecord } from '../../lib/backup/autoBackup';
import { copyWithFallback } from '../../lib/reporting/publication';
import { getLastClientError } from '../../lib/support/clientErrors';
import { businessStamp } from '../../../shared/businessTime';
import { FEEDBACK_CATEGORIES, buildDiagnostics, buildFeedbackReport, feedbackProblems, type FeedbackCategory } from '../../domain/supportInfo';
import type { StorageDiagnostics } from '../../lib/storage/db/persistenceBackend';

/** Known limitations of the pilot build: only things that matter to a user today. */
export const KNOWN_LIMITATION_KEYS: readonly TranslationKey[] = [
  'support.limit.testrailStatuses',
  'support.limit.credentials',
  'support.limit.history',
  'support.limit.assignments',
  'support.limit.crossTeam',
  'support.limit.delivery',
  'support.limit.executionHistory',
  'support.limit.browsers',
];

/**
 * Settings -> Support & Pilot (SV only, like the whole Settings screen): what build this is, a copyable diagnostics summary, the
 * known limitations and a Report Feedback form. Everything is derived and copied locally: nothing is stored, sent or polled, and the
 * outputs contain no credentials, report text, memos or project content (see domain/supportInfo.ts).
 */
export function SupportPanel({ lang, storage }: { lang: import('../../types').Language; storage: StorageDiagnostics | null }) {
  const reportsApi = useReportsStateCtx();
  const app = useAppStateCtx();
  const shared = useSharedSync();
  const { principal } = useTenant();
  const settings = reportsApi.state.settings;
  const [message, setMessage] = useState<string | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [screen, setScreen] = useState('');
  const [projectId, setProjectId] = useState('');
  const [reporter, setReporter] = useState(principal?.displayName ?? '');
  const [errorId, setErrorId] = useState('');
  const [showProblems, setShowProblems] = useState(false);

  const mode: 'local' | 'shared' = shared.enabled ? 'shared' : 'local';
  const role = principal === null ? 'local' : principal.role === 'user' ? 'tester' : 'sv';
  const lastError = getLastClientError();
  const storageLabel = storage === null ? 'unknown' : storage.mode;
  const lastBackupAt = readAutoBackupRecord().lastBackupAt;

  const diagnosticsText = (): string =>
    buildDiagnostics({
      build: { version: BUILD_INFO.version, commit: BUILD_INFO.commit, builtAt: BUILD_INFO.builtAt, channel: BUILD_INFO.channel, release: isTaggedRelease() ? BUILD_INFO.release : '' },
      mode,
      role,
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
      storage: storageLabel,
      jira: settings.jira === undefined ? 'notConfigured' : 'configured',
      testrail: settings.testrail === undefined ? 'notConfigured' : 'configured',
      sync: shared.sync === null ? null : { status: shared.sync.status, pending: shared.sync.pending, lastSyncedAt: shared.sync.lastSyncedAt },
      lastError,
      lastBackupAt,
      language: app.state.language,
      now: new Date(),
    });

  const copy = async (text: string, doneKey: TranslationKey): Promise<void> => {
    const result = await copyWithFallback(text, typeof navigator === 'undefined' ? undefined : navigator.clipboard);
    if (result.ok) {
      setFallback(null);
      setMessage(t(lang, doneKey));
    } else {
      setMessage(null);
      setFallback(result.fallbackText);
    }
  };

  const problems = feedbackProblems({ category, summary });
  const feedbackText = (): string =>
    buildFeedbackReport({
      category,
      summary,
      description,
      screen,
      ...(projectId === '' ? {} : { projectId }),
      ...(reporter.trim() === '' ? {} : { reporter }),
      ...(errorId.trim() === '' ? {} : { errorId }),
      build: { version: BUILD_INFO.version, commit: BUILD_INFO.commit, channel: BUILD_INFO.channel },
      createdAt: new Date(),
    });

  const screens = useMemo(() => NAV_ITEMS.map((item) => ({ id: item.id, label: t(lang, item.key) })), [lang]);
  const stateText = (configured: boolean): string => t(lang, configured ? 'support.state.configured' : 'support.state.notConfigured');

  return (
    <section className="dr-section" aria-labelledby="support-title">
      <h2 id="support-title">
        {t(lang, 'support.title')}{BUILD_INFO.channel === 'pilot' ? null : <span className="tag support-pilot-tag"> {BUILD_INFO.channel}</span>}
      </h2>
      <p className="exec-help">{t(lang, 'support.note')}</p>

      <dl className="support-facts">
        <dt>{t(lang, 'support.row.version')}</dt>
        <dd>{BUILD_INFO.version}{isTaggedRelease() ? ` · ${BUILD_INFO.release}` : ''}</dd>
        <dt>{t(lang, 'support.row.build')}</dt>
        <dd>{BUILD_INFO.commit || '?'} · {businessStamp(BUILD_INFO.builtAt)}</dd>
        <dt>{t(lang, 'support.row.mode')}</dt>
        <dd>{t(lang, mode === 'shared' ? 'support.mode.shared' : 'support.mode.local')}</dd>
        <dt>{t(lang, 'support.row.jira')}</dt>
        <dd>{stateText(settings.jira !== undefined)}</dd>
        <dt>{t(lang, 'support.row.testrail')}</dt>
        <dd>{stateText(settings.testrail !== undefined)}</dd>
        <dt>{t(lang, 'support.row.backup')}</dt>
        <dd>{lastBackupAt === null ? t(lang, 'support.backup.none') : businessStamp(lastBackupAt)}</dd>
        <dt>{t(lang, 'support.row.lastError')}</dt>
        <dd>{lastError === null ? t(lang, 'support.error.none') : `${lastError.requestId ?? '—'} · ${lastError.code}`}</dd>
      </dl>
      <p className="exec-help">{t(lang, 'support.integrationNote')}</p>

      <div className="dr-button-row">
        <button type="button" className="btn" onClick={() => void copy(diagnosticsText(), 'support.diag.copied')}>
          {t(lang, 'support.diag.copy')}
        </button>
      </div>
      <p className="exec-help">{t(lang, 'support.diag.privacy')}</p>

      <details>
        <summary>{t(lang, 'support.limits.title')}</summary>
        <ul>
          {KNOWN_LIMITATION_KEYS.map((key) => (
            <li key={key}>{t(lang, key)}</li>
          ))}
        </ul>
      </details>

      <h3>{t(lang, 'support.fb.title')}</h3>
      <p className="exec-help">{t(lang, 'support.fb.note')}</p>
      <div className="support-form">
        <label>
          {t(lang, 'support.fb.category')}
          <select value={category} onChange={(e) => setCategory(e.target.value as FeedbackCategory)}>
            {FEEDBACK_CATEGORIES.map((c) => (
              <option key={c} value={c}>{t(lang, `support.cat.${c}` as TranslationKey)}</option>
            ))}
          </select>
        </label>
        <label>
          {t(lang, 'support.fb.screen')}
          <select value={screen} onChange={(e) => setScreen(e.target.value)}>
            <option value="">{t(lang, 'support.fb.screenNone')}</option>
            {screens.map((s) => (
              <option key={s.id} value={s.label}>{s.label}</option>
            ))}
          </select>
        </label>
        <label>
          {t(lang, 'support.fb.project')}
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">{t(lang, 'support.fb.projectNone')}</option>
            {reportsApi.state.projects.map((p) => (
              <option key={p.projectId} value={p.projectId}>{p.projectId}</option>
            ))}
          </select>
        </label>
        <label>
          {t(lang, 'support.fb.summary')}
          <input className="input" type="text" maxLength={200} value={summary} aria-invalid={showProblems && problems.includes('summary')} onChange={(e) => setSummary(e.target.value)} />
        </label>
        {showProblems && problems.includes('summary') ? <p className="field-error" role="alert">{t(lang, 'support.fb.summaryRequired')}</p> : null}
        <label>
          {t(lang, 'support.fb.description')}
          <textarea className="dr-preview" rows={6} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          {t(lang, 'support.fb.reporter')}
          <input className="input" type="text" maxLength={80} value={reporter} onChange={(e) => setReporter(e.target.value)} />
        </label>
        <label>
          {t(lang, 'support.fb.errorId')}
          <input className="input" type="text" maxLength={64} value={errorId} placeholder={lastError?.requestId ?? ''} onChange={(e) => setErrorId(e.target.value)} />
        </label>
      </div>
      <div className="dr-button-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (problems.length > 0) {
              setShowProblems(true);
              return;
            }
            void copy(feedbackText(), 'support.fb.copied');
          }}
        >
          {t(lang, 'support.fb.copy')}
        </button>
      </div>
      {message !== null ? <p className="dr-message ok" role="status">{message}</p> : null}
      {fallback !== null ? (
        <div>
          <p className="qa-warning" role="note">{t(lang, 'dailyReport.publication.copyManual')}</p>
          <textarea className="dr-preview" readOnly rows={10} value={fallback} aria-label={t(lang, 'dailyReport.publication.copyManual')} onFocus={(e) => e.currentTarget.select()} />
        </div>
      ) : null}
    </section>
  );
}
