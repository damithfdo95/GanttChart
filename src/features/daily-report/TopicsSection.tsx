import type { DailyTopic, Language } from '../../types';
import { t } from '../../i18n';

interface TopicsSectionProps {
  topics: DailyTopic[];
  lang: Language;
  readOnly?: boolean;
  onChange: (topics: DailyTopic[]) => void;
}

/** Today's Topics editor — free-text, multiline updates. */
export function TopicsSection({ topics, lang, readOnly, onChange }: TopicsSectionProps) {
  const update = (id: string, patch: Partial<DailyTopic>): void => {
    onChange(
      topics.map((topic) => (topic.id === id ? { ...topic, ...patch, updatedAt: new Date().toISOString() } : topic)),
    );
  };
  const move = (index: number, delta: number): void => {
    const next = [...topics];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next.map((topic, i) => ({ ...topic, displayOrder: i })));
  };

  return (
    <section className="dr-section">
      <h2>{t(lang, 'dailyReport.topicsSection')}</h2>
      {topics.length === 0 ? <p className="dr-empty">{t(lang, 'dailyReport.noTopics')}</p> : null}
      <div className="dr-topics">
        {topics.map((topic, index) => (
          <div key={topic.id} className="dr-topic">
            <div className="dr-topic-head">
              <input
                className="table-input"
                type="text"
                aria-label={`${t(lang, 'dailyReport.topicTitle')} (${topic.title === '' ? index + 1 : topic.title})`}
                value={topic.title}
                onChange={(e) => update(topic.id, { title: e.target.value })}
              />
              {readOnly !== true ? (
                <span className="dr-row-actions">
                  <button
                    type="button"
                    className="btn-icon"
                    title={t(lang, 'buttons.moveUp')}
                    aria-label={`${t(lang, 'buttons.moveUp')}: ${topic.title === '' ? index + 1 : topic.title}`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    title={t(lang, 'buttons.moveDown')}
                    aria-label={`${t(lang, 'buttons.moveDown')}: ${topic.title === '' ? index + 1 : topic.title}`}
                    disabled={index === topics.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn-row-remove"
                    title={t(lang, 'buttons.remove')}
                    aria-label={`${t(lang, 'buttons.remove')}: ${topic.title === '' ? index + 1 : topic.title}`}
                    onClick={() => onChange(topics.filter((tp) => tp.id !== topic.id))}
                  >
                    ×
                  </button>
                </span>
              ) : null}
            </div>
            <textarea
              className="dr-textarea"
              rows={3}
              aria-label={`${t(lang, 'dailyReport.topicDescription')} (${topic.title === '' ? index + 1 : topic.title})`}
              value={topic.description}
              onChange={(e) => update(topic.id, { description: e.target.value })}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
