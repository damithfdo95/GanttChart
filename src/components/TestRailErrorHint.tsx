import type { TestRailClientError } from '../../shared/testrail';
import { t, type TranslationKey } from '../i18n';
import type { Language } from '../types';

/**
 * The localized recovery hint for one typed TestRail failure (kind from the
 * client, reused by every TestRail touch point: the import dialog and the
 * linked-scope progress readout). A missing/incomplete connection
 * (kind `notConfigured`) gets the caller's Settings-pointer message instead
 * of the generic setup wording, so an SV learns WHERE to fix it. The stable
 * non-localized technical message from the client is appended when present —
 * identical to the pattern in Settings → TestRail Integration.
 */
export function TestRailErrorHint({
  lang,
  error,
  notConfiguredMessage,
}: {
  lang: Language;
  error: TestRailClientError;
  notConfiguredMessage: TranslationKey;
}) {
  const hint = t(lang, error.kind === 'notConfigured' ? notConfiguredMessage : (`testrail.error.${error.kind}` as TranslationKey));
  const message = error.message === undefined || error.message === '' ? '' : ` — ${error.message}`;
  return (
    <p className="qa-warning" role="alert">
      <strong>{hint}</strong>
      {message}
    </p>
  );
}