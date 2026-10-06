import { dictionaries, type TranslationKey } from './dictionaries';
import type { BilingualName, Language } from '../types';

/**
 * Simple internal i18n lookup — no external translation service. Values in
 * the resource files may contain {placeholder} variables which are filled
 * from the optional `vars` map; sentences are never assembled by
 * concatenating translated fragments.
 */
export function t(lang: Language, key: TranslationKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[lang][key];
  return vars === undefined ? template : interpolate(template, vars);
}

/** Replace {name} placeholders with values; unknown placeholders are kept. */
export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

/** The other language, used for bilingual section headers (入力条件 / INPUT). */
export function otherLanguage(lang: Language): Language {
  return lang === 'ja' ? 'en' : 'ja';
}

/** Supported UI languages with their fixed switcher labels. */
export interface LanguageOption {
  code: Language;
  /** Short label shown in the header switcher, e.g. "EN" / "日本語". */
  short: string;
  /** Name of the language in itself, e.g. "English" / "日本語". */
  native: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en', short: 'EN', native: 'English' },
  { code: 'ja', short: '日本語', native: '日本語' },
];

/**
 * Resolve an optional bilingual (user-generated) name: prefer the name in the
 * active language, fall back to the other one, so a single name is shown in
 * either language. Never machine-translated.
 */
export function resolveBilingualName(lang: Language, names: BilingualName | undefined): string {
  const primary = (lang === 'en' ? names?.nameEn : names?.nameJa) ?? '';
  const fallback = (lang === 'en' ? names?.nameJa : names?.nameEn) ?? '';
  const trimmed = primary.trim();
  return trimmed !== '' ? trimmed : fallback.trim();
}

export type { TranslationKey };
