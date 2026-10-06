import type { BugTicket } from '../../types';
import type { TranslationKey } from '../../i18n';
import { parseDate } from '../dates/dates';

export type TicketFieldErrors = Partial<Record<keyof BugTicket, TranslationKey>>;

export interface TicketValidationOutcome {
  isValid: boolean;
  errors: TicketFieldErrors;
}

/** RFC-3986-ish check: any scheme + host; "ABC-123" alone is not a URL. */
export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
  } catch {
    return false;
  }
}

/**
 * Bug-ticket validation (V6.6 §11). Errors are i18n keys rendered inline
 * next to the offending field. Title, URL, created date and reporter are
 * required; ticketKey / severity / status / memo are optional.
 */
export function validateBugTicket(ticket: BugTicket): TicketValidationOutcome {
  const errors: TicketFieldErrors = {};
  if (ticket.title.trim() === '') {
    errors.title = 'errors.ticketTitleRequired';
  }
  if (ticket.url.trim() === '') {
    errors.url = 'errors.ticketUrlRequired';
  } else if (!isValidUrl(ticket.url.trim())) {
    errors.url = 'errors.ticketUrlInvalid';
  }
  if (parseDate(ticket.createdAt) === null) {
    errors.createdAt = 'errors.ticketDateInvalid';
  }
  if (ticket.reportedBy.trim() === '') {
    errors.reportedBy = 'errors.ticketReporterRequired';
  }
  if (ticket.projectId === '') {
    errors.projectId = 'errors.ticketProjectRequired';
  }
  return { isValid: Object.keys(errors).length === 0, errors: errors };
}

/**
 * Exact-duplicate detection (V6.6 §11): the same JIRA ticket key, or the
 * exact same URL, marks a likely duplicate. Similar titles alone never do
 * (legitimate re-entry of similar bugs is allowed). The edited record
 * itself is excluded via excludeId.
 */
export function findDuplicateTicket(
  tickets: readonly BugTicket[],
  candidate: Pick<BugTicket, 'ticketKey' | 'url'>,
  excludeId?: string,
): BugTicket | undefined {
  const key = candidate.ticketKey?.trim();
  const url = candidate.url.trim();
  return tickets.find((ticket) => {
    if (ticket.id === excludeId) return false;
    if (key !== undefined && key !== '' && ticket.ticketKey !== undefined && ticket.ticketKey.trim() === key) {
      return true;
    }
    return url !== '' && ticket.url.trim() === url;
  });
}
