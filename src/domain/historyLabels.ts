import { RECORD_KINDS } from '../../shared/protocol';
import { resolveBilingualName, t, type TranslationKey } from '../i18n';
import type { Language, ReportsState } from '../types';
import { looksLikeTechnicalId } from './people';

/**
 * Names for what a revision changed, for History. A person reads "Scope: Ecosystem", never an internal id: every label comes from the data as it is
 * now, and a record that no longer exists gets a neutral word ("removed"), not its id. Pure; the screen supplies the current workspace state.
 */
export const kindLabelKey = (kind: string): TranslationKey => `hist.kind.${kind}` as TranslationKey;

export function recordLabel(kind: string, id: string, state: ReportsState, lang: Language): string {
  const gone = t(lang, 'hist.removed');
  const safe = (v: string | undefined): string | null => (v === undefined || v.trim() === '' || looksLikeTechnicalId(v) ? null : v.trim());
  switch (kind) {
    case 'project': {
      const p = state.projects.find((x) => x.id === id);
      return p === undefined ? gone : safe(resolveBilingualName(lang, { nameEn: p.nameEn, nameJa: p.nameJa })) ?? p.projectId;
    }
    case 'scope':
      return safe((state.scopes ?? []).find((x) => x.id === id)?.name) ?? gone;
    case 'testCase':
      return (state.testCases ?? []).find((x) => x.id === id)?.key ?? gone;
    case 'caseResult': {
      const key = (state.testCases ?? []).find((x) => `res_${x.id}` === id)?.key;
      return key ?? gone;
    }
    case 'member':
      return safe((state.rcsMembers ?? []).find((x) => x.id === id)?.name) ?? gone;
    case 'cycle':
      return safe((state.cycles ?? []).find((x) => x.id === id)?.name) ?? gone;
    case 'notification':
      return safe((state.notifications ?? []).find((x) => x.id === id)?.title) ?? gone;
    case 'dailyPlan': {
      // dp_<date>_<project>_<all | scope id>: the date, the project's name and (when there is one) the scope's name.
      const m = /^dp_(\d{4}-\d{2}-\d{2})_(.+?)_(all|scp_.+)$/.exec(id);
      if (m === null) return gone;
      const project = state.projects.find((x) => x.projectId === m[2]);
      const projectName = project === undefined ? '' : safe(resolveBilingualName(lang, { nameEn: project.nameEn, nameJa: project.nameJa })) ?? '';
      const scopeName = m[3] === 'all' ? '' : safe((state.scopes ?? []).find((x) => x.id === m[3])?.name) ?? '';
      return [m[1], projectName, scopeName].filter((x) => x !== '').join(' · ');
    }
    case 'meetingNote':
      return /^mn_(\d{4}-\d{2}-\d{2})$/.exec(id)?.[1] ?? gone;
    case 'notificationAck': {
      const m = /^na_(ntf_[0-9A-Za-z-]+)_/.exec(id);
      return m === null ? '' : safe((state.notifications ?? []).find((x) => x.id === m[1])?.title) ?? '';
    }
    case 'attendance': {
      const a = state.attendance.find((x) => x.id === id);
      return a === undefined ? gone : a.date;
    }
    case 'report': {
      const r = state.reports.find((x) => x.id === id);
      return r === undefined ? gone : r.reportDate;
    }
    case 'settings':
    case 'branding':
      return '';
    default:
      return gone;
  }
}

/** "Scope: Ecosystem" / "Settings" / "Test Case: ECO-003". */
export function changedLabel(kind: string, id: string, state: ReportsState, lang: Language): string {
  const kindText = (RECORD_KINDS as readonly string[]).includes(kind) ? t(lang, kindLabelKey(kind)) : t(lang, 'hist.kind.other');
  const name = recordLabel(kind, id, state, lang);
  return name === '' ? kindText : `${kindText}: ${name}`;
}

/** Who made a change: their display name, else their email, else a neutral word. System actors have their own words. */
export function actorLabel(email: string, state: ReportsState, lang: Language): string {
  if (email === 'server' || email === 'retention') return t(lang, 'hist.actor.system');
  const m = (state.rcsMembers ?? []).find((x) => x.email === email.toLowerCase());
  const named = m?.name;
  if (named !== undefined && named.trim() !== '' && !looksLikeTechnicalId(named)) return named;
  return /^[^\s@]+@[^\s@]+$/.test(email) ? email : t(lang, 'people.former');
}
