/** One formatted row of a recovery scenario table. */
export interface RecoveryRowData {
  key: string;
  /** First column: the change label (tester count, rate %, …). */
  label: string;
  testers: string;
  rate: string;
  capacity: string;
  projected: string;
  variance: string;
  tone: 'default' | 'good' | 'bad';
  statusLabel: string;
  recovered: boolean;
  isCurrent: boolean;
}

export interface RecoveryTableLabels {
  change: string;
  testers: string;
  rate: string;
  capacity: string;
  projected: string;
  variance: string;
  result: string;
}

interface RecoveryScenarioTableProps {
  title: string;
  labels: RecoveryTableLabels;
  rows: RecoveryRowData[];
  showTesters?: boolean;
  showRate?: boolean;
  showCapacity?: boolean;
}

/**
 * V6 §7/§11/§12: comparison table for evaluated recovery scenarios. Pure
 * presentation — every value arrives pre-formatted from the caller.
 */
export function RecoveryScenarioTable({
  title,
  labels,
  rows,
  showTesters = false,
  showRate = false,
  showCapacity = false,
}: RecoveryScenarioTableProps) {
  if (rows.length === 0) return null;
  return (
    <div className="recovery-table">
      <div className="recovery-table-title">{title}</div>
      <div className="table-wrap">
        <table className="dr-table">
          <thead>
            <tr>
              <th scope="col">{labels.change}</th>
              {showTesters ? <th scope="col" className="num">{labels.testers}</th> : null}
              {showRate ? <th scope="col" className="num">{labels.rate}</th> : null}
              {showCapacity ? <th scope="col" className="num">{labels.capacity}</th> : null}
              <th scope="col">{labels.projected}</th>
              <th scope="col" className="num">{labels.variance}</th>
              <th scope="col">{labels.result}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className={row.isCurrent ? 'completes' : undefined}>
                <td>{row.label}</td>
                {showTesters ? <td className="num">{row.testers}</td> : null}
                {showRate ? <td className="num">{row.rate}</td> : null}
                {showCapacity ? <td className="num">{row.capacity}</td> : null}
                <td>{row.projected}</td>
                <td className={`num tone-text-${row.tone}`}>{row.variance}</td>
                <td>
                  <span className={`ms-status ${row.recovered && !row.isCurrent ? 'reached' : row.tone === 'good' ? 'good' : row.tone === 'bad' ? 'overdue' : 'pending'}`}>
                    {row.statusLabel}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
