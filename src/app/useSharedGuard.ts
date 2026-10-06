import { useMemo } from 'react';
import { useAppStateCtx } from './state-contexts';
import { useSharedSync } from './shared-sync';
import { browserDialogs, confirmSharedDestructive, confirmSharedReplace, guardWrite, type SharedContext } from '../lib/sync/guards';
import type { TranslationKey } from '../i18n';

/** The shared-mode guards, bound to the current language and the browser's dialogs. */
export function useSharedGuard() {
  const shared = useSharedSync();
  const lang = useAppStateCtx().state.language;
  const role = shared.sync?.you?.role ?? shared.identity?.role ?? null;
  return useMemo(() => {
    const ctx: SharedContext = { enabled: shared.enabled, role };
    return {
      enabled: shared.enabled,
      role,
      /** false (after telling the person why) when they are read-only in shared mode. */
      guardWrite: (): boolean => guardWrite(lang, ctx, browserDialogs),
      /** Whole-workspace replacement: admin + typed confirmation in shared mode. */
      confirmReplace: (): boolean => confirmSharedReplace(lang, ctx, browserDialogs),
      /** Extra "this affects everyone" confirmation in shared mode. */
      confirmEveryone: (key: TranslationKey): boolean => confirmSharedDestructive(lang, ctx, browserDialogs, key),
    };
  }, [shared.enabled, role, lang]);
}
