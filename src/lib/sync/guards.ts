/**
 * Rules for actions that become destructive once the data is shared.
 *
 * Pure with injectable dialogs so the rules are unit-tested instead of living
 * in click handlers. In local-only mode every guard passes through and the
 * app's existing confirmations are the only protection, as before.
 */

import type { Role } from '../../../shared/protocol';
import type { Language } from '../../types';
import type { TranslationKey } from '../../i18n';
import { t } from '../../i18n';
import { REPLACE_CONFIRMATION } from './link';

/** Days of shared history the server keeps (matches HISTORY_RETENTION_DAYS in wrangler.jsonc). */
export const SHARED_HISTORY_DAYS = 30;

export interface Dialogs {
  confirm(message: string): boolean;
  prompt(message: string): string | null;
  alert(message: string): void;
}

export interface SharedContext {
  enabled: boolean;
  role: Role | null;
}

export const browserDialogs: Dialogs = {
  confirm: (m) => window.confirm(m),
  prompt: (m) => window.prompt(m),
  alert: (m) => window.alert(m),
};

/** A read-only person must not make changes that silently go nowhere. */
export function guardWrite(lang: Language, ctx: SharedContext, dialogs: Dialogs): boolean {
  if (ctx.enabled && ctx.role === 'viewer') {
    dialogs.alert(t(lang, 'shared.error.readOnly'));
    return false;
  }
  return true;
}

/**
 * Replacing the WHOLE workspace (restoring a full backup) is a change for
 * everyone: administrators only, and only after typing the confirmation word.
 */
export function confirmSharedReplace(lang: Language, ctx: SharedContext, dialogs: Dialogs): boolean {
  if (!ctx.enabled) return true;
  if (ctx.role !== 'admin') {
    dialogs.alert(t(lang, ctx.role === 'viewer' ? 'shared.error.readOnly' : 'shared.error.adminOnly'));
    return false;
  }
  const typed = dialogs.prompt(t(lang, 'shared.confirm.replaceWorkspace', { days: SHARED_HISTORY_DAYS, word: REPLACE_CONFIRMATION }));
  return typed === REPLACE_CONFIRMATION;
}

/**
 * An action that is destructive for the person who triggers it (and already
 * asks for confirmation) is destructive for EVERYONE in shared mode: ask once
 * more, in words that say so, and never let a read-only person start it.
 */
export function confirmSharedDestructive(lang: Language, ctx: SharedContext, dialogs: Dialogs, key: TranslationKey): boolean {
  if (!ctx.enabled) return true;
  if (!guardWrite(lang, ctx, dialogs)) return false;
  return dialogs.confirm(t(lang, key, { days: SHARED_HISTORY_DAYS }));
}
