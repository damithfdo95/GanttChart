import { useState } from 'react';
import type { Language, NextDayItem } from '../../types';
import { t } from '../../i18n';
import { generateId } from '../../lib/id';

interface MorningScheduleSectionProps {
  lang: Language;
  suggestions: string[];
  items: NextDayItem[];
  readOnly?: boolean;
  onChange: (items: NextDayItem[]) => void;
}

/** Today's schedule for the morning report: suggestions + supervisor-managed ordered items. */
export function MorningScheduleSection({ lang, suggestions, items, readOnly, onChange }: MorningScheduleSectionProps) {
  const [manualText, setManualText] = useState('');
  const [composing, setComposing] = useState(false);

  const addManual = (): void => {
    const text = manualText.trim();
    if (text === '') return;
    onChange([...items, { id: generateId(), text, source: 'MANUAL' }]);
    setManualText('');
  };

  const move = (index: number, delta: number): void => {
    const next = [...items];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <section className="dr-section">
      <h2>{t(lang, 'dailyReport.morningScheduleSection')}</h2>
      <p className="dr-summary">{t(lang, 'dailyReport.morningScheduleHint')}</p>
      {items.length === 0 ? <p className="dr-empty">{t(lang, 'dailyReport.noItems')}</p> : null}
      <ol className="dr-nextday-list">
        {items.map((item, index) => (
          <li key={item.id} className={item.source === 'SUGGESTED' || item.source === 'AUTO' ? 'dr-suggested' : undefined}>
            <span>　・{item.text}</span>
            {readOnly !== true ? (
              <span className="dr-row-actions">
                <button
                  type="button"
                  className="btn-icon"
                  title={t(lang, 'buttons.moveUp')}
                  aria-label={`${t(lang, 'buttons.moveUp')}: ${item.text}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  title={t(lang, 'buttons.moveDown')}
                  aria-label={`${t(lang, 'buttons.moveDown')}: ${item.text}`}
                  disabled={index === items.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn-row-remove"
                  title={t(lang, 'buttons.remove')}
                  aria-label={`${t(lang, 'buttons.remove')}: ${item.text}`}
                  onClick={() => onChange(items.filter((i) => i.id !== item.id))}
                >
                  ×
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ol>
      {readOnly !== true && (
        <div className="dr-suggestion-row">
          <span className="dr-suggestion-label">{t(lang, 'dailyReport.suggestions')}:</span>
          {suggestions.map((suggestion) => {
            const alreadyAdded = items.some((item) => item.text === suggestion);
            return (
              <button
                key={suggestion}
                type="button"
                className="btn btn-ghost"
                disabled={alreadyAdded}
                title={alreadyAdded ? t(lang, 'dailyReport.suggestionAdded') : undefined}
                onClick={() => onChange([...items, { id: generateId(), text: suggestion, source: 'AUTO' }])}
              >
                + {suggestion}
              </button>
            );
          })}
          <span className="dr-manual-add">
            <input
              className="table-input"
              type="text"
              aria-label={t(lang, 'dailyReport.newItemPlaceholder')}
              value={manualText}
              placeholder={t(lang, 'dailyReport.newItemPlaceholder')}
              onChange={(e) => setManualText(e.target.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={() => setComposing(false)}
              onKeyDown={(e) => {
                // Never commit while a Japanese IME composition is active.
                if (e.key === 'Enter' && !composing) addManual();
              }}
            />
            <button type="button" className="btn" onClick={addManual}>
              {t(lang, 'buttons.add')}
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
