import { useState } from 'react';
import type { Language, RcsMember, ReviewStatus, TesterReview } from '../../types';
import { t } from '../../i18n';
import { Field } from '../../components/Field';

interface ReviewFormProps {
  lang: Language;
  /** Existing review for the selected (tester, period); null when new. */
  existing: TesterReview | null;
  testerName: string;
  /** The RCS member the review is for (V6.8); absent for legacy name-only testers. */
  member?: RcsMember;
  periodType: TesterReview['periodType'];
  periodStart: string;
  periodEnd: string;
  onSave: (review: Omit<TesterReview, 'id' | 'createdAt' | 'updatedAt'>, original: TesterReview | null) => void;
}

interface NoteDraft {
  summaryNote: string;
  strengthsNote: string;
  improvementNote: string;
  supervisorNote: string;
}

function fromReview(review: TesterReview | null): NoteDraft {
  return {
    summaryNote: review?.summaryNote ?? '',
    strengthsNote: review?.strengthsNote ?? '',
    improvementNote: review?.improvementNote ?? '',
    supervisorNote: review?.supervisorNote ?? '',
  };
}

/**
 * Supervisor notes + status form (V6.7 §23/§25). Notes are free text and
 * always the supervisor's own words; a completed review can be reopened and
 * edited again (no approval/signature workflow in V6.7).
 */
export function ReviewForm({ lang, existing, testerName, member, periodType, periodStart, periodEnd, onSave }: ReviewFormProps) {
  const [notes, setNotes] = useState<NoteDraft>(() => fromReview(existing));
  const [status, setStatus] = useState<ReviewStatus>(existing?.status ?? 'draft');

  const handleSave = (): void => {
    onSave(
      {
        testerName: member?.name ?? testerName,
        ...(member !== undefined ? { memberId: member.id } : {}),
        periodType,
        periodStart,
        periodEnd,
        status,
        summaryNote: notes.summaryNote.trim() === '' ? undefined : notes.summaryNote,
        strengthsNote: notes.strengthsNote.trim() === '' ? undefined : notes.strengthsNote,
        improvementNote: notes.improvementNote.trim() === '' ? undefined : notes.improvementNote,
        supervisorNote: notes.supervisorNote.trim() === '' ? undefined : notes.supervisorNote,
      },
      existing,
    );
  };

  const noteFields: { key: keyof NoteDraft; label: string }[] = [
    { key: 'summaryNote', label: t(lang, 'review.summary') },
    { key: 'strengthsNote', label: t(lang, 'review.strengths') },
    { key: 'improvementNote', label: t(lang, 'review.improvement') },
    { key: 'supervisorNote', label: t(lang, 'review.supervisorNotes') },
  ];

  return (
    <form
      className="input-grid"
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
    >
      <Field label={t(lang, 'review.status')}>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value === 'completed' ? 'completed' : 'draft')}>
          <option value="draft">{t(lang, 'review.draft')}</option>
          <option value="completed">{t(lang, 'review.completed')}</option>
        </select>
      </Field>
      {noteFields.map((field) => (
        <Field key={field.key} label={field.label}>
          <textarea
            className="input"
            rows={3}
            value={notes[field.key]}
            onChange={(e) => setNotes((prev) => ({ ...prev, [field.key]: e.target.value }))}
          />
        </Field>
      ))}
      <div className="dr-button-row">
        <button type="submit" className="btn">
          {t(lang, 'review.saveReview')}
        </button>
      </div>
    </form>
  );
}
