import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useAccess } from '../../app/access';
import { t } from '../../i18n';
import { businessDate } from '../../../shared/businessTime';
import { planTeamBackfill } from '../../../shared/teamBackfill';
import { checkTeam, checkTeamMembership } from '../../../shared/teamRules';
import type { Language, TeamMembershipRecord, TeamRecord } from '../../types';

/**
 * The SV-triggered initial backfill (TM-004): a preview of the teams and
 * PRIMARY memberships that will be created from the workspace's existing
 * free-text team labels, confirmed once (the TestRail scope-import dialog
 * idiom). The write itself is an ordinary state update — one commit, reason
 * `team-backfill`, revisioned and rollback-safe like every other change.
 */
export function BackfillDialog({ lang, now, createdBy, onDone }: { lang: Language; now: string; createdBy: string; onDone: () => void }) {
  const reports = useReportsStateCtx();
  const access = useAccess();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const members = useMemo(() => reports.state.rcsMembers ?? [], [reports.state.rcsMembers]);
  const teams = useMemo(() => reports.state.teams ?? [], [reports.state.teams]);
  const memberships = useMemo(() => reports.state.teamMemberships ?? [], [reports.state.teamMemberships]);
  const teamLabels = useMemo(() => reports.state.settings.teams, [reports.state.settings.teams]);

  const plan = useMemo(
    () => planTeamBackfill({ members, teamLabels, now, createdBy }, teams, memberships),
    [members, teamLabels, now, createdBy, teams, memberships],
  );

  const nothingToDo = plan.teams.length === 0 && plan.memberships.length === 0;

  const apply = (): void => {
    // Client-side pre-check of the same rules the server enforces.
    for (const team of plan.teams) {
      const check = checkTeam(team);
      if (!check.ok) {
        setError(check.error);
        return;
      }
    }
    for (const membership of plan.memberships) {
      const check = checkTeamMembership(membership);
      if (!check.ok) {
        setError(check.error);
        return;
      }
    }
    setBusy(true);
    try {
      reports.applyTeamBackfill(plan.teams, plan.memberships);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="tm-backfill-dialog-title">
        <h2 id="tm-backfill-dialog-title" className="confirm-title">{t(lang, 'teamMgmt.backfill.dialogTitle')}</h2>
        <p className="dr-summary">{t(lang, 'teamMgmt.backfill.dialogHelp')}</p>

        {nothingToDo ? (
          <p role="status">{t(lang, 'teamMgmt.backfill.nothingToDo')}</p>
        ) : (
          <>
            <h3>{t(lang, 'teamMgmt.backfill.teamsTitle')}</h3>
            <div className="tenancy-table-wrap">
              <table className="tenancy-table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'teamMgmt.team.name')}</th>
                    <th scope="col">{t(lang, 'teamMgmt.team.code')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.teams.map((team: TeamRecord) => (
                    <tr key={team.id}>
                      <th scope="row">{team.name}</th>
                      <td>{team.code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3>{t(lang, 'teamMgmt.backfill.membershipsTitle')}</h3>
            <div className="tenancy-table-wrap">
              <table className="tenancy-table">
                <thead>
                  <tr>
                    <th scope="col">{t(lang, 'teamMgmt.member.name')}</th>
                    <th scope="col">{t(lang, 'teamMgmt.team.name')}</th>
                    <th scope="col">{t(lang, 'teamMgmt.membership.from')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.memberships.map((membership: TeamMembershipRecord) => {
                    const member = members.find((m) => m.id === membership.memberId);
                    const team = plan.teams.find((x) => x.id === membership.teamId) ?? teams.find((x) => x.id === membership.teamId);
                    return (
                      <tr key={membership.id}>
                        <th scope="row">{member?.name ?? membership.memberId}</th>
                        <td>{team?.name ?? membership.teamId}</td>
                        <td>{membership.effectiveFrom}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {plan.membersWithoutTeam.length > 0 ? (
              <p className="dr-summary" role="note">
                {t(lang, 'teamMgmt.backfill.membersWithoutTeam', { count: plan.membersWithoutTeam.length })}
              </p>
            ) : null}
          </>
        )}

        {error !== null ? (
          <p className="data-controls-message error" role="alert">
            {t(lang, 'teamMgmt.error.generic')}
          </p>
        ) : null}

        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onDone}>
            {t(lang, 'teamMgmt.backfill.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || nothingToDo} onClick={apply}>
            {t(lang, 'teamMgmt.backfill.apply')}
          </button>
        </div>
        <p className="sr-only">{access.isSv ? businessDate() : ''}</p>
      </div>
    </div>
  );
}
