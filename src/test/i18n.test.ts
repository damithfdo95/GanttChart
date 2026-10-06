import { describe, expect, it } from 'vitest';
import { dictionaries, en, ja, type TranslationKey } from '../i18n/dictionaries';
import { interpolate, LANGUAGES, otherLanguage, resolveBilingualName, t } from '../i18n';
import { formatClock, formatInteger, formatNumber } from '../lib/formatting/format';
import { formatDateDisplay, parseDate } from '../lib/dates/dates';

describe('dictionary structure', () => {
  it('en and ja define exactly the same key set', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
  });

  it('every key is non-empty in both languages', () => {
    for (const key of Object.keys(en) as TranslationKey[]) {
      expect(en[key].length, `en ${key}`).toBeGreaterThan(0);
      expect(ja[key].length, `ja ${key}`).toBeGreaterThan(0);
    }
  });

  it('both locales are registered with switcher labels', () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(['en', 'ja']);
    expect(LANGUAGES[0].short).toBe('EN');
    expect(LANGUAGES[1].short).toBe('日本語');
  });
});

describe('required dashboard keys (EN / 日本語)', () => {
  it('dashboard.* keys exist and are translated', () => {
    expect(t('en', 'dashboard.title')).toBe('QA Execution Dashboard');
    expect(t('ja', 'dashboard.title')).toBe('QAテスト実行ダッシュボード');
    expect(t('en', 'dashboard.remainingCases')).toBe('Remaining Test Cases');
    expect(t('ja', 'dashboard.remainingCases')).toBe('残りテストケース数');
    expect(t('en', 'dashboard.predictedFinish')).toBe('Forecast Finish (current pace)');
    expect(t('ja', 'dashboard.predictedFinish')).toBe('予測完了（現在のペース）');
    expect(t('en', 'dashboard.deadline')).toBe('Deadline');
    expect(t('ja', 'dashboard.deadline')).toBe('期限');
    expect(t('en', 'dashboard.capacityShortage')).toBe('Capacity Shortage');
    expect(t('ja', 'dashboard.capacityShortage')).toBe('キャパシティ不足');
    expect(t('en', 'dashboard.requiredTesters')).toBe('Required Testers');
    expect(t('ja', 'dashboard.requiredTesters')).toBe('必要テスター数');
    expect(t('en', 'dashboard.overtimeRequired')).toBe('Overtime Required');
    expect(t('ja', 'dashboard.overtimeRequired')).toBe('残業が必要');
  });
});

describe('status translations', () => {
  it('renders every schedule status in both languages', () => {
    expect(t('en', 'status.notStarted')).toBe('Not Started');
    expect(t('ja', 'status.notStarted')).toBe('未着手');
    expect(t('en', 'status.onSchedule')).toBe('On Schedule');
    expect(t('ja', 'status.onSchedule')).toBe('予定通り');
    expect(t('en', 'status.delayed')).toBe('Delayed');
    expect(t('ja', 'status.delayed')).toBe('遅延');
    expect(t('en', 'status.ahead')).toBe('Ahead');
    expect(t('en', 'status.working')).toBe('Working');
    expect(t('ja', 'status.working')).toBe('対応中');
    expect(t('en', 'status.onTrack')).toBe('On Track');
    expect(t('ja', 'status.onTrack')).toBe('順調');
    expect(t('en', 'status.atRisk')).toBe('At Risk');
    expect(t('ja', 'status.atRisk')).toBe('リスクあり');
    expect(t('en', 'status.overdue')).toBe('Overdue');
    expect(t('ja', 'status.overdue')).toBe('期限超過');
    expect(t('en', 'status.capacityShortage')).toBe('Capacity Shortage');
    expect(t('ja', 'status.capacityShortage')).toBe('キャパシティ不足');
    expect(t('en', 'status.completed')).toBe('Completed');
    expect(t('ja', 'status.completed')).toBe('完了');
  });

  it('renders the Level 2 management keys in both languages', () => {
    expect(t('en', 'views.operator')).toBe('Operator');
    expect(t('ja', 'views.operator')).toBe('実行');
    expect(t('en', 'views.manager')).toBe('Manager');
    expect(t('ja', 'views.manager')).toBe('管理');
    expect(t('ja', 'gap.title')).toBe('計画 vs 実績 — 日次進捗');
    expect(t('en', 'gap.title')).toBe('Plan vs Actual — Daily Progress');
    expect(t('ja', 'blocking.cat.BUILD')).toBe('ビルド');
    expect(t('en', 'blocking.cat.SYSTEM_ISSUE')).toBe('System Issue');
    expect(t('ja', 'milestones.reached')).toBe('到達');
    expect(t('en', 'milestones.overdue')).toBe('Overdue');
  });

  it('interpolates milestone default names with the target percentage', () => {
    expect(t('en', 'milestones.defaultName.execute', { pct: 50 })).toBe('Execute 50%');
    expect(t('ja', 'milestones.defaultName.pass', { pct: 80 })).toBe('パス 80%');
  });

  it('renders the V6 recovery keys in both languages', () => {
    expect(t('en', 'recovery.title')).toBe('Recovery Analysis');
    expect(t('ja', 'recovery.title')).toBe('リカバリー分析');
    expect(t('ja', 'recovery.apply')).toBe('シナリオを適用');
    expect(t('ja', 'recovery.reset')).toBe('シナリオをリセット');
    expect(t('en', 'recovery.find')).toBe('Find Recovery Options');
    expect(t('en', 'recovery.opt.plusTesters', { n: 2 })).toBe('+2 Testers');
    expect(t('ja', 'recovery.opt.ratePct', { pct: 20 })).toBe('実行速度+20%');
    expect(t('ja', 'recovery.recovered')).toBe('リカバリー達成');
    expect(t('ja', 'recovery.noRecovery')).toBe('検証したシナリオでは目標終了時刻に間に合いません。');
  });
});

describe('t() template interpolation', () => {
  it('fills {variables} in both languages without fragment concatenation', () => {
    expect(
      t('en', 'explanation.shortage', { capacity: '144', remaining: '200', shortage: '56' }),
    ).toBe(
      '144 cases can be completed during regular working hours before the deadline. 200 cases remain, resulting in a shortage of 56 cases.',
    );
    expect(
      t('ja', 'explanation.shortage', { capacity: '144', remaining: '200', shortage: '56' }),
    ).toBe(
      '期限までの通常勤務時間内で144件のテストケースを完了できます。残り200件に対して56件のキャパシティ不足があります。',
    );
  });

  it('keeps unknown placeholders untouched', () => {
    expect(interpolate('{known} {unknown}', { known: 'x' })).toBe('x {unknown}');
  });

  it('accepts numeric variable values', () => {
    expect(t('ja', 'explanation.allDone', { total: 120 })).toContain('全120件');
  });
});

describe('language switching helpers', () => {
  it('otherLanguage flips the locale', () => {
    expect(otherLanguage('en')).toBe('ja');
    expect(otherLanguage('ja')).toBe('en');
  });

  it('dictionaries are reachable per language', () => {
    expect(dictionaries.en['app.title']).toBe('GanttChart');
    expect(dictionaries.ja['app.subtitle']).toBe('QAテスト実行スケジュール管理');
  });
});

describe('bilingual user-generated names (nameEn / nameJa)', () => {
  it('prefers the name in the active language', () => {
    const names = { nameEn: 'Login Regression Suite', nameJa: 'ログイン回帰テスト' };
    expect(resolveBilingualName('en', names)).toBe('Login Regression Suite');
    expect(resolveBilingualName('ja', names)).toBe('ログイン回帰テスト');
  });

  it('falls back to the other language when only one name exists', () => {
    expect(resolveBilingualName('ja', { nameEn: 'API Tests' })).toBe('API Tests');
    expect(resolveBilingualName('en', { nameJa: 'APIテスト' })).toBe('APIテスト');
  });

  it('returns an empty string when no name exists', () => {
    expect(resolveBilingualName('en', undefined)).toBe('');
    expect(resolveBilingualName('ja', {})).toBe('');
  });

  it('ignores whitespace-only names', () => {
    expect(resolveBilingualName('ja', { nameEn: '   ', nameJa: '精査' })).toBe('精査');
  });
});

describe('locale-aware dates, numbers and times', () => {
  it('formats dates per locale: "Oct 5, 2026" / "2026年10月5日"', () => {
    const epoch = parseDate('2026-10-05')!;
    expect(formatDateDisplay(epoch, 'en')).toBe('Oct 5, 2026 (Mon)');
    expect(formatDateDisplay(epoch, 'ja')).toBe('2026年10月5日（月）');
  });

  it('formats numbers with locale grouping in both languages', () => {
    expect(formatInteger(1234567, 'en')).toBe('1,234,567');
    expect(formatInteger(1234567, 'ja')).toBe('1,234,567');
    expect(formatNumber(1.125, 3, 'en')).toBe('1.125');
    expect(formatNumber(1.125, 3, 'ja')).toBe('1.125');
  });

  it('keeps 24-hour clock times identical in both languages', () => {
    for (const minutes of [0, 540, 720, 780, 1050]) {
      const expected = formatClock(minutes);
      expect(formatClock(minutes)).toBe(expected); // deterministic
      expect(expected).toMatch(/^\d{2}:\d{2}$/);
    }
    expect(formatClock(540)).toBe('09:00');
    expect(formatClock(1050)).toBe('17:30');
  });
});
