import { useMemo, useState } from 'react';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useAccess } from '../../app/access';
import { t } from '../../i18n';
import { businessDate } from '../../../shared/businessTime';
import { primaryMembershipOf } from '../../../shared/teamRules';
import { inclusiveEndOf } from '../../../shared/teamDates';
import { BackfillDialog } from './BackfillDialog';
import { MembersTab } from './MembersTab';
import { TeamStructureTab } from './TeamStructureTab';
import type { Language } from '../../types';

type Tab = 'overview' | 'members' | 'teamStructure' | 'assignments' | 'calendar' | 'capacity' | 'analytics';
const TABS: readonly Tab[] = ['overview', 'members', 'teamStructure', 'assignments', 'calendar', 'capacity', 'analytics'];

/**
 * Team Management (TM-00 Phase 1): the module's screen with its seven areas as
 * tabs (the TestManagementScreen pattern). Phase 1 implements Members and
 * Team Structure; the later tabs arrive with their phases and show a
 * "coming with Phase N" note until then. Everything an SV changes here is an
 * ordinary shared record (one revision per action).
 */
export function TeamManagementScreen() {
  const app = useAppStateCtx();
  const reports = useReportsStateCtx();
  const access = useAccess();
  const lang = app.state.language;
  const [tab, setTab] = useState<Tab>('overview');
  const [backfillOpen, setBackfillOpen] = useState(false);

  const members = useMemo(() => reports.state.rcsMembers ?? [], [reports.state.rcsMembers]);
  const teams = useMemo(() => reports.state.teams ?? [], [reports.state.teams]);
  const memberships = useMemo(() => reports.state.teamMemberships ?? [], [reports.state.teamMemberships]);
  const today = businessDate();

  const teamName = useMemo(() => new Map(teams.map((team) => [team.id, team.name])), [teams]);

  // The Overview facts (spec §3.9 dashboard metrics, Phase 1 subset).
  const overview = useMemo(() => {
    const activeMembers = members.filter((m) => m.active).length;
    const membersWithPrimary = new Set(memberships.filter((m) => m.membershipKind === 'PRIMARY' && m.status === 'ACTIVE').map((m) => m.memberId));
    const activeTeams = teams.filter((team) => team.status === 'ACTIVE').length;
    const secondary = memberships.filter((m) => m.status === 'ACTIVE' && m.membershipKind !== 'PRIMARY' && (m.effectiveTo === undefined || m.effectiveTo > today)).length;
    return { total: members.length, activeMembers, unassigned: members.filter((m) => m.active && !membersWithPrimary.has(m.id)).length, activeTeams, secondary };
  }, [members, memberships, teams, today]);

  const needsBackfill = teams.length === 0 && members.length > 0;

  return (
    <div className="app tm-screen team-management-screen">
      <header className="dr-section">
        <h1>{t(lang, 'teamMgmt.title')}</h1>
        <div className="view-toggle" role="tablist" aria-label={t(lang, 'teamMgmt.title')}>
          {TABS.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : undefined} onClick={() => setTab(id)}>
              {t(lang, `teamMgmt.tab.${id}` as `teamMgmt.tab.${typeof id}`)}
            </button>
          ))}
        </div>
      </header>

      {needsBackfill && access.isSv ? (
        <section className="dr-section" aria-labelledby="tm-backfill-title">
          <h2 id="tm-backfill-title">{t(lang, 'teamMgmt.backfill.title')}</h2>
          <p className="dr-summary">{t(lang, 'teamMgmt.backfill.help')}</p>
          <button type="button" className="btn btn-primary" onClick={() => setBackfillOpen(true)}>
            {t(lang, 'teamMgmt.backfill.open')}
          </button>
        </section>
      ) : null}

      {tab === 'overview' ? <OverviewTab lang={lang} overview={overview} onOpenMembers={() => setTab('members')} /> : null}
      {tab === 'members' ? <MembersTab lang={lang} today={today} teamName={teamName} memberships={memberships} /> : null}
      {tab === 'teamStructure' ? <TeamStructureTab lang={lang} today={today} /> : null}
      {tab === 'assignments' || tab === 'calendar' || tab === 'capacity' || tab === 'analytics' ? <PhaseNote lang={lang} tab={tab} /> : null}

      {backfillOpen ? (
        <BackfillDialog
          lang={lang}
          now={new Date().toISOString()}
          createdBy={access.userId ?? app.state.language}
          onDone={() => setBackfillOpen(false)}
        />
      ) : null}
    </div>
  );
}

function OverviewTab({ lang, overview, onOpenMembers }: { lang: Language; overview: { total: number; activeMembers: number; unassigned: number; activeTeams: number; secondary: number }; onOpenMembers: () => void }) {
  return (
    <section className="dr-section" aria-labelledby="tm-overview-title">
      <h2 id="tm-overview-title">{t(lang, 'teamMgmt.overview.title')}</h2>
      <dl className="cc-facts">
        <div>
          <dt>{t(lang, 'teamMgmt.overview.totalMembers')}</dt>
          <dd>{overview.total}</dd>
        </div>
        <div>
          <dt>{t(lang, 'teamMgmt.overview.activeMembers')}</dt>
          <dd>{overview.activeMembers}</dd>
        </div>
        <div>
          <dt>{t(lang, 'teamMgmt.overview.unassigned')}</dt>
          <dd>{overview.unassigned}</dd>
        </div>
        <div>
          <dt>{t(lang, 'teamMgmt.overview.activeTeams')}</dt>
          <dd>{overview.activeTeams}</dd>
        </div>
        <div>
          <dt>{t(lang, 'teamMgmt.overview.secondaryAssignments')}</dt>
          <dd>{overview.secondary}</dd>
        </div>
      </dl>
      {overview.unassigned > 0 ? (
        <p className="dr-summary">
          <button type="button" className="btn" onClick={onOpenMembers}>
            {t(lang, 'teamMgmt.overview.goToMembers')}
          </button>
        </p>
      ) : null}
    </section>
  );
}

function PhaseNote({ lang, tab }: { lang: Language; tab: 'assignments' | 'calendar' | 'capacity' | 'analytics' }) {
  const phase = tab === 'assignments' ? 2 : tab === 'calendar' ? 3 : tab === 'capacity' ? 4 : 5;
  return (
    <section className="dr-section" aria-labelledby="tm-phase-title">
      <h2 id="tm-phase-title">{t(lang, `teamMgmt.tab.${tab}` as const)}</h2>
      <p className="dr-summary" role="note">
        {t(lang, 'teamMgmt.phaseNote', { phase })}
      </p>
    </section>
  );
}

/** Shared row helper: the display (inclusive) period of a membership. */
export function membershipPeriodText(membership: import('../../types').TeamMembershipRecord): string {
  const end = inclusiveEndOf(membership.effectiveTo);
  return end === undefined ? `${membership.effectiveFrom} –` : `${membership.effectiveFrom} – ${end}`;
}

/** Shared helper: the member's primary team name today. */
export function primaryTeamText(memberships: readonly import('../../types').TeamMembershipRecord[], teamName: Map<string, string>, memberId: string, today: string): string {
  const primary = primaryMembershipOf(memberships, memberId, today);
  return primary === null ? '—' : (teamName.get(primary.teamId) ?? primary.teamId);
}
