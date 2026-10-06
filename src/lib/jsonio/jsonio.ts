import type { AppState } from '../../types';
import type { TranslationKey } from '../../i18n';
import { isAppState, isLegacyAppState, migrateLegacyState, normalizeAppState } from '../storage/storage';
import { validateInputs, validatePlanning } from '../validation/validate';
import { pad2 } from '../formatting/format';

const APP_ID = 'ganttchart';
const SCHEMA_VERSION = 2;

/** Envelope written to exported JSON files (§22, V2 §9). */
export interface ExportPayload {
  app: typeof APP_ID;
  version: number;
  exportedAt: string;
  data: AppState;
}

export type ImportResult =
  | { ok: true; data: AppState }
  | { ok: false; errorKey: TranslationKey };
export function createExportPayload(state: AppState): ExportPayload {
  return {
    app: APP_ID,
    version: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data: state,
  };
}

/**
 * Strict local validation beyond shape checks (V2 §9): files with invalid
 * ranges — negative staffing, unordered or invalid dates, a bad target time,
 * or v1 rule violations — are rejected clearly, never silently accepted.
 */
function isValidForImport(data: AppState): boolean {
  return validateInputs(data).isValid && validatePlanning(data).isValid;
}

/**
 * Parse and validate an imported JSON file entirely in the browser
 * (§22, §23, V2 §9). Accepts V2 files (strict) and V1 files (migrated).
 * No upload, no server; the file never leaves the machine.
 */
export function parseImportPayload(text: string): ImportResult {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, errorKey: 'messages.importErrInvalid' };
    }
    const p = parsed as Record<string, unknown>;
    if (p.app !== APP_ID) {
      return { ok: false, errorKey: 'messages.importErrInvalid' };
    }
    if (p.version === 2) {
      if (!isAppState(p.data) || !isValidForImport(p.data)) {
        return { ok: false, errorKey: 'messages.importErrInvalid' };
      }
      return { ok: true, data: normalizeAppState(p.data) };
    }
    if (p.version === 1 && isLegacyAppState(p.data)) {
      return { ok: true, data: migrateLegacyState(p.data) };
    }
    return { ok: false, errorKey: 'messages.importErrInvalid' };
  } catch {
    return { ok: false, errorKey: 'messages.importErrInvalid' };
  }
}

/**
 * Save the current state as a local JSON file via Blob + object URL (§23).
 * The file is generated and downloaded entirely on the local machine.
 */
export function downloadStateAsJson(state: AppState): void {
  const payload = createExportPayload(state);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const now = new Date();
  const stamp =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  a.href = url;
  a.download = `ganttchart-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
