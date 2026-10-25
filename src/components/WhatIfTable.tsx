import { formatClock, formatDuration, formatInteger } from '../lib/formatting/format';
import type { Language } from '../types';
import { CollapsibleSection } from './CollapsibleSection';

export interface WhatIfRow {
  testers: number;
  hourlyCapacity: number;
  requiredMinutes: number | null;
  expectedFinish: number | null;
}

export interface WhatIfLabels {
  title: string;
  hint: string;
  testers: string;
  hourlyCapacity: string;
  requiredTime: string;
  expectedFinish: string;
  currentTag: string;
  more: string;
  fewer: string;
}

interface WhatIfTableProps {
  rows: WhatIfRow[];
  currentTesters: number;
  /** The row being explored (local preview state); null = none. Never the project's Current Testers. */
  selectedTesters?: number | null;
  onSelect: (testers: number) => void;
  labels: WhatIfLabels;
  lang?: Language;
  onMore?: () => void;
  onFewer?: () => void;
}

/**
 * What-if tester planning table (§19). The currently selected tester count is
 * tagged; clicking a row only previews that count (highlight) and never changes Current Testers. The
 * table shows 10 tester rows by default; onMore/onFewer let the user extend
 * or reduce the visible range.
 */
export function WhatIfTable({ rows, currentTesters, selectedTesters = null, onSelect, labels, lang, onMore, onFewer }: WhatIfTableProps) {
  return (
    <CollapsibleSection title={labels.title} subtitle={labels.hint} defaultOpen>
      <div className="table-wrap">
        <table className="whatif-table">
          <thead>
            <tr>
              <th scope="col" className="num">{labels.testers}</th>
              <th scope="col" className="num">{labels.hourlyCapacity}</th>
              <th scope="col" className="num">{labels.requiredTime}</th>
              <th scope="col" className="num">{labels.expectedFinish}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.testers}
                className={row.testers === selectedTesters ? 'selected' : undefined}
                onClick={() => onSelect(row.testers)}
              >
                <td className="num">
                  <button
                    type="button"
                    className="whatif-select"
                    aria-pressed={row.testers === selectedTesters}
                    onClick={() => onSelect(row.testers)}
                  >
                    {row.testers}
                    {row.testers === currentTesters ? <span className="whatif-current"> ({labels.currentTag})</span> : null}
                  </button>
                </td>
                <td className="num">{formatInteger(row.hourlyCapacity, lang)}</td>
                <td className="num">{formatDuration(row.requiredMinutes)}</td>
                <td className="num">{formatClock(row.expectedFinish)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {onMore !== undefined || onFewer !== undefined ? (
        <div className="whatif-controls">
          {onFewer !== undefined ? (
            <button type="button" className="btn btn-ghost" onClick={onFewer}>
              −5 {labels.fewer}
            </button>
          ) : null}
          {onMore !== undefined ? (
            <button type="button" className="btn btn-ghost" onClick={onMore}>
              +5 {labels.more}
            </button>
          ) : null}
        </div>
      ) : null}
    </CollapsibleSection>
  );
}
