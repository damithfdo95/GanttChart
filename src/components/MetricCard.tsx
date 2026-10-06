type Tone = 'default' | 'good' | 'bad';

interface MetricCardProps {
  label: string;
  value: string;
  tone?: Tone;
  /** One-sentence explanation of what the number means (tooltip). */
  hint?: string;
}

/** Compact readable numeric card (§26). Values arrive pre-formatted; never NaN/undefined (§25). */
export function MetricCard({ label, value, tone = 'default', hint }: MetricCardProps) {
  return (
    <div className={`metric-card tone-${tone}`} title={hint}>
      <div className="metric-card-label">
        {label}
        {hint ? <span className="hint-icon" aria-hidden="true">?</span> : null}
        {hint ? <span className="visually-hidden"> — {hint}</span> : null}
      </div>
      <div className="metric-card-value">{value}</div>
    </div>
  );
}
