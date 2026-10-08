import { t, type TranslationKey } from '../../i18n';
import { useAppStateCtx } from '../../app/state-contexts';
import { useDueNotifications } from './useNotifications';

/**
 * Due notifications, persistent until the person closes THEIR occurrence. Plain text only (never HTML). Each shows its title, message and the
 * moment it was scheduled for; Close saves the acknowledgment on the server and, if that fails, the notification stays with the reason and a
 * retry. Words and a symbol, never colour alone; reachable and operable by keyboard.
 */
export function NotificationBanner() {
  const lang = useAppStateCtx().state.language;
  const { items, acknowledge, state } = useDueNotifications();
  if (items.length === 0) return null;
  return (
    <section className="nt-banner" role="region" aria-label={t(lang, 'nt.region')}>
      <ul>
        {items.map((item) => {
          const key = `${item.def.id}\u0000${item.occurrence.key}`;
          const st = state[key] ?? { kind: 'idle' as const };
          return (
            <li key={key} className="nt-item">
              <div className="nt-body">
                <strong>
                  <span aria-hidden="true">🔔 </span>
                  <span className="sr-only">{t(lang, 'nt.notification')}: </span>
                  {item.def.title}
                </strong>
                {item.def.message === '' ? null : <p className="nt-message">{item.def.message}</p>}
                <small className="link-help">{t(lang, 'nt.scheduledFor', { when: `${item.occurrence.date} ${item.occurrence.time}` })}</small>
                {st.kind === 'error' ? (
                  <p role="alert" className="data-controls-message error">
                    {t(lang, 'nt.ackFailed')}
                  </p>
                ) : null}
              </div>
              <button type="button" className="btn btn-primary" disabled={st.kind === 'working'} onClick={() => void acknowledge(item)}>
                {t(lang, st.kind === 'error' ? ('nt.retry' as TranslationKey) : 'nt.close')}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
