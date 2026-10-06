import type { RcsMember, TesterReview } from '../../types';
import { generateId } from '../../lib/id';
import { reviewIdentityKey } from '../members';

/**
 * Supervisor review-record operations (V6.7 Part B). Pure array helpers —
 * callers apply the result through the reports-state actions so persistence
 * stays centralized. Reviews live at workspace level (ReportsState) because
 * an H1/H2/yearly review spans multiple projects. Objective metrics are
 * NEVER stored here — only supervisor notes and status (reproducibility:
 * metrics are recalculated from the evidence chain on demand).
 *
 * V6.8: reviews carry an optional stable memberId; the natural key resolves
 * through the member master so legacy name-based reviews keep working.
 */

export interface ReviewInput {
  testerName: string;
  /** Stable RCS member identity (V6.8); absent for legacy name-only reviews. */
  memberId?: string;
  periodType: TesterReview['periodType'];
  periodStart: string;
  periodEnd: string;
  status: TesterReview['status'];
  summaryNote?: string;
  strengthsNote?: string;
  improvementNote?: string;
  supervisorNote?: string;
}

/** Create a review with a generated id and timestamps. */
export function createTesterReview(input: ReviewInput, nowIso: string): TesterReview {
  return { id: generateId(), createdAt: nowIso, updatedAt: nowIso, ...input };
}

/** Natural key: one review per (tester identity, period). H1 and H2 are stored
 *  independently because their period bounds differ. */
export function reviewKey(testerName: string, periodStart: string, periodEnd: string): string {
  return `${testerName.trim()}\u0000${periodStart}\u0000${periodEnd}`;
}

/**
 * The existing review for (tester, period), if any. `testerName` may be a
 * stable memberId (V6.8) or a legacy name; when the member master is given,
 * legacy review names resolve to member ids through the same conservative
 * unique-name-match rule used everywhere else.
 */
export function findTesterReview(
  reviews: readonly TesterReview[],
  testerName: string,
  periodStart: string,
  periodEnd: string,
  members: readonly RcsMember[] = [],
): TesterReview | undefined {
  const key = testerName.trim();
  return reviews.find(
    (review) =>
      reviewIdentityKey(review, members) === key &&
      review.periodStart === periodStart &&
      review.periodEnd === periodEnd,
  );
}

/**
 * Save a review: an existing review for the same (tester, period) is
 * updated in place (keeping its id, createdAt and review history);
 * otherwise a new independent record is appended. Reviews for other
 * periods are never touched.
 */
export function upsertTesterReview(
  reviews: readonly TesterReview[],
  review: TesterReview,
  members: readonly RcsMember[] = [],
): TesterReview[] {
  const key = reviewIdentityKey(review, members);
  const index = reviews.findIndex((existing) => reviewIdentityKey(existing, members) === key && existing.periodStart === review.periodStart && existing.periodEnd === review.periodEnd);
  if (index === -1) return [...reviews, review];
  const copy = [...reviews];
  copy[index] = { ...review, id: reviews[index].id, createdAt: reviews[index].createdAt };
  return copy;
}

/** Remove one review by id. */
export function removeTesterReview(reviews: readonly TesterReview[], id: string): TesterReview[] {
  return reviews.filter((review) => review.id !== id);
}

/** A tester's review history, chronological by period start. */
export function getTesterReviewHistory(
  reviews: readonly TesterReview[],
  testerName: string,
  members: readonly RcsMember[] = [],
): TesterReview[] {
  const key = testerName.trim();
  return reviews
    .filter((review) => reviewIdentityKey(review, members) === key)
    .sort((a, b) => a.periodStart.localeCompare(b.periodStart) || a.periodEnd.localeCompare(b.periodEnd));
}
