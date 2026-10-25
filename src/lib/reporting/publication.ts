import type { DailyReport } from '../../types';
import { isPublished, publicationStatusOf, reportPublicationError, type ReportPublicationMethod } from '../../../shared/reportPublication';

/**
 * Delivery of a FINALIZED Daily Report: pure formatters, the publish transition, and the clipboard helper. Nothing here reads live
 * workspace data (a delivered report is the frozen finalized text), calls the network, or adds anything the report does not say.
 * The report keeps its own stored language, so the UI language never changes what is copied.
 */

/** A finalized report split into the structure all three renderings share: lines before the first section, then "■ Heading" sections. */
export interface ReportDocument {
  date: string;
  language: DailyReport['language'];
  preamble: string[];
  sections: Array<{ heading: string; lines: string[] }>;
}

const HEADING = /^■\s*(.*)$/;

function normalizedLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  while (lines.length > 0 && lines[0] === '') lines.shift();
  return lines;
}

/** The structured source of the delivered report: only a FINALIZED report has one (a draft is not a deliverable). */
export function reportDocument(report: DailyReport): ReportDocument {
  const doc: ReportDocument = { date: report.reportDate, language: report.language, preamble: [], sections: [] };
  if (report.status !== 'FINALIZED') return doc;
  for (const line of normalizedLines(report.previewText)) {
    const heading = HEADING.exec(line);
    if (heading !== null) doc.sections.push({ heading: (heading[1] ?? '').trim(), lines: [] });
    else (doc.sections[doc.sections.length - 1]?.lines ?? doc.preamble).push(line);
  }
  return doc;
}

function trimBlank(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end);
}

/** The finalized text exactly as the supervisor saw it (manual edits included): line endings and trailing spaces normalised, nothing added. */
export function formatDailyReportPlainText(report: DailyReport): string {
  const doc = reportDocument(report);
  const out: string[] = [...doc.preamble];
  for (const section of doc.sections) out.push(`■ ${section.heading}`, ...section.lines);
  const text = out.join('\n');
  return text === '' ? '' : `${text}\n`;
}

/**
 * The same content for pasting into a chat message: portable plain characters only (no Slack or Teams markup, no HTML). Sections are
 * separated by one blank line, "- " list items become "• " bullets, and runs of blank lines collapse. Wording is never changed.
 */
export function formatDailyReportChatText(report: DailyReport): string {
  const doc = reportDocument(report);
  const bullet = (line: string): string => (line.startsWith('- ') ? `• ${line.slice(2)}` : line);
  const squeeze = (lines: string[]): string[] => lines.filter((line, i) => !(line === '' && lines[i - 1] === ''));
  const blocks: string[] = [];
  const preamble = trimBlank(squeeze(doc.preamble.map(bullet))).join('\n');
  if (preamble !== '') blocks.push(preamble);
  for (const section of doc.sections) {
    const body = trimBlank(squeeze(section.lines.map(bullet))).join('\n');
    blocks.push(body === '' ? `■ ${section.heading}` : `■ ${section.heading}\n${body}`);
  }
  const text = blocks.join('\n\n');
  return text === '' ? '' : `${text}\n`;
}

/** Deterministic, ASCII-safe download name: Daily-Report-2026-10-25.txt (a malformed date never reaches a file name). */
export function dailyReportFileName(report: Pick<DailyReport, 'reportDate'>, extension = 'txt'): string {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(report.reportDate) ? report.reportDate : 'unknown-date';
  return `Daily-Report-${date}.${extension.replace(/[^A-Za-z0-9]/g, '')}`;
}

// ---- publishing ---------------------------------------------------------------------------------

/** Only a finalized, not-yet-published report can be published, and only by someone who manages reports (never a Tester). */
export function canPublishReport(report: DailyReport, canManage: boolean): boolean {
  return canManage && report.status === 'FINALIZED' && publicationStatusOf(report) === 'notPublished';
}

export interface PublishActor {
  userId: string | null;
  memberId: string | null;
}

/**
 * Mark a finalized report as published. Changes only the publication metadata (plus the touch time): the text, activities, staffing,
 * topics, snapshot and date are the very same values. A draft is returned untouched, and an already published report keeps its first
 * publication - a later copy, print or export never re-stamps it.
 */
export function markReportPublished(report: DailyReport, actor: PublishActor, method: ReportPublicationMethod, nowIso: string): DailyReport {
  if (report.status !== 'FINALIZED' || isPublished(report)) return report;
  const next: DailyReport = {
    ...report,
    publicationStatus: 'published',
    publishedAt: nowIso,
    publicationMethod: method,
    updatedAt: nowIso,
  };
  if (actor.userId !== null) next.publishedByUserId = actor.userId;
  if (actor.memberId !== null) next.publishedByMemberId = actor.memberId;
  // Never produce a record the server would refuse (a malformed actor id is dropped rather than stored).
  if (reportPublicationError(next) === 'report_publication_invalid_actor') {
    delete next.publishedByUserId;
    delete next.publishedByMemberId;
  }
  return next;
}

/**
 * Self-healing load rule: publication metadata that fails the shared rules (or sits on a draft) is dropped, so the report reads as
 * Not Published instead of locking anything. Reports without publication fields are returned as they are.
 */
export function sanitizeReportPublication<T extends DailyReport>(report: T): T {
  if (reportPublicationError(report) === null) return report;
  const { publicationStatus: _s, publishedAt: _a, publishedByUserId: _u, publishedByMemberId: _m, publicationMethod: _p, ...rest } = report;
  return rest as T;
}

// ---- clipboard ----------------------------------------------------------------------------------

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

export type CopyResult = { ok: true } | { ok: false; fallbackText: string };

/**
 * Copy text with a visible fallback: when the clipboard is missing or refuses (insecure context, denied permission), the caller gets
 * the text back to show in a selectable box so the supervisor can still copy it by hand. Never throws.
 */
export async function copyWithFallback(text: string, clipboard: ClipboardLike | undefined): Promise<CopyResult> {
  if (clipboard === undefined) return { ok: false, fallbackText: text };
  try {
    await clipboard.writeText(text);
    return { ok: true };
  } catch {
    return { ok: false, fallbackText: text };
  }
}
