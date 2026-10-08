import type { DailyTeamPlan, MeetingNote } from '../../../shared/meeting';

/** The team meeting's stored records: the plans an SV typed and the day's notes. Everything else a meeting shows is read live. */
export interface MeetingState {
  dailyPlans: DailyTeamPlan[];
  meetingNotes: MeetingNote[];
}
