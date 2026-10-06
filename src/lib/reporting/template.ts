import type { Language } from '../../types';

/**
 * Default SPO daily report templates. The template is plain user-editable
 * text with {placeholders} — never hardcoded inside a React component.
 * Sections in the same order for both languages; custom templates can be
 * set from the Settings screen.
 */
export const DEFAULT_REPORT_TEMPLATES: Record<Language, string> = {
  en: [
    "Hello,",
    '',
    "Today's daily report has been prepared. Please review it when convenient.",
    '',
    'Today, verification is being conducted for:',
    '{active_test_names}',
    '',
    'Please review and react if there are no issues.',
    '',
    '■ Attendance',
    '{attendance}',
    '',
    "■ Today's Activities",
    '{activities}',
    '',
    "■ Today's Topics",
    '{topics}',
    '',
    '■ Progress Report',
    '{progress}',
    '',
    'Please refer here for the status of all JIRA tickets.',
    '{jira_url}',
    '',
    '■ Next Business Day',
    '{next_business_day}',
  ].join('\n'),
  ja: [
    'お疲れ様です。',
    '本日の日報を作成いたしましたので、お手隙の際にご確認をお願いいたします。',
    '',
    '本日は',
    '{active_test_names}',
    'の検証を進めている旨を記載しております。',
    '',
    'ご確認いただき、問題がなければリアクションをお願いいたします。',
    '',
    '■ Attendance',
    '{attendance}',
    '',
    "■ Today's Activities",
    '{activities}',
    '',
    "■ Today's Topics",
    '{topics}',
    '',
    '■ Progress Report',
    '{progress}',
    '',
    '※ JIRAチケットのステータスについてはこちらをご参照ください。',
    '{jira_url}',
    '',
    '■ Next Business Day',
    '{next_business_day}',
  ].join('\n'),
};

/** Fill the template's {placeholders}; unknown placeholders are preserved. */
export function renderReport(template: string, sections: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in sections ? sections[name] : match));
}
