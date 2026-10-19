import { useState, type ReactNode } from 'react';
import { t } from '../i18n';
import type { Language } from '../types';

export interface ColumnDef {
  /** Stable column id (the visibility key). */
  id: string;
  /** Display label (already localized by the caller). */
  label: string;
  /** Locked columns cannot be hidden (e.g. the row-identifying column). */
  locked?: boolean;
}

interface ColumnVisibilityProps {
  lang: Language;
  /** Label of the toggle button (e.g. "Columns"). */
  buttonLabel: string;
  columns: readonly ColumnDef[];
  /** Currently hidden column ids. */
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Reset to all-visible. */
  onReset: () => void;
  /** Optional extra content at the bottom of the panel. */
  footer?: ReactNode;
}

/**
 * Column show/hide control (Planning / Meeting views): a small dropdown
 * (native <details>, so click-outside closes it and keyboard support comes
 * free) with one checkbox per column. Locked columns render disabled and
 * stay visible; the panel offers a one-click "show all" reset.
 */
export function ColumnVisibility({ lang, buttonLabel, columns, hidden, onToggle, onReset, footer }: ColumnVisibilityProps) {
  const [open, setOpen] = useState(false);
  const hideable = columns.filter((c) => !c.locked);
  const hiddenCount = hideable.filter((c) => hidden.has(c.id)).length;
  return (
    <details className="col-vis" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary
        className="btn btn-ghost col-vis-button"
        role="button"
        aria-haspopup="true"
        aria-expanded={open}
        title={buttonLabel}
      >
        <span aria-hidden="true">▤ </span>
        {buttonLabel}
        {hiddenCount > 0 ? <span className="col-vis-count">{hiddenCount}</span> : null}
      </summary>
      <div className="col-vis-panel" role="group" aria-label={buttonLabel}>
        {columns.map((column) => (
          <label key={column.id} className={column.locked === true ? 'col-vis-locked' : undefined}>
            <input
              type="checkbox"
              checked={!hidden.has(column.id)}
              disabled={column.locked === true}
              onChange={() => onToggle(column.id)}
            />
            {column.label}
          </label>
        ))}
        {hideable.some((c) => hidden.has(c.id)) ? (
          <button type="button" className="btn btn-ghost col-vis-reset" onClick={onReset}>
            {t(lang, 'common.showAll')}
          </button>
        ) : null}
        {footer}
      </div>
    </details>
  );
}
