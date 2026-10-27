import { useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { t, type TranslationKey } from '../../i18n';
import { QA_DEFECT_SEVERITIES, QA_DEFECT_STATUSES, isDefaultQaPolicy, resolveQaPolicy, type QaPolicy } from '../../../shared/qaPolicy';
import { bugSeverityLabel, bugStatusLabel } from '../tickets/TicketForm';

type Opt<K extends keyof QaPolicy> = { key: K; options: ReadonlyArray<QaPolicy[K] & string> };

const OPTION_KEY: Record<string, TranslationKey> = {
  blocked: 'settings.qaPolicy.opt.blocked',
  atRisk: 'settings.qaPolicy.opt.atRisk',
  info: 'settings.qaPolicy.opt.info',
  whenScheduleAtRisk: 'settings.qaPolicy.opt.whenScheduleAtRisk',
  alwaysAtRisk: 'settings.qaPolicy.opt.alwaysAtRisk',
  informational: 'settings.qaPolicy.opt.informational',
};

/**
 * Settings -> QA Policy (SV only, like the whole Settings screen; the server also refuses a Tester's write): the few choices that
 * differ between QA teams in how release readiness reads defects and results. Shared by the whole workspace, so a change recalculates
 * readiness for everyone and touches no project data. The default reproduces the original behavior.
 */
export function QaPolicySettings() {
  const lang = useAppStateCtx().state.language;
  const reports = useReportsStateCtx();
  const policy = resolveQaPolicy(reports.state.settings.qaPolicy);
  const custom = !isDefaultQaPolicy(policy);
  const [message, setMessage] = useState<string | null>(null);

  const save = (patch: Partial<QaPolicy>): void => {
    const next: QaPolicy = { ...policy, ...patch };
    // Equal to the default: store nothing (the default is the absence of a policy).
    reports.updateSettings({ qaPolicy: isDefaultQaPolicy(next) ? undefined : next });
    setMessage(t(lang, 'settings.qaPolicy.saved'));
  };
  const toggle = <T extends string>(list: readonly T[], value: T, all: readonly T[]): T[] => all.filter((x) => (x === value ? !list.includes(x) : list.includes(x)));

  const select = <K extends 'defectsAction' | 'failedCases' | 'blockedCases' | 'missingExecution' | 'staffingGap'>({ key, options }: Opt<K>, labelKey: TranslationKey) => (
    <label className="settings-field">
      {t(lang, labelKey)}
      <select className="input" value={policy[key] as string} onChange={(e) => save({ [key]: e.target.value } as Partial<QaPolicy>)}>
        {options.map((o) => (
          <option key={o} value={o}>
            {t(lang, OPTION_KEY[o] as TranslationKey)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      <p className="dr-summary">{t(lang, 'settings.qaPolicy.help')}</p>
      <p className="link-help">
        {t(lang, 'settings.qaPolicy.current')}: {t(lang, custom ? 'readiness.policy.custom' : 'readiness.policy.default')}
      </p>

      <h3>{t(lang, 'settings.qaPolicy.group.defects')}</h3>
      <fieldset className="plain-fieldset">
        <legend>{t(lang, 'settings.qaPolicy.severities')}</legend>
        {QA_DEFECT_SEVERITIES.map((s) => (
          <label key={s} className="field-check">
            <input type="checkbox" checked={policy.blockingDefectSeverities.includes(s)} onChange={() => save({ blockingDefectSeverities: toggle(policy.blockingDefectSeverities, s, QA_DEFECT_SEVERITIES) })} /> {bugSeverityLabel(lang, s)}
          </label>
        ))}
        {policy.blockingDefectSeverities.length === 0 ? <p className="link-help">{t(lang, 'settings.qaPolicy.noneSelected')}</p> : null}
      </fieldset>
      <fieldset className="plain-fieldset">
        <legend>{t(lang, 'settings.qaPolicy.statuses')}</legend>
        {QA_DEFECT_STATUSES.map((s) => (
          <label key={s} className="field-check">
            <input type="checkbox" checked={policy.unresolvedDefectStatuses.includes(s)} onChange={() => save({ unresolvedDefectStatuses: toggle(policy.unresolvedDefectStatuses, s, QA_DEFECT_STATUSES) })} /> {bugStatusLabel(lang, s)}
          </label>
        ))}
      </fieldset>
      {select({ key: 'defectsAction', options: ['blocked', 'atRisk'] }, 'settings.qaPolicy.defectsAction')}

      <h3>{t(lang, 'settings.qaPolicy.group.execution')}</h3>
      {select({ key: 'failedCases', options: ['atRisk', 'blocked'] }, 'settings.qaPolicy.failedCases')}
      {select({ key: 'blockedCases', options: ['info', 'atRisk', 'blocked'] }, 'settings.qaPolicy.blockedCases')}

      <h3>{t(lang, 'settings.qaPolicy.group.evidence')}</h3>
      {select({ key: 'missingExecution', options: ['info', 'atRisk'] }, 'settings.qaPolicy.missingExecution')}

      <h3>{t(lang, 'settings.qaPolicy.group.staffing')}</h3>
      {select({ key: 'staffingGap', options: ['whenScheduleAtRisk', 'alwaysAtRisk', 'informational'] }, 'settings.qaPolicy.staffingGap')}

      <div className="dr-button-row">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!custom}
          onClick={() => {
            reports.updateSettings({ qaPolicy: undefined });
            setMessage(t(lang, 'settings.qaPolicy.reverted'));
          }}
        >
          {t(lang, 'settings.qaPolicy.reset')}
        </button>
        {message === null ? null : (
          <span className="data-controls-message ok" role="status">
            {message}
          </span>
        )}
      </div>
    </>
  );
}
