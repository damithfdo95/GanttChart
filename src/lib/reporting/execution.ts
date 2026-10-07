import type { Cycle, Language, ProjectRecord, RcsMember, TesterProjectAssignment } from '../../types';
import { t, type TranslationKey } from '../../i18n';
import { assignedPeople, needsAttention, projectRiskSignals, todayMetrics, type RiskContext, type TodayMetrics } from '../../domain/qaMetrics';
import { entryForDate } from '../calculations/dailyExecuted';

/**
 * The "Execution Summary" of a daily report (Stage 8A): what was executed on the report date across the workspace, per project,
 * who worked on it, and what needs attention. Built only from the daily execution entries and assignments that already exist.
 * Project names, project IDs and release labels are never translated.
 */

export interface ExecutionReportRow {
  name: string;
  projectId: string;
  cycleName: string | null;
  executed: number;
  passed: number;
  failed: number;
  blocked: number;
  testers: string[];
}

export interface ExecutionReport {
  date: string;
  totals: TodayMetrics;
  rows: ExecutionReportRow[];
  /** Projects that need attention on that date, with the attention-level signal codes. */
  attention: Array<{ name: string; codes: string[] }>;
  testerNames: string[];
}

export interface ExecutionReportInput {
  date: string;
  projects: readonly ProjectRecord[];
  cycles: readonly Cycle[];
  assignments: readonly TesterProjectAssignment[];
  members: readonly RcsMember[];
  nowIso: string;
}

export function buildExecutionReport(input: ExecutionReportInput): ExecutionReport {
  const ctx: RiskContext = { today: input.date, nowIso: input.nowIso, assignments: input.assignments };
  const rows: ExecutionReportRow[] = [];
  const everyone = new Set<string>();
  for (const p of input.projects) {
    const entry = entryForDate(p.inputs.dailyExecuted ?? [], input.date);
    if (entry === null) continue;
    const people = assignedPeople(input.assignments, p.projectId, input.date, input.members)
      .map((x) => x.name)
      .filter((n) => n !== '');
    for (const n of people) everyone.add(n);
    rows.push({
      name: p.nameEn || p.nameJa || p.projectId,
      projectId: p.projectId,
      cycleName: p.cycleId === undefined || p.cycleId === null ? null : (input.cycles.find((c) => c.id === p.cycleId)?.name ?? null),
      executed: entry.pass + entry.fail,
      passed: entry.pass,
      failed: entry.fail,
      blocked: entry.blocked,
      testers: people,
    });
  }
  const attention = input.projects
    .filter((p) => p.status !== 'done')
    .map((p) => ({ name: p.nameEn || p.nameJa || p.projectId, signals: projectRiskSignals(p, ctx) }))
    .filter((x) => needsAttention(x.signals))
    .map((x) => ({ name: x.name, codes: x.signals.filter((s) => s.severity === 'attention').map((s) => s.code) }));
  return { date: input.date, totals: todayMetrics(input.projects, input.date), rows, attention, testerNames: [...everyone].sort() };
}

/** The text block for the report template's {execution_summary}. */
export function renderExecutionSummarySection(lang: Language, report: ExecutionReport): string {
  if (report.rows.length === 0) return t(lang, 'report.exec.none');
  const tot = report.totals;
  const lines: string[] = [t(lang, 'report.exec.totals', { executed: tot.executed, passed: tot.passed, failed: tot.failed, blocked: tot.blocked })];
  for (const r of report.rows) {
    const where = r.cycleName === null ? '' : ` [${r.cycleName}]`;
    lines.push(`- ${r.name}${where}: ${t(lang, 'report.exec.row', { executed: r.executed, passed: r.passed, failed: r.failed, blocked: r.blocked })}`);
  }
  if (report.testerNames.length > 0) lines.push(t(lang, 'report.exec.testers', { names: report.testerNames.join(', ') }));
  if (report.attention.length > 0) {
    lines.push('', t(lang, 'report.exec.attentionHeader'));
    for (const a of report.attention) lines.push(`- ${a.name}: ${a.codes.map((c) => t(lang, `report.exec.risk.${c}` as TranslationKey)).join(', ')}`);
  }
  return lines.join('\n');
}
