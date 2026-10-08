import { useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { useConfirm } from '../../components/ConfirmDialog';
import { t, type TranslationKey } from '../../i18n';
import { dictionaries } from '../../i18n/dictionaries';
import { businessClock } from '../../../shared/businessTime';
import { NOTIFICATION_LIMITS, RECURRENCES, nextOccurrence, type AudienceKind, type NotificationDef, type NotificationFields, type Recurrence } from '../../../shared/notifications';
import { ApiError } from '../../lib/tenancy/api';
import { isActiveMember, optionLabel } from '../../domain/teamMembers';
import { businessDate } from '../../../shared/businessTime';
import type { Language } from '../../types';

interface Draft {
  id: string | null;
  title: string;
  message: string;
  recurrence: Recurrence;
  time: string;
  weekdays: number[];
  dayOfMonth: string;
  month: string;
  day: string;
  audience: AudienceKind;
  memberIds: string[];
  enabled: boolean;
  startDate: string;
  endDate: string;
}

const EMPTY: Draft = { id: null, title: '', message: '', recurrence: 'daily', time: '09:00', weekdays: [1], dayOfMonth: '1', month: '4', day: '1', audience: 'all', memberIds: [], enabled: true, startDate: '', endDate: '' };

const draftFrom = (d: NotificationDef, copy = false): Draft => ({
  id: copy ? null : d.id,
  title: copy ? d.title : d.title,
  message: d.message,
  recurrence: d.recurrence,
  time: d.time,
  weekdays: d.weekdays ?? [1],
  dayOfMonth: String(d.dayOfMonth ?? 1),
  month: String(d.month ?? 4),
  day: String(d.day ?? 1),
  audience: d.audience.kind,
  memberIds: d.audience.memberIds ?? [],
  enabled: d.enabled,
  startDate: d.startDate ?? '',
  endDate: d.endDate ?? '',
});

function fieldsOf(d: Draft): NotificationFields {
  return {
    title: d.title.replace(/\s+/g, ' ').trim(),
    message: d.message.replace(/\r\n/g, '\n').trim(),
    recurrence: d.recurrence,
    time: d.time,
    ...(d.recurrence === 'weekly' ? { weekdays: [...d.weekdays].sort() } : {}),
    ...(d.recurrence === 'monthly' ? { dayOfMonth: Number(d.dayOfMonth) } : {}),
    ...(d.recurrence === 'yearly' ? { month: Number(d.month), day: Number(d.day) } : {}),
    audience: d.audience === 'members' ? { kind: 'members', memberIds: d.memberIds } : { kind: d.audience },
    enabled: d.enabled,
    ...(d.startDate === '' ? {} : { startDate: d.startDate }),
    ...(d.endDate === '' ? {} : { endDate: d.endDate }),
  };
}

/** The schedule in words (the one place that words a schedule). */
export function scheduleText(lang: Language, d: Pick<NotificationDef, 'recurrence' | 'time' | 'weekdays' | 'dayOfMonth' | 'month' | 'day'>): string {
  const time = d.time;
  switch (d.recurrence) {
    case 'daily':
      return t(lang, 'nt.sched.daily', { time });
    case 'weekly':
      return t(lang, 'nt.sched.weekly', { days: (d.weekdays ?? []).map((w) => t(lang, `nt.wd.${w}` as TranslationKey)).join(lang === 'ja' ? '・' : ', '), time });
    case 'monthly':
      return t(lang, 'nt.sched.monthly', { day: d.dayOfMonth ?? 1, time });
    case 'yearly':
      return t(lang, 'nt.sched.yearly', { month: d.month ?? 1, day: d.day ?? 1, time });
  }
}

export const audienceText = (lang: Language, a: NotificationDef['audience'], names: (id: string) => string): string =>
  a.kind === 'members' ? `${t(lang, 'nt.audience.members')}: ${(a.memberIds ?? []).map(names).join(', ')}` : t(lang, `nt.audience.${a.kind}` as TranslationKey);

/**
 * Settings -> Notifications (SV, Web storage). Definitions are saved through the server (which records who did it and writes the audit line);
 * acknowledgments are not shown here: only the schedule, who it addresses, whether it is on, and the next moment it falls due.
 */
export function NotificationsSettings() {
  const lang = useAppStateCtx().state.language;
  const reports = useReportsStateCtx();
  const { api, principal } = useTenant();
  const confirm = useConfirm();
  const defs = reports.state.notifications ?? [];
  const members = reports.state.rcsMembers ?? [];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const today = businessDate();
  const names = (id: string): string => {
    const m = members.find((x) => x.id === id);
    return m === undefined ? t(lang, 'people.former') : optionLabel(lang, m);
  };
  const preview = useMemo(() => {
    if (draft === null) return null;
    const stamp = '2026-01-01T00:00:00Z';
    const probe = { ...fieldsOf(draft), id: 'ntf_preview', createdAt: stamp, updatedAt: stamp, createdByUserId: 'u', updatedByUserId: 'u' } as NotificationDef;
    return nextOccurrence({ ...probe, enabled: true }, businessClock());
  }, [draft]);

  if (api === null || principal === null || !principal.sharedWorkspace || principal.role !== 'admin') {
    return (
      <section className="dr-section" aria-labelledby="nt-title">
        <h2 id="nt-title">{t(lang, 'nt.title')}</h2>
        <p className="tenancy-empty" role="note">
          {t(lang, 'nt.needsWeb')}
        </p>
      </section>
    );
  }

  const fail = (e: unknown): void => {
    const code = e instanceof ApiError ? e.code : 'error';
    const key = `nt.error.${code}` as TranslationKey;
    setMessage({ kind: 'error', text: key in dictionaries.en ? t(lang, key) : t(lang, 'nt.error.generic') });
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setBusy(true);
    setMessage(null);
    try {
      if (draft.id === null) await api.createNotification(fieldsOf(draft));
      else await api.updateNotification(draft.id, fieldsOf(draft));
      setDraft(null);
      setMessage({ kind: 'ok', text: t(lang, 'nt.saved') });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (d: NotificationDef): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const { id: _id, createdAt: _c, updatedAt: _u, createdByUserId: _cb, updatedByUserId: _ub, ...rest } = d;
      await api.updateNotification(d.id, { ...rest, enabled: !d.enabled });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: NotificationDef): Promise<void> => {
    const ok = await confirm({ title: t(lang, 'nt.deleteTitle', { title: d.title }), body: <p>{t(lang, 'nt.deleteBody')}</p>, confirmLabel: t(lang, 'nt.delete'), cancelLabel: t(lang, 'tenancy.cancel'), severity: 'warning' });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteNotification(d.id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const set = (patch: Partial<Draft>): void => setDraft((d) => (d === null ? d : { ...d, ...patch }));
  const activeMembers = members.filter((m) => isActiveMember(m, today)).sort((a, b) => a.name.localeCompare(b.name));
  const sorted = [...defs].sort((a, b) => a.title.localeCompare(b.title));

  return (
    <section className="dr-section" aria-labelledby="nt-title">
      <div className="dr-button-row">
        <h2 id="nt-title">{t(lang, 'nt.title')}</h2>
        <button type="button" className="btn btn-primary" onClick={() => { setDraft({ ...EMPTY }); setMessage(null); }}>
          {t(lang, 'nt.add')}
        </button>
      </div>
      <p className="dr-summary">{t(lang, 'nt.help')}</p>
      <div aria-live="polite">
        {message === null ? null : (
          <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </p>
        )}
      </div>

      {draft === null ? null : (
        <form className="tenancy-form nt-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <h3>{t(lang, draft.id === null ? 'nt.add' : 'nt.edit')}</h3>
          <label className="link-confirm">
            {t(lang, 'nt.f.title')}
            <input className="input" required maxLength={NOTIFICATION_LIMITS.title} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
          </label>
          <label className="link-confirm">
            {t(lang, 'nt.f.message')}
            <textarea className="input" rows={3} maxLength={NOTIFICATION_LIMITS.message} value={draft.message} onChange={(e) => set({ message: e.target.value })} />
          </label>
          <p className="link-help">{t(lang, 'nt.f.plainText')}</p>
          <label className="link-confirm">
            {t(lang, 'nt.f.recurrence')}
            <select className="input" value={draft.recurrence} onChange={(e) => set({ recurrence: e.target.value as Recurrence })}>
              {RECURRENCES.map((r) => (
                <option key={r} value={r}>
                  {t(lang, `nt.rec.${r}` as TranslationKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="link-confirm">
            {t(lang, 'nt.f.time')}
            <input className="input" type="time" required value={draft.time} onChange={(e) => set({ time: e.target.value })} />
          </label>
          {draft.recurrence === 'weekly' ? (
            <fieldset className="plain-fieldset">
              <legend>{t(lang, 'nt.f.weekdays')}</legend>
              {[1, 2, 3, 4, 5, 6, 7].map((w) => (
                <label key={w} className="tm-check">
                  <input type="checkbox" checked={draft.weekdays.includes(w)} onChange={(e) => set({ weekdays: e.target.checked ? [...draft.weekdays, w] : draft.weekdays.filter((x) => x !== w) })} /> {t(lang, `nt.wd.${w}` as TranslationKey)}
                </label>
              ))}
            </fieldset>
          ) : null}
          {draft.recurrence === 'monthly' ? (
            <>
              <label className="link-confirm">
                {t(lang, 'nt.f.dayOfMonth')}
                <input className="input" type="number" min={1} max={31} value={draft.dayOfMonth} onChange={(e) => set({ dayOfMonth: e.target.value })} />
              </label>
              <p className="link-help">{t(lang, 'nt.f.monthlyRule')}</p>
            </>
          ) : null}
          {draft.recurrence === 'yearly' ? (
            <>
              <label className="link-confirm">
                {t(lang, 'nt.f.month')}
                <select className="input" value={draft.month} onChange={(e) => set({ month: e.target.value })}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="link-confirm">
                {t(lang, 'nt.f.day')}
                <input className="input" type="number" min={1} max={31} value={draft.day} onChange={(e) => set({ day: e.target.value })} />
              </label>
              <p className="link-help">{t(lang, 'nt.f.yearlyRule')}</p>
            </>
          ) : null}
          <label className="link-confirm">
            {t(lang, 'nt.f.audience')}
            <select className="input" value={draft.audience} onChange={(e) => set({ audience: e.target.value as AudienceKind })}>
              {(['all', 'sv', 'testers', 'members'] as const).map((a) => (
                <option key={a} value={a}>
                  {t(lang, `nt.audience.${a}` as TranslationKey)}
                </option>
              ))}
            </select>
          </label>
          {draft.audience === 'members' ? (
            <fieldset className="plain-fieldset">
              <legend>{t(lang, 'nt.audience.members')}</legend>
              {activeMembers.map((m) => (
                <label key={m.id} className="tm-check">
                  <input type="checkbox" checked={draft.memberIds.includes(m.id)} onChange={(e) => set({ memberIds: e.target.checked ? [...draft.memberIds, m.id] : draft.memberIds.filter((x) => x !== m.id) })} /> {optionLabel(lang, m)}
                  {m.userId === undefined ? <small> ({t(lang, 'dir.noLoginYet')})</small> : null}
                </label>
              ))}
              <p className="link-help">{t(lang, 'nt.f.unlinkedNote')}</p>
            </fieldset>
          ) : null}
          <label className="link-confirm">
            {t(lang, 'nt.f.startDate')}
            <input className="input" type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
          </label>
          <label className="link-confirm">
            {t(lang, 'nt.f.endDate')}
            <input className="input" type="date" value={draft.endDate} onChange={(e) => set({ endDate: e.target.value })} />
          </label>
          <label className="tm-check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {t(lang, 'nt.enabled')}
          </label>
          <p className="link-help" role="status">
            {t(lang, 'nt.nextOccurrence')}: {preview === null ? t(lang, 'nt.none') : `${preview.date} ${preview.time}`}
          </p>
          <div className="dr-button-row">
            <button type="submit" className="btn btn-primary" disabled={busy || draft.title.trim() === ''}>
              {t(lang, 'dir.actions.save')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>
              {t(lang, 'tenancy.cancel')}
            </button>
          </div>
        </form>
      )}

      {sorted.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'nt.empty')}
        </p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'nt.title')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'nt.f.title')}</th>
                <th scope="col">{t(lang, 'nt.col.schedule')}</th>
                <th scope="col">{t(lang, 'nt.f.audience')}</th>
                <th scope="col">{t(lang, 'nt.col.status')}</th>
                <th scope="col">{t(lang, 'nt.nextOccurrence')}</th>
                <th scope="col">
                  <span className="sr-only">{t(lang, 'dir.colActions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const next = d.enabled ? nextOccurrence(d, businessClock()) : null;
                return (
                  <tr key={d.id} className={d.enabled ? undefined : 'tm-archived'}>
                    <th scope="row" className="tenancy-user-cell">
                      <strong>{d.title}</strong>
                    </th>
                    <td>{scheduleText(lang, d)}</td>
                    <td>{audienceText(lang, d.audience, names)}</td>
                    <td>
                      <span className={`status-badge status-${d.enabled ? 'active' : 'disabled'}`}>
                        <span aria-hidden="true">{d.enabled ? '● ' : '⏸ '}</span>
                        {t(lang, d.enabled ? 'nt.enabled' : 'nt.disabled')}
                      </span>
                    </td>
                    <td>{next === null ? '—' : `${next.date} ${next.time}`}</td>
                    <td className="dr-row-actions">
                      <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(draftFrom(d)); setMessage(null); }}>
                        {t(lang, 'nt.edit')}
                      </button>
                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void toggle(d)}>
                        {t(lang, d.enabled ? 'nt.disable' : 'nt.enable')}
                      </button>
                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setDraft({ ...draftFrom(d, true), title: `${d.title} (${t(lang, 'nt.copy')})` }); setMessage(null); }}>
                        {t(lang, 'nt.duplicate')}
                      </button>
                      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void remove(d)}>
                        {t(lang, 'nt.delete')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
