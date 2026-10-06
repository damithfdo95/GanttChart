import type { Language } from '../../types';
import { t } from '../../i18n';

/**
 * Fixed absence-reason presets (morning report). A preset is stored in
 * `AttendanceRecord.leaveType` as its stable key; any other non-empty
 * value is legacy/manual free text and renders verbatim. `null`/'' mean
 * "no reason recorded".
 */
export const ABSENCE_REASON_PRESETS: readonly { key: string; labelKey: 'absenceReason.poorHealth' | 'absenceReason.personal' | 'absenceReason.official' | 'absenceReason.familyCare' | 'absenceReason.transport' }[] = [
  { key: 'poorHealth', labelKey: 'absenceReason.poorHealth' },
  { key: 'personal', labelKey: 'absenceReason.personal' },
  { key: 'official', labelKey: 'absenceReason.official' },
  { key: 'familyCare', labelKey: 'absenceReason.familyCare' },
  { key: 'transport', labelKey: 'absenceReason.transport' },
];

const PRESET_KEYS: readonly string[] = ABSENCE_REASON_PRESETS.map((preset) => preset.key);

/** True when the stored leaveType value is one of the preset keys. */
export function isPresetReason(value: string | null): boolean {
  return value !== null && PRESET_KEYS.includes(value);
}

/**
 * The reason text in the report language: the translated preset label, or
 * the raw manual/legacy free text. Empty string when nothing is recorded.
 */
export function absenceReasonLabel(lang: Language, leaveType: string | null): string {
  if (leaveType === null || leaveType.trim() === '') return '';
  const preset = ABSENCE_REASON_PRESETS.find((p) => p.key === leaveType);
  return preset !== undefined ? t(lang, preset.labelKey) : leaveType;
}
