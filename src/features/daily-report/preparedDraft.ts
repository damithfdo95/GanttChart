import { t, type TranslationKey } from '../../i18n';
import { generateId } from '../../lib/id';
import { renderActivitiesSection, renderStaffingLine } from '../../lib/reporting/sections';
import { readinessReasonText } from '../readiness/readinessText';
import type { PreparedDailyReportDraft, PreparedTopic } from '../../domain/dailyReportDraft';
import type { DailyTopic, Language } from '../../types';

/** The sentence of a prepared topic in the report language (the domain carries only structure). */
export function preparedTopicText(lang: Language, topic: PreparedTopic): string {
  if (topic.source.kind === 'readiness') return readinessReasonText(lang, topic.source.reason);
  return t(lang, topic.source.kind === 'dayFailures' ? 'draft.topic.dayFailures' : 'draft.topic.dayBlocked', { project: topic.projectName, n: topic.source.count });
}

/** One preview line: readiness reasons are prefixed with their project (day facts already name it). */
export function preparedTopicLine(lang: Language, topic: PreparedTopic): string {
  return topic.source.kind === 'readiness' ? `${topic.projectName} — ${preparedTopicText(lang, topic)}` : preparedTopicText(lang, topic);
}

/** The prepared topics as report Topic records (title = project, description = the fact). Order continues after `startOrder`. */
export function preparedTopicsAsRecords(lang: Language, topics: readonly PreparedTopic[], date: string, createdBy: string, nowIso: string, startOrder: number): DailyTopic[] {
  return topics.map((topic, i) => ({
    id: generateId(),
    reportDate: date,
    title: topic.projectName,
    description: preparedTopicText(lang, topic),
    displayOrder: startOrder + i,
    createdBy,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
}

/** Exactly what the draft will put into the report, as the report text blocks (for the preview panels). */
export function preparedDraftPreview(lang: Language, draft: PreparedDailyReportDraft): { staffing: string; activities: string; topics: string[] } {
  return { staffing: renderStaffingLine(lang, draft.staffing), activities: renderActivitiesSection(lang, draft.activities), topics: draft.topics.map((x) => preparedTopicLine(lang, x)) };
}

export const MISSING_KEY: Record<'noActivity' | 'noStaffing' | 'noTopics', TranslationKey> = {
  noActivity: 'dailyReport.prepare.missing.noActivity',
  noStaffing: 'dailyReport.prepare.missing.noStaffing',
  noTopics: 'dailyReport.prepare.missing.noTopics',
};
