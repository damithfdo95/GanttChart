/**
 * Support outputs: the diagnostics summary and the feedback report. Both are PLAIN TEXT built from an explicit, small input - they never
 * read workspace content, so a project name, report body, test memo, ticket text, token or Authorization header cannot get into them by
 * accident. Nothing here sends anything anywhere: the text is copied by the person and pasted where they choose.
 */

export const FEEDBACK_CATEGORIES = ['bug', 'ux', 'missingWorkflow', 'performance', 'dataInconsistency', 'integration', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** English labels in the copied text (the text is pasted into tools whose language is not the UI's). */
export const FEEDBACK_CATEGORY_LABEL: Record<FeedbackCategory, string> = {
  bug: 'Bug',
  ux: 'UX issue',
  missingWorkflow: 'Missing workflow',
  performance: 'Performance',
  dataInconsistency: 'Data inconsistency',
  integration: 'Integration issue',
  other: 'Other',
};

export const FEEDBACK_LIMITS = { summary: 200, description: 4000, screen: 60, reporter: 80, projectId: 60 } as const;

// ---- redaction -------------------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)(bearer|basic|token)?\s*[A-Za-z0-9._~+/=-]{6,}/gi, '$1[redacted]'],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b(api[_ -]?key|api[_ -]?token|access[_ -]?token|token|secret|password|passwd|pat)\s*[:=]\s*\S+/gi, '$1: [redacted]'],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '[redacted-token]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted-key]'],
];

/** Obvious credentials in text the person typed or pasted are masked; everything else is left exactly as written. */
export function redactSecrets(text: string): string {
  return REDACTIONS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

const oneLine = (value: string, max: number): string => redactSecrets(value).replace(/\s+/g, ' ').trim().slice(0, max);

// ---- diagnostics -----------------------------------------------------------------------------------

export interface DiagnosticsInput {
  build: { version: string; commit: string; builtAt: string; channel: string; release: string };
  mode: 'local' | 'shared';
  /** The person's role in this app (never their email). */
  role: 'sv' | 'tester' | 'local';
  userAgent: string;
  storage: string;
  jira: 'configured' | 'notConfigured';
  testrail: 'configured' | 'notConfigured';
  /** Shared mode only: the connection state and last successful exchange (ms epoch). */
  sync: { status: string; pending: number; lastSyncedAt: number | null } | null;
  lastError: { requestId: string | null; code: string; at: string; status?: number } | null;
  /** Last time the AUTOMATIC daily backup ran on this device (ISO); manual exports are not recorded. */
  lastBackupAt: string | null;
  /** Whether the UI is in Japanese or English. */
  language: string;
  now: Date;
}

/** "Chrome 130 on Windows" - a family and major version, never the raw user-agent string. */
export function browserSummary(userAgent: string): string {
  const ua = userAgent ?? '';
  const pick = (re: RegExp): string | null => re.exec(ua)?.[1] ?? null;
  let family = 'Unknown browser';
  let version: string | null = null;
  if ((version = pick(/Edg\/(\d+)/))) family = 'Edge';
  else if ((version = pick(/(?:Chrome|CriOS)\/(\d+)/))) family = 'Chrome';
  else if ((version = pick(/(?:Firefox|FxiOS)\/(\d+)/))) family = 'Firefox';
  else if ((version = pick(/Version\/(\d+)[^ ]* Safari/))) family = 'Safari';
  const os = /Windows/i.test(ua) ? 'Windows' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Mac OS X|Macintosh/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'unknown OS';
  return `${family}${version === null ? '' : ` ${version}`} on ${os}`;
}

const yesNo = (state: 'configured' | 'notConfigured'): string => (state === 'configured' ? 'Configured' : 'Not configured');

/** The diagnostics summary: version, build, mode, integration state, sync state and the latest error id - and nothing else. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const b = input.build;
  const lines = [
    'GanttChart Diagnostics',
    `Generated: ${input.now.toISOString()}`,
    `Version: ${b.version}`,
    `Release: ${b.release === '' ? 'not tagged' : b.release}`,
    `Channel: ${b.channel}`,
    `Commit: ${b.commit === '' ? 'unknown' : b.commit}`,
    `Build: ${b.builtAt}`,
    `Mode: ${input.mode === 'shared' ? 'Shared workspace' : 'Local'}`,
    `Role: ${input.role === 'sv' ? 'SV' : input.role === 'tester' ? 'Tester' : 'Local user'}`,
    `Language: ${input.language}`,
    `Browser: ${browserSummary(input.userAgent)}`,
    `Storage: ${oneLine(input.storage, 60)}`,
    `JIRA: ${yesNo(input.jira)}`,
    `TestRail: ${yesNo(input.testrail)}`,
  ];
  if (input.sync !== null) {
    lines.push(`Sync: ${oneLine(input.sync.status, 30)}${input.sync.pending > 0 ? ` (${input.sync.pending} change(s) waiting)` : ''}`);
    lines.push(`Last successful sync: ${input.sync.lastSyncedAt === null ? 'none this session' : new Date(input.sync.lastSyncedAt).toISOString()}`);
  }
  lines.push(`Last automatic backup: ${input.lastBackupAt ?? 'not recorded'}`);
  lines.push(input.lastError === null ? 'Last Error ID: none this session' : `Last Error ID: ${input.lastError.requestId ?? 'none (client-side)'} · ${oneLine(input.lastError.code, 60)}${input.lastError.status === undefined ? '' : ` · HTTP ${input.lastError.status}`} · ${input.lastError.at}`);
  return `${lines.join('\n')}\n`;
}

// ---- feedback --------------------------------------------------------------------------------------

export interface FeedbackInput {
  category: FeedbackCategory;
  summary: string;
  description: string;
  /** Screen / context the person was on (free choice of a screen name). */
  screen: string;
  projectId?: string;
  /** Who is reporting - a display name the person may edit or clear. */
  reporter?: string;
  errorId?: string;
  build: { version: string; commit: string; channel: string };
  createdAt: Date;
}

export type FeedbackProblem = 'category' | 'summary';

/** A report needs a known category and a summary. */
export function feedbackProblems(input: Pick<FeedbackInput, 'category' | 'summary'>): FeedbackProblem[] {
  const out: FeedbackProblem[] = [];
  if (!(FEEDBACK_CATEGORIES as readonly string[]).includes(input.category)) out.push('category');
  if (input.summary.trim() === '') out.push('summary');
  return out;
}

/**
 * The structured text the person copies into GitHub / JIRA / chat. What they typed is kept as written (only obvious credentials are
 * masked and lengths bounded); version, commit and time are added; nothing is attached automatically.
 */
export function buildFeedbackReport(input: FeedbackInput): string {
  const description = redactSecrets(input.description).replace(/\r\n/g, '\n').trim().slice(0, FEEDBACK_LIMITS.description);
  const lines = [
    `Category: ${FEEDBACK_CATEGORY_LABEL[input.category] ?? 'Other'}`,
    `Screen: ${oneLine(input.screen, FEEDBACK_LIMITS.screen) || 'not specified'}`,
    `Version: ${input.build.version}`,
    `Commit: ${input.build.commit === '' ? 'unknown' : input.build.commit}`,
    `Channel: ${input.build.channel}`,
    `Reported: ${input.createdAt.toISOString()}`,
  ];
  if (input.projectId !== undefined && input.projectId.trim() !== '') lines.push(`Project: ${oneLine(input.projectId, FEEDBACK_LIMITS.projectId)}`);
  if (input.reporter !== undefined && input.reporter.trim() !== '') lines.push(`Reporter: ${oneLine(input.reporter, FEEDBACK_LIMITS.reporter)}`);
  if (input.errorId !== undefined && input.errorId.trim() !== '') lines.push(`Error ID: ${oneLine(input.errorId, 64)}`);
  lines.push(`Summary: ${oneLine(input.summary, FEEDBACK_LIMITS.summary)}`);
  lines.push('Description:', description === '' ? '(none)' : description);
  return `${lines.join('\n')}\n`;
}
