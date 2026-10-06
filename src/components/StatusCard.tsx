import type { ScheduleStatus } from '../types';
import type { PortfolioVerdict } from '../domain/projects/selectors';

const STATUS_CLASS: Record<ScheduleStatus, string> = {
  NOT_STARTED: 'not-started',
  ON_SCHEDULE: 'on-schedule',
  AHEAD: 'ahead',
  DELAYED: 'delayed',
  COMPLETED: 'completed',
};

/** Worst-case portfolio verdict → the same visual tones as the project card. */
const PORTFOLIO_CLASS: Record<PortfolioVerdict, string> = {
  onTrack: 'on-schedule',
  atRisk: 'delayed',
  capacityShortage: 'delayed',
  overdue: 'delayed',
  completed: 'completed',
  noProjects: 'free',
};

export interface StatusFact {
  label: string;
  value: string;
  /** Optional one-sentence explanation of what the value means (tooltip). */
  hint?: string;
}

function StatusFacts({ facts }: { facts: StatusFact[] }) {
  return (
    <div className="status-card-facts">
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
  );
}

interface StatusCardProps {
  status: ScheduleStatus;
  statusLabel: string;
  facts: StatusFact[];
}

/**
 * Prominent schedule health card (§17).
 * Colors: green = ON SCHEDULE, blue = AHEAD, red = DELAYED,
 * neutral/success = COMPLETED, gray = NOT STARTED.
 */
export function StatusCard({ status, statusLabel, facts }: StatusCardProps) {
  return (
    <section className={`status-card ${STATUS_CLASS[status]}`}>
      <div className="status-card-badge">{statusLabel}</div>
      <StatusFacts facts={facts} />
    </section>
  );
}

interface PortfolioStatusCardProps {
  verdict: PortfolioVerdict;
  verdictLabel: string;
  facts: StatusFact[];
}

/**
 * Portfolio (group) status card for the Overall screen: the worst-case
 * verdict over a group of projects with aggregated facts (project count,
 * latest planned finish, earliest deadline, worst buffer). Uses the same
 * visual language as the per-project card; an empty group renders the
 * neutral "No projects" state.
 */
export function PortfolioStatusCard({ verdict, verdictLabel, facts }: PortfolioStatusCardProps) {
  return (
    <section className={`status-card ${PORTFOLIO_CLASS[verdict]}`}>
      <div className="status-card-badge">{verdictLabel}</div>
      {facts.length > 0 ? <StatusFacts facts={facts} /> : null}
    </section>
  );
}

interface FreeStatusCardProps {
  /** Localized "Free" label (shown when the active project is not In Progress). */
  label: string;
}

/**
 * Free state of the schedule card: the active project's lifecycle status is
 * not In Progress, so the schedule calculation is hidden and a single
 * neutral "Free" verdict is shown instead.
 */
export function FreeStatusCard({ label }: FreeStatusCardProps) {
  return (
    <section className="status-card free">
      <div className="status-card-badge">{label}</div>
    </section>
  );
}
