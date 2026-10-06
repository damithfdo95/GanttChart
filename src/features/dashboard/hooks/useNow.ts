import { useEffect, useState } from 'react';
import type { MinutesOfDay } from '../../../types';
import { nowMinutesOfDay } from '../../../lib/dates/dates';

function readNow(): MinutesOfDay {
  // Same timezone (Asia/Tokyo) as todayEpochDays(), so date and time-of-day
  // always agree even when the machine runs in another timezone.
  return nowMinutesOfDay();
}

/**
 * Wall-clock minutes since midnight, refreshed approximately every 30
 * seconds (§14). The timer is cleaned up correctly on unmount, and all
 * derived values recompute immediately on every input change via React
 * re-render. This hook is the single impure "current time" source; all
 * calculation functions receive `now` as a parameter.
 */
export function useNow(intervalMs = 30_000): MinutesOfDay {
  const [now, setNow] = useState<MinutesOfDay>(readNow);
  useEffect(() => {
    const id = window.setInterval(() => setNow(readNow()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
