/**
 * Display formatting (§25, §30).
 *
 * Rounding rule: displayed clock times and durations are floored to whole
 * minutes for conservative estimates — e.g. 13:00 + 1.125h is shown as 14:07,
 * not 14:08. Every formatter accepts null/NaN and returns "—" so the UI can
 * never render NaN, Infinity, undefined, null, or an invalid date.
 *
 * Numbers are locale-aware (en → en-US, ja → ja-JP) via Intl; clock times
 * always stay in 24-hour "HH:mm" form in both languages.
 */

import type { Language } from '../../types';

const INTL_LOCALE: Record<Language, string> = { en: 'en-US', ja: 'ja-JP' };

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "HH:mm"; values past midnight get a "(+Nd)" day annotation; null → "—". */
export function formatClock(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  const days = Math.floor(minutes / 1440);
  const inDay = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(inDay / 60);
  const m = Math.floor(inDay % 60);
  const base = `${pad2(h)}:${pad2(m)}`;
  return days > 0 ? `${base} (+${days}d)` : base;
}

/** Duration: "42m" / "1h 08m" / "2h 53m" / "-45m"; null → "—". */
export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  const sign = minutes < 0 ? '-' : '';
  const total = Math.floor(Math.abs(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${sign}${m}m`;
  return `${sign}${h}h ${pad2(m)}m`;
}

/** Signed duration for variance display: "+2h 30m" / "-45m" / "0m"; null → "—". */
export function formatSignedDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  if (minutes === 0) return '0m';
  return `${minutes > 0 ? '+' : ''}${formatDuration(minutes)}`;
}

/** Locale-aware fixed-decimal number display; null/NaN → "—". */
export function formatNumber(value: number | null, digits = 1, lang: Language = 'en'): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(INTL_LOCALE[lang], {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Locale-aware integer display (digit grouping per locale); null/NaN → "—". */
export function formatInteger(value: number | null, lang: Language = 'en'): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(INTL_LOCALE[lang]).format(Math.round(value));
}

/** "HH:mm" (00:00–23:59) → minutes since midnight; null when unparsable. */
export function parseTimeToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes since midnight → "HH:mm" for <input type="time"> fields. */
export function minutesToTimeInput(minutes: number): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

/** Case counts: integers plain, fractional to 1 decimal; null/NaN → "—". */
export function formatCases(value: number | null, lang: Language = 'en'): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? formatInteger(value, lang) : formatNumber(value, 1, lang);
}

/** Signed duration that may span days: "+1d 3h 30m" / "-45m" / "0m"; null → "—". */
export function formatSignedMultiDayDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  if (minutes === 0) return '0m';
  const sign = minutes > 0 ? '+' : '-';
  const total = Math.floor(Math.abs(minutes));
  const days = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  const hm = h > 0 ? `${h}h ${pad2(m)}m` : `${m}m`;
  return days > 0 ? `${sign}${days}d ${hm}` : `${sign}${hm}`;
}
