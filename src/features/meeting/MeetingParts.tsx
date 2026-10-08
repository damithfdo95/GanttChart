import { useEffect, useState } from 'react';
import { t, type TranslationKey } from '../../i18n';
import { parseTotalInput } from '../../domain/testManagement/totals';
import { highestSeverity } from '../../domain/qaMetrics';
import type { MeetingRisk } from '../../domain/meeting';
import type { Language } from '../../types';

/**
 * A whole-number cell an SV types into: saved when the field is left or Enter is pressed (one commit, never one per keystroke),
 * nothing is written when the value did not change, and an empty field means "no plan".
 */
export function PlanInput({ lang, value, label, onCommit }: { lang: Language; value: number | null; label: string; onCommit: (next: number) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(value === null ? '' : String(value));
    setInvalid(false);
  }, [value]);
  const commit = (): void => {
    const parsed = parseTotalInput(text);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed === undefined || parsed === value) return; // an empty field changes nothing (a plan is cleared by setting 0)
    onCommit(parsed);
  };
  return (
    <span className="tm-total-input">
      <input
        className="input mt-input"
        inputMode="numeric"
        value={text}
        placeholder={t(lang, 'mt.notSet')}
        aria-label={label}
        aria-invalid={invalid}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      {invalid ? (
        <span role="alert" className="link-help">
          {t(lang, 'mt.error.invalid')}
        </span>
      ) : null}
    </span>
  );
}

/** A short free-text note, saved when the box is left (never per keystroke). */
export function NoteBox({ lang, label, value, readOnly, onCommit }: { lang: Language; label: string; value: string; readOnly: boolean; onCommit: (text: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  if (readOnly) {
    return (
      <div className="mt-note">
        <h3>{label}</h3>
        <p className={value === '' ? 'link-help' : 'mt-note-text'}>{value === '' ? t(lang, 'mt.note.none') : value}</p>
      </div>
    );
  }
  return (
    <label className="mt-note">
      <span className="mt-note-label">{label}</span>
      <textarea className="input" rows={2} maxLength={1000} value={text} placeholder={t(lang, 'mt.note.placeholder')} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} />
    </label>
  );
}

const SYMBOL = { attention: '⚠', warning: '△', info: '●' } as const;

/** The row's risk in words with a symbol: never colour alone. */
export function MeetingRiskBadge({ lang, risks }: { lang: Language; risks: readonly MeetingRisk[] }) {
  const level = highestSeverity(risks);
  const key: TranslationKey = level === 'attention' ? 'mt.risk.attention' : level === 'warning' ? 'mt.risk.watch' : 'mt.risk.ok';
  const symbol = level === null ? '✓' : SYMBOL[level];
  return (
    <span className={`risk-badge risk-${level ?? 'ok'}`}>
      <span aria-hidden="true">{symbol} </span>
      {t(lang, key)}
    </span>
  );
}

export function MeetingRiskList({ lang, risks }: { lang: Language; risks: readonly MeetingRisk[] }) {
  if (risks.length === 0) return <span className="risk-ok">{t(lang, 'risk.none')}</span>;
  return (
    <ul className="risk-list">
      {risks.map((r) => (
        <li key={r.code} className={`risk risk-${r.severity}`}>
          <span aria-hidden="true">{SYMBOL[r.severity]} </span>
          <span className="sr-only">{t(lang, `risk.severity.${r.severity}` as TranslationKey)}: </span>
          {t(lang, `risk.${r.code}` as TranslationKey, { value: r.value ?? 0 })}
        </li>
      ))}
    </ul>
  );
}
