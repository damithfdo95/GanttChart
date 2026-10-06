import enJson from '../locales/en.json';
import jaJson from '../locales/ja.json';
import type { Language } from '../types';

/**
 * Translation dictionaries loaded from the JSON resource files
 * (src/locales/en.json, src/locales/ja.json). Japanese is the default
 * language (§20) and the English file is the source of truth for the key
 * set; TypeScript enforces that the Japanese file defines the exact same
 * keys.
 */
export type TranslationKey = keyof typeof enJson;

export const en: Record<TranslationKey, string> = enJson;
export const ja: Record<TranslationKey, string> = jaJson;

export const dictionaries: Record<Language, Record<TranslationKey, string>> = { en, ja };
