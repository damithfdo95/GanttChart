import { describe, expect, it } from 'vitest';
import {
  calculateActivityProgress,
  formatPercent,
  percentRatio,
  DEFAULT_PROGRESS_RULES,
} from '../lib/reporting/progress';
import {
  buildNextDaySuggestions,
  isBusinessDay,
  nextBusinessDay,
} from '../lib/reporting/nextday';
import {
  buildReportSections,
  formatDueDateShort,
  isAttending,
  renderActivitiesSection,
  renderAttendanceSection,
  renderNextDaySection,
  renderProgressSection,
  renderTopicsSection,
} from '../lib/reporting/sections';
import { DEFAULT_REPORT_TEMPLATES, renderReport } from '../lib/reporting/template';
import type { AttendanceRecord, DailyTopic, ReportActivity, RcsMember } from '../types';

function activity(overrides: Partial<ReportActivity>): ReportActivity {
  return {
    id: 'a1',
    source: 'MANUAL',
    name: 'Test',
    memberCount: 1,
    completedCases: 0,
    workingStatus: 'Working',
    included: true,
    totalCases: 0,
    workingEligibleCases: 0,
    startedCases: 0,
    blockedCases: 0,
    notApplicableCases: 0,
    dueDate: null,
    ...overrides,
  };
}

function attendance(overrides: Partial<AttendanceRecord>): AttendanceRecord {
  return {
    id: 'r1',
    date: '2026-09-17',
    memberName: 'Tester',
    team: 'PrV',
    status: 'PRESENT',
    workingStart: '09:00',
    workingEnd: '17:30',
    leaveType: null,
    comment: '',
    ...overrides,
  };
}

describe('calculateActivityProgress', () => {
  it('uses independent denominators for Working and Complete by default', () => {
    const a = activity({ totalCases: 100, workingEligibleCases: 80, startedCases: 60, completedCases: 50 });
    const p = calculateActivityProgress(a, DEFAULT_PROGRESS_RULES);
    expect(p.workingPct).toBeCloseTo(75, 10);
    expect(p.workingCount).toBe(60);
    expect(p.workingDenom).toBe(80);
    expect(p.completePct).toBeCloseTo(50, 10);
    expect(p.completeCount).toBe(50);
    expect(p.completeDenom).toBe(100);
  });

  it('supports configurable denominator rules', () => {
    const a = activity({ totalCases: 100, workingEligibleCases: 80, startedCases: 40, completedCases: 20 });
    const p = calculateActivityProgress(a, { working: 'totalCases', complete: 'workingEligibleCases' });
    expect(p.workingPct).toBeCloseTo(40, 10);
    expect(p.workingDenom).toBe(100);
    expect(p.completePct).toBeCloseTo(25, 10);
    expect(p.completeDenom).toBe(80);
  });

  it('returns null percentages for zero denominators', () => {
    const p = calculateActivityProgress(activity({ totalCases: 0, workingEligibleCases: 0 }), DEFAULT_PROGRESS_RULES);
    expect(p.workingPct).toBeNull();
    expect(p.completePct).toBeNull();
  });

  it('formats percentages with two decimals', () => {
    expect(formatPercent(86.48648)).toBe('86.49');
    expect(formatPercent(null)).toBe('—');
    expect(percentRatio(86.49)).toBeCloseTo(0.8649, 10);
  });
});

describe('business days', () => {
  it('treats weekends as non-business days', () => {
    expect(isBusinessDay('2026-09-18', [])).toBe(true); // Friday
    expect(isBusinessDay('2026-09-19', [])).toBe(false); // Saturday
    expect(isBusinessDay('2026-09-20', [])).toBe(false); // Sunday
  });

  it('honors the configured holiday list', () => {
    expect(isBusinessDay('2026-09-18', ['2026-09-18'])).toBe(false);
  });

  it('skips weekends to the next business day', () => {
    expect(nextBusinessDay('2026-11-06', [])).toBe('2026-11-09'); // Fri → Mon
  });

  it('skips Japanese public holidays too (Sep 21–23, 2026)', () => {
    // Respect for the Aged Day (Mon), the sandwich day (Tue) and the
    // autumnal equinox (Wed) form a three-day holiday block.
    expect(nextBusinessDay('2026-09-18', [])).toBe('2026-09-24');
    expect(isBusinessDay('2026-09-21', [])).toBe(false);
    expect(isBusinessDay('2026-09-22', [])).toBe(false);
    expect(isBusinessDay('2026-09-23', [])).toBe(false);
  });

  it('skips holidays and weekends together', () => {
    expect(nextBusinessDay('2026-11-06', ['2026-11-09'])).toBe('2026-11-10');
  });
});

describe('next-day suggestions', () => {
  it('builds suggestions from remaining work and capacity risk', () => {
    const suggestions = buildNextDaySuggestions('en', {
      projectName: 'Android Sanity',
      remainingCases: 143,
      shortageByDeadline: 56,
      nextBusinessDate: '2026-09-21',
      scheduledTesters: 8,
    });
    expect(suggestions).toHaveLength(3);
    expect(suggestions[0]).toContain('Android Sanity');
    expect(suggestions[0]).toContain('143');
    expect(suggestions[1]).toContain('56');
    expect(suggestions[2]).toContain('8');
  });

  it('renders suggestions in Japanese', () => {
    const suggestions = buildNextDaySuggestions('ja', {
      projectName: 'Sanityテスト',
      remainingCases: 10,
      shortageByDeadline: null,
      nextBusinessDate: '2026-09-21',
      scheduledTesters: null,
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toBe('Sanityテストの続き（残り10ケース）');
  });
});

describe('attendance rendering', () => {
  it('counts Present/Late/Half Day as attending', () => {
    expect(isAttending('PRESENT')).toBe(true);
    expect(isAttending('LATE')).toBe(true);
    expect(isAttending('HALF_DAY')).toBe(true);
    expect(isAttending('ABSENT')).toBe(false);
    expect(isAttending('PAID_LEAVE')).toBe(false);
    expect(isAttending('OTHER')).toBe(false);
  });

  it('renders a single overall x/y summary line in both languages (team display removed)', () => {
    const records = [
      attendance({ id: '1', team: 'PrV', status: 'PRESENT' }),
      attendance({ id: '2', team: 'PrV', status: 'LATE' }),
      attendance({ id: '3', team: 'RCS', status: 'PRESENT' }),
      attendance({ id: '4', team: 'RCS', status: 'PAID_LEAVE' }),
    ];
    expect(renderAttendanceSection('en', records)).toBe('3/4 members attending');
    expect(renderAttendanceSection('ja', records)).toBe('3/4名出席中');
  });

  it('absence-only input: no records = everyone attending (roster totals)', () => {
    const roster: RcsMember[] = [
      { id: 'USER0003', name: 'Yamauchi K.', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
      { id: 'USER0004', name: 'Kobayashi M.', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
    ];
    expect(renderAttendanceSection('en', [], roster)).toBe('2/2 members attending');
  });

  it('absence-only input: one absence out of the roster shows total-1', () => {
    const roster: RcsMember[] = [
      { id: 'USER0003', name: 'Yamauchi K.', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
      { id: 'USER0004', name: 'Kobayashi M.', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
      { id: 'USER0005', name: 'Osaki K.', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
      { id: 'USER0006', name: 'Iwabuchi M.', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
    ];
    const absent = [attendance({ id: '1', memberName: 'Osaki K.', team: 'RCS', status: 'ABSENT' })];
    expect(renderAttendanceSection('en', absent, roster)).toBe('3/4 members attending');
    expect(renderAttendanceSection('ja', absent, roster)).toBe('3/4名出席中');
  });

  it('inactive roster members do not count toward the total', () => {
    const roster: RcsMember[] = [
      { id: 'USER0003', name: 'Yamauchi K.', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: true },
      { id: 'USER0009', name: 'Gone', team: 'RCS', role: 'Tester', startDate: '2026-07-01', active: false },
    ];
    expect(renderAttendanceSection('en', [], roster)).toBe('1/1 members attending');
  });

  it('returns an empty string with no roster and no records', () => {
    expect(renderAttendanceSection('en', [], [])).toBe('');
  });

  it('legacy full-roster records keep their explicit totals when larger than the roster', () => {
    const records = [
      attendance({ id: '1', memberName: 'A', team: 'PrV', status: 'PRESENT' }),
      attendance({ id: '2', memberName: 'B', team: 'PrV', status: 'ABSENT' }),
      attendance({ id: '3', memberName: 'External', team: 'PrV', status: 'PRESENT' }),
    ];
    const roster: RcsMember[] = [
      { id: 'USER0003', name: 'Yamauchi K.', team: 'PrV', role: 'Tester', startDate: '2026-07-01', active: true },
    ];
    // 3 recorded rows (incl. an external person) > 1 roster member → 3 is the total.
    expect(renderAttendanceSection('en', records, roster)).toBe('2/3 members attending');
  });
});

describe('activities / topics / next-day rendering', () => {
  it('renders "count: name" lines for included activities only', () => {
    const activities = [
      activity({ id: '1', name: 'Android 4.1.0 R-can Sanity test', memberCount: 8 }),
      activity({ id: '2', name: 'Hidden', memberCount: 3, included: false }),
      activity({ id: '3', name: 'Desktop 1.3.0 Bug Verification', memberCount: 3 }),
    ];
    expect(renderActivitiesSection('en', activities)).toBe(
      '8: Android 4.1.0 R-can Sanity test\n3: Desktop 1.3.0 Bug Verification',
    );
    expect(renderActivitiesSection('ja', activities)).toBe(
      '8名: Android 4.1.0 R-can Sanity test\n3名: Desktop 1.3.0 Bug Verification',
    );
  });

  it('renders topic blocks with blank line between title and body', () => {
    const topics: DailyTopic[] = [
      {
        id: 't1',
        reportDate: '2026-09-17',
        title: 'Android 4.1.0 R-can Sanity & Regression',
        description: 'A build for the Sanity test has been released, so it is currently being carried out.',
        displayOrder: 0,
        createdBy: 'supervisor',
        createdAt: '2026-09-17T09:00:00.000Z',
        updatedAt: '2026-09-17T09:00:00.000Z',
      },
    ];
    expect(renderTopicsSection('en', topics)).toBe(
      'Android 4.1.0 R-can Sanity & Regression\n\nA build for the Sanity test has been released, so it is currently being carried out.',
    );
  });

  it('renders next-day items in order', () => {
    const items = [
      { id: 'n1', text: 'Continue Android Sanity', source: 'SUGGESTED' as const },
      { id: 'n2', text: 'Prepare Desktop regression build', source: 'MANUAL' as const },
    ];
    expect(renderNextDaySection('en', items)).toBe('Continue Android Sanity\nPrepare Desktop regression build');
  });
});

describe('progress rendering (SPO format)', () => {
  it('renders the exact SPO block format in English', () => {
    const a = activity({
      name: 'Desktop 1.3.0 Bug Verification',
      totalCases: 74,
      workingEligibleCases: 74,
      startedCases: 71,
      completedCases: 47,
      dueDate: null,
    });
    expect(renderProgressSection('en', [a], DEFAULT_PROGRESS_RULES)).toBe(
      'Desktop 1.3.0 Bug Verification\n\nWorking: 95.95% (71/74)\nComplete: 63.51% (47/74)\nDue Date: None',
    );
  });

  it('renders the exact SPO block format in Japanese with a due date', () => {
    const a = activity({
      name: 'Android 4.1.0 R-can Sanity test',
      totalCases: 387,
      workingEligibleCases: 392,
      startedCases: 143,
      completedCases: 121,
      dueDate: '2026-10-05',
    });
    expect(renderProgressSection('ja', [a], DEFAULT_PROGRESS_RULES)).toBe(
      'Android 4.1.0 R-can Sanity test\n\n作業中: 36.48%（143/392）\n完了: 31.27%（121/387）\n期限: 10/5',
    );
  });

  it('joins multiple activity blocks with a blank line', () => {
    const result = renderProgressSection(
      'en',
      [activity({ id: '1', name: 'A', totalCases: 10, workingEligibleCases: 10, startedCases: 10, completedCases: 10 }),
       activity({ id: '2', name: 'B', totalCases: 10, workingEligibleCases: 10, startedCases: 0, completedCases: 0 })],
      DEFAULT_PROGRESS_RULES,
    );
    expect(result).toContain('A\n\nWorking: 100.00% (10/10)');
    expect(result).toContain('B\n\nWorking: 0.00% (0/10)');
    expect(result.split('\n\n\n').length).toBe(1);
  });

  it('short due dates and localized "None"', () => {
    expect(formatDueDateShort('en', '2026-10-05')).toBe('10/5');
    expect(formatDueDateShort('en', null)).toBe('None');
    expect(formatDueDateShort('ja', null)).toBe('なし');
  });
});

describe('report template', () => {
  it('default templates contain every section placeholder in both languages', () => {
    for (const template of [DEFAULT_REPORT_TEMPLATES.en, DEFAULT_REPORT_TEMPLATES.ja]) {
      for (const placeholder of [
        '{active_test_names}',
        '{attendance}',
        '{activities}',
        '{topics}',
        '{progress}',
        '{jira_url}',
        '{next_business_day}',
      ]) {
        expect(template).toContain(placeholder);
      }
    }
  });

  it('renders the template with section values, preserving unknown placeholders', () => {
    const sections = buildReportSections({
      language: 'ja',
      activities: [activity({ name: 'Sanityテスト', memberCount: 5, totalCases: 10, workingEligibleCases: 10, startedCases: 4, completedCases: 2 })],
      attendance: [attendance({ team: 'RCS', status: 'PRESENT' }), attendance({ id: '2', team: 'RCS', status: 'ABSENT' })],
      topics: [],
      nextDay: [],
      jiraUrl: 'https://jira.example.com/browse/QA',
      rules: DEFAULT_PROGRESS_RULES,
    });
    expect(sections.active_test_names).toBe('Sanityテスト');
    expect(sections.attendance).toBe('1/2名出席中');
    expect(sections.activities).toBe('5名: Sanityテスト');
    expect(sections.jira_url).toBe('https://jira.example.com/browse/QA');

    const rendered = renderReport('X {attendance} {unknown_placeholder} {jira_url}', sections);
    expect(rendered).toBe('X 1/2名出席中 {unknown_placeholder} https://jira.example.com/browse/QA');
  });

  it('Japanese default template starts with the professional greeting', () => {
    expect(DEFAULT_REPORT_TEMPLATES.ja.startsWith('お疲れ様です。')).toBe(true);
    expect(DEFAULT_REPORT_TEMPLATES.ja).toContain('※ JIRAチケットのステータスについてはこちらをご参照ください。');
    expect(DEFAULT_REPORT_TEMPLATES.en.startsWith("Hello,")).toBe(true);
  });
});
