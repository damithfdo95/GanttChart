import { useMemo } from 'react';
import { useAppStateCtx } from './state-contexts';
import { useSharedSync } from './shared-sync';
import { SHARED_HISTORY_DAYS } from '../lib/sync/guards';
import { REPLACE_CONFIRMATION } from '../lib/sync/link';
import { t, type TranslationKey } from '../i18n';
import { useConfirm } from '../components/ConfirmDialog';

/** The shared-mode guards, bound to the current language and the browser's dialogs. */
export function useSharedGuard() {
  const shared = useSharedSync();
  const lang = useAppStateCtx().state.language;
  const confirm = useConfirm();
  const role = shared.sync?.you?.role ?? shared.identity?.role ?? null;
  return useMemo(() => {
    const explainBlocked = async (message: string): Promise<false> => {
      await confirm({ title: t(lang, 'confirm.title'), body: message, confirmLabel: t(lang, 'confirm.ok'), cancelLabel: t(lang, 'tenancy.cancel') });
      return false;
    };
    const guardWrite = async (): Promise<boolean> => {
      if (shared.enabled && role === 'viewer') return explainBlocked(t(lang, 'shared.error.readOnly'));
      return true;
    };
    return {
      enabled: shared.enabled,
      role,
      /** false (after telling the person why) when they are read-only in shared mode. */
      guardWrite,
      /** Whole-workspace replacement: admin + typed confirmation in shared mode. */
      confirmReplace: async (): Promise<boolean> => {
        if (!shared.enabled) return true;
        if (role !== 'admin') return explainBlocked(t(lang, role === 'viewer' ? 'shared.error.readOnly' : 'shared.error.adminOnly'));
        return confirm({
          title: t(lang, 'confirm.title'),
          body: t(lang, 'shared.confirm.replaceWorkspace', { days: SHARED_HISTORY_DAYS, word: REPLACE_CONFIRMATION }),
          confirmLabel: t(lang, 'confirm.ok'),
          cancelLabel: t(lang, 'tenancy.cancel'),
          severity: 'danger',
          typed: [{ label: REPLACE_CONFIRMATION, expected: REPLACE_CONFIRMATION }],
        });
      },
      /** Extra "this affects everyone" confirmation in shared mode. */
      confirmEveryone: async (key: TranslationKey): Promise<boolean> => {
        if (!shared.enabled) return true;
        if (!(await guardWrite())) return false;
        return confirm({
          title: t(lang, 'confirm.title'),
          body: t(lang, key, { days: SHARED_HISTORY_DAYS }),
          confirmLabel: t(lang, 'confirm.ok'),
          cancelLabel: t(lang, 'tenancy.cancel'),
          severity: 'warning',
        });
      },
    };
  }, [shared.enabled, role, lang, confirm]);
}
