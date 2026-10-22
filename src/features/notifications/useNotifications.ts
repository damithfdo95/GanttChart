import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { businessClock, businessMomentMs } from '../../../shared/businessTime';
import { OVERDUE_MS, dueFor, isOverdue, soonestNext, type DueNotification, type NotificationDef, type Recipient } from '../../../shared/notifications';
import { ApiError } from '../../lib/tenancy/api';

declare global {
  interface Window {
    /** Development aid only: shifts the clock this screen uses to decide what is due (the server still decides what may be acknowledged). */
    __GC_NOW_OFFSET__?: number;
  }
}

const nowMs = (): number => Date.now() + (typeof window !== 'undefined' && typeof window.__GC_NOW_OFFSET__ === 'number' ? window.__GC_NOW_OFFSET__ : 0);

/**
 * A clock that moves only when it matters: when the nearest scheduled moment arrives, when a due item becomes OVERDUE (15 min), and when the
 * window regains focus or becomes visible. Nothing is written when it ticks; it only re-evaluates what is due.
 */
function useScheduleClock(defs: readonly NotificationDef[], items: readonly DueNotification[]): number {
  const [now, setNow] = useState(nowMs);
  useEffect(() => {
    const refresh = (): void => setNow(nowMs());
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const next = soonestNext(defs, businessClock(nowMs()));
    let timer: number | undefined;
    if (next !== null) {
      const wait = Math.min(Math.max(businessMomentMs(next.date, next.time) - nowMs() + 500, 1000), 6 * 3_600_000);
      timer = window.setTimeout(refresh, wait);
    }
    // A due item also changes state when it becomes OVERDUE: wake up then, too.
    let overdueTimer: number | undefined;
    for (const item of items) {
      const wait = businessMomentMs(item.occurrence.date, item.occurrence.time) + OVERDUE_MS - nowMs() + 500;
      if (wait > 0 && (overdueTimer === undefined || wait < overdueTimer)) {
        overdueTimer = window.setTimeout(refresh, Math.min(Math.max(wait, 1000), 6 * 3_600_000));
      }
    }
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
      if (timer !== undefined) window.clearTimeout(timer);
      if (overdueTimer !== undefined) window.clearTimeout(overdueTimer);
    };
  }, [defs, items, now]);
  return now;
}

export type AckState = { kind: 'idle' } | { kind: 'working' } | { kind: 'error'; code: string };

/** What the signed-in person must see now, and how they close it. Definitions arrive already narrowed to what addresses them. */
export function useDueNotifications() {
  const reports = useReportsStateCtx();
  const { principal, api } = useTenant();
  const defs = useMemo(() => reports.state.notifications ?? [], [reports.state.notifications]);
  const acks = reports.state.notificationAcks ?? [];
  const members = reports.state.rcsMembers ?? [];
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [state, setState] = useState<Record<string, AckState>>({});

  const enabled = principal !== null && principal.userId !== null && principal.sharedWorkspace && (principal.role === 'admin' || principal.role === 'user');

  // First pass with the current clock to know what is due; the clock then also wakes when one of them turns overdue.
  const dueNow = useMemo((): DueNotification[] => {
    if (!enabled || principal === null || principal.userId === null) return [];
    const mine = members.find((m) => m.userId === principal.userId);
    const who: Recipient = { role: principal.role === 'admin' ? 'admin' : 'user', memberId: mine?.id ?? null, memberActive: mine === undefined ? true : mine.active };
    return dueFor(defs, acks, principal.userId, who, businessClock(nowMs()));
  }, [enabled, principal, members, defs, acks]);

  const now = useScheduleClock(defs, dueNow);
  const items = useMemo(
    () => dueNow.filter((d) => !closed.has(`${d.def.id}\u0000${d.occurrence.key}`)),
    [dueNow, closed],
  );
  const overdueKeys = useMemo(
    () => new Set(items.filter((d) => isOverdue(d, now)).map((d) => `${d.def.id}\u0000${d.occurrence.key}`)),
    [items, now],
  );

  const acknowledge = useCallback(
    async (item: DueNotification): Promise<void> => {
      const key = `${item.def.id}\u0000${item.occurrence.key}`;
      if (api === null) return;
      setState((s) => ({ ...s, [key]: { kind: 'working' } }));
      try {
        await api.acknowledgeNotification(item.def.id, item.occurrence.key);
        setClosed((c) => new Set(c).add(key)); // saved on the server: it can go (the same fact also arrives through sync)
        setState((s) => ({ ...s, [key]: { kind: 'idle' } }));
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 'error';
        // It no longer applies to this person (switched off, deleted, or no longer addressed to them): it goes without being "closed".
        if (code === 'notification_not_found' || code === 'not_addressed') {
          setClosed((c) => new Set(c).add(key));
          return;
        }
        // Not saved: it STAYS, with the reason, and can be tried again.
        setState((s) => ({ ...s, [key]: { kind: 'error', code } }));
      }
    },
    [api],
  );

  return { items, overdueKeys, acknowledge, state };
}
