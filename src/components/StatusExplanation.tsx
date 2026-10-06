import type { StatusFact } from './StatusCard';

interface StatusExplanationProps {
  title: string;
  facts: StatusFact[];
}

/**
 * Level 2 §6: expandable status explanation. The status is never shown as a
 * bare color — opening the panel reveals the underlying numbers, all
 * produced by the existing calculation engine.
 */
export function StatusExplanation({ title, facts }: StatusExplanationProps) {
  return (
    <details className="status-explanation">
      <summary>{title}</summary>
      <div className="status-explanation-facts">
        {facts.map((fact) => (
          <div key={fact.label} className="status-fact">
            <span className="status-fact-label">
              {fact.label}
              {fact.hint ? <span className="hint-icon" aria-hidden="true">?</span> : null}
              {fact.hint ? <span className="visually-hidden"> — {fact.hint}</span> : null}
            </span>
            <span className="status-fact-value">{fact.value}</span>
          </div>
        ))}
      </div>
    </details>
  );
}
