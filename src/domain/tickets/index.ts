import type { BugTicket } from '../../types';
import { generateId } from '../../lib/id';

/**
 * Bug-ticket domain operations (V6.6). Pure array helpers — callers apply
 * the result through the app-state actions, so persistence stays
 * centralized. Tickets live inside the owning project's QaInputs, which
 * guarantees project isolation by construction.
 */

/** Create a ticket bound to its owning project. */
export function createBugTicket(
  projectId: string,
  input: Omit<BugTicket, 'id' | 'projectId'>,
): BugTicket {
  return { id: generateId(), projectId, ...input };
}

/** Add a ticket (id must not collide; duplicates are caller-validated). */
export function addBugTicket(tickets: readonly BugTicket[], ticket: BugTicket): BugTicket[] {
  return [...tickets, ticket];
}

/** Patch one ticket by id; unknown ids leave the array unchanged. */
export function updateBugTicket(
  tickets: readonly BugTicket[],
  id: string,
  patch: Partial<Omit<BugTicket, 'id'>>,
): BugTicket[] {
  return tickets.map((ticket) => (ticket.id === id ? { ...ticket, ...patch } : ticket));
}

/** Remove one ticket by id. */
export function removeBugTicket(tickets: readonly BugTicket[], id: string): BugTicket[] {
  return tickets.filter((ticket) => ticket.id !== id);
}

/**
 * Derived ticket summary (V6.6 §8) — every value is computed from the
 * ticket records; no total is ever stored. "This month" is anchored to the
 * provided date's YYYY-MM (timezone-free string prefix match).
 */
export interface TicketSummary {
  total: number;
  thisMonth: number;
  open: number;
  criticalOrMajor: number;
  closed: number;
  uniqueReporters: number;
}

export function ticketSummary(tickets: readonly BugTicket[], today: string): TicketSummary {
  const monthPrefix = today.slice(0, 7); // "YYYY-MM"
  let thisMonth = 0;
  let open = 0;
  let criticalOrMajor = 0;
  let closed = 0;
  const reporters = new Set<string>();
  for (const ticket of tickets) {
    if (ticket.createdAt.slice(0, 7) === monthPrefix) thisMonth += 1;
    if (ticket.status === 'Open') open += 1;
    if (ticket.status === 'Closed') closed += 1;
    if (ticket.severity === 'Critical' || ticket.severity === 'Major') criticalOrMajor += 1;
    const reporter = ticket.reportedBy.trim();
    if (reporter !== '') reporters.add(reporter);
  }
  return {
    total: tickets.length,
    thisMonth,
    open,
    criticalOrMajor,
    closed,
    uniqueReporters: reporters.size,
  };
}
