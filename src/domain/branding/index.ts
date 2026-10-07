import { TOOL_NAME_MAX, cleanToolName } from '../../../shared/qaRules';
import { t } from '../../i18n';
import type { Language, ReportSettings } from '../../types';

/**
 * Workspace Appearance (Stage 8B): the workspace's own name for the tool. Tenant-specific, set by an SV in Settings, shown after
 * sign-in (the header and the browser tab). The public landing page keeps the platform name because nobody is signed in there.
 * A logo is deliberately NOT implemented: see docs/ADMINISTRATION.md for the free-plan approach.
 */
export { TOOL_NAME_MAX, cleanToolName };

/** The name to show: the workspace's own, or the platform's. */
export function toolNameOf(settings: Pick<ReportSettings, 'toolName'> | undefined, lang: Language): string {
  const own = settings?.toolName === undefined ? null : cleanToolName(settings.toolName);
  return own ?? t(lang, 'app.title');
}
