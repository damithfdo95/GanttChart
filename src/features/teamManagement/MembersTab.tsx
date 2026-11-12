import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { t } from '../../i18n';
import { isActiveMember } from '../../domain/teamMembers';
import { membershipsOn } from '../../../shared/teamRules';
import { membershipPeriodText, primaryTeamText } from './TeamManagementScreen';
import type { Language, TeamMembershipRecord } from '../../types';

/**
 * The Members tab (spec §6 Members page, Phase 1 subset): the roster with
 * each member's primary team, additional teams and status. Editing a
 * membership happens on the Assignments tab (Phase 2); here the SV sees the
 * current state and can filter it.
 */
export function MembersTab({ lang, today, teamName, memberships }: { lang: Language; today: string; teamName: Map<string, string>; memberships: readonly TeamMembershipRecord[] }) {
  const reports = useReportsStateCtx();
  const members = useMemo(() => reports.state.rcsMembers ?? [], [reports.state.rcsMembers]);
  const [query, setQuery] = useState('');
  const [teamFilter, setTeamFilter] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((m) => {
        if (teamFilter !== '') {
          const on = membershipsOn(memberships, m.id, today).some((x) => x.teamId === teamFilter);
          if (!on) return false;
        }
        if (q === '') return true;
        const primary = primaryTeamText(memberships, teamName, m.id, today).toLowerCase();
        return m.name.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q) || primary.includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [members, memberships, teamName, today, query, teamFilter]);

  const teamOptions = useMemo(() => [...teamName.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)), [teamName]);

  return (
    <section className="dr-section" aria-labelledby="tm-members-title">
      <h2 id="tm-members-title">{t(lang, 'teamMgmt.tab.members')}</h2>
      <div className="dr-section-tools">
        <input className="input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t(lang, 'teamMgmt.members.searchPlaceholder')} aria-label={t(lang, 'teamMgmt.members.searchPlaceholder')} />
        <select className="input" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)} aria-label={t(lang, 'teamMgmt.members.teamFilter')}>
          <option value="">{t(lang, 'teamMgmt.members.allTeams')}</option>
          {teamOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'teamMgmt.members.empty')}
        </p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'teamMgmt.tab.members')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'teamMgmt.member.name')}</th>
                <th scope="col">{t(lang, 'teamMgmt.member.email')}</th>
                <th scope="col">{t(lang, 'teamMgmt.member.primaryTeam')}</th>
                <th scope="col">{t(lang, 'teamMgmt.member.additionalTeams')}</th>
                <th scope="col">{t(lang, 'teamMgmt.member.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const on = membershipsOn(memberships, m.id, today);
                const primary = on.find((x) => x.membershipKind === 'PRIMARY');
                const others = on.filter((x) => x !== primary);
                const active = isActiveMember(m, today);
                return (
                  <tr key={m.id}>
                    <th scope="row">{m.name}</th>
                    <td>{m.email ?? '—'}</td>
                    <td>{primaryTeamText(memberships, teamName, m.id, today)}</td>
                    <td>
                      {others.length === 0
                        ? '—'
                        : others
                            .map((x) => `${teamName.get(x.teamId) ?? x.teamId} (${membershipPeriodText(x)})`)
                            .join(', ')}
                    </td>
                    <td>
                      <span className={`status-badge status-${active ? 'active' : 'disabled'}`}>
                        <span aria-hidden="true">{active ? '● ' : '⏸ '}</span>
                        {t(lang, active ? 'teamMgmt.member.active' : 'teamMgmt.member.inactive')}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
