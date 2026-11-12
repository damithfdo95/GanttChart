import { useMemo, useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useAccess } from '../../app/access';
import { t } from '../../i18n';
import { checkTeam, supervisorOf, type TeamRecord } from '../../../shared/teamRules';
import { coversDate } from '../../../shared/teamDates';
import type { Language } from '../../types';

/** The next free team id: TEAM-<code> with a numeric suffix on collision. */
function nextTeamId(teams: readonly TeamRecord[], code: string): string {
  const used = new Set(teams.map((team) => team.id));
  let id = `TEAM-${code}`;
  let suffix = 2;
  while (used.has(id)) {
    id = `TEAM-${code}${suffix}`;
    suffix += 1;
  }
  return id;
}

/**
 * The Team Structure tab (spec §6, Phase 1 subset): the teams as an
 * expandable hierarchy with supervisor, member count and status, plus
 * create/edit/archive actions for the SV.
 */
export function TeamStructureTab({ lang, today }: { lang: Language; today: string }) {
  const reports = useReportsStateCtx();
  const access = useAccess();
  const teams = useMemo(() => reports.state.teams ?? [], [reports.state.teams]);
  const memberships = useMemo(() => reports.state.teamMemberships ?? [], [reports.state.teamMemberships]);
  const supervisors = useMemo(() => reports.state.teamSupervisors ?? [], [reports.state.teamSupervisors]);
  const members = useMemo(() => reports.state.rcsMembers ?? [], [reports.state.rcsMembers]);

  const [editing, setEditing] = useState<TeamRecord | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);

  const rows = useMemo(() => {
    const byParent = new Map<string | undefined, TeamRecord[]>();
    for (const team of teams) {
      const list = byParent.get(team.parentTeamId) ?? [];
      list.push(team);
      byParent.set(team.parentTeamId, list);
    }
    for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return byParent;
  }, [teams]);

  const countOn = (teamId: string): number => memberships.filter((m) => m.teamId === teamId && m.status === 'ACTIVE' && coversDate(m.effectiveFrom, m.effectiveTo, today)).length;

  const supervisorName = (teamId: string): string => {
    const sup = supervisorOf(supervisors, teamId, today);
    if (sup === null) return '—';
    return memberName.get(sup.memberId) ?? sup.memberId;
  };

  const save = (team: TeamRecord): void => {
    const check = checkTeam(team);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    reports.upsertTeam(check.record);
    setEditing(null);
    setError(null);
  };

  const archive = (team: TeamRecord): void => {
    reports.upsertTeam({ ...team, status: team.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE', updatedAt: new Date().toISOString() });
  };

  const renderTeam = (team: TeamRecord, depth: number): JSX.Element => (
    <tbody key={team.id}>
      <tr>
        <th scope="row" className="tm-team-cell">
          <span aria-hidden="true">{'│ '.repeat(depth)}</span>
          {team.name}
        </th>
        <td>{team.code}</td>
        <td>{supervisorName(team.id)}</td>
        <td>{countOn(team.id)}</td>
        <td>
          <span className={`status-badge status-${team.status === 'ACTIVE' ? 'active' : 'disabled'}`}>
            <span aria-hidden="true">{team.status === 'ACTIVE' ? '● ' : '⏸ '}</span>
            {t(lang, team.status === 'ACTIVE' ? 'teamMgmt.team.active' : 'teamMgmt.team.archived')}
          </span>
        </td>
        {access.isSv ? (
          <td className="dr-row-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(team)}>
              {t(lang, 'teamMgmt.team.edit')}
            </button>
            <button type="button" className="btn btn-ghost" disabled={team.status !== 'ACTIVE'} onClick={() => archive(team)}>
              {t(lang, 'teamMgmt.team.archive')}
            </button>
          </td>
        ) : null}
      </tr>
      {(rows.get(team.id) ?? []).map((child) => renderTeam(child, depth + 1))}
    </tbody>
  );

  const roots = rows.get(undefined) ?? [];

  return (
    <section className="dr-section" aria-labelledby="tm-structure-title">
      <h2 id="tm-structure-title">{t(lang, 'teamMgmt.tab.teamStructure')}</h2>
      {access.isSv ? (
        <div className="dr-section-tools">
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            {t(lang, 'teamMgmt.team.create')}
          </button>
        </div>
      ) : null}

      {teams.length === 0 ? (
        <p className="tenancy-empty" role="note">
          {t(lang, 'teamMgmt.team.empty')}
        </p>
      ) : (
        <div className="tenancy-table-wrap">
          <table className="tenancy-table">
            <caption className="sr-only">{t(lang, 'teamMgmt.tab.teamStructure')}</caption>
            <thead>
              <tr>
                <th scope="col">{t(lang, 'teamMgmt.team.name')}</th>
                <th scope="col">{t(lang, 'teamMgmt.team.code')}</th>
                <th scope="col">{t(lang, 'teamMgmt.team.supervisor')}</th>
                <th scope="col">{t(lang, 'teamMgmt.team.memberCount')}</th>
                <th scope="col">{t(lang, 'teamMgmt.team.status')}</th>
                {access.isSv ? <th scope="col"><span className="sr-only">{t(lang, 'teamMgmt.team.actions')}</span></th> : null}
              </tr>
            </thead>
            {roots.map((team) => renderTeam(team, 0))}
          </table>
        </div>
      )}

      {error !== null ? (
        <p className="data-controls-message error" role="alert">
          {t(lang, 'teamMgmt.error.generic')}
        </p>
      ) : null}

      {editing !== null ? <TeamEditor lang={lang} teams={teams} team={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSave={save} /> : null}
    </section>
  );
}

function TeamEditor({ lang, teams, team, onCancel, onSave }: { lang: Language; teams: readonly TeamRecord[]; team: TeamRecord | null; onCancel: () => void; onSave: (team: TeamRecord) => void }) {
  const [name, setName] = useState(team?.name ?? '');
  const [code, setCode] = useState(team?.code ?? '');
  const [description, setDescription] = useState(team?.description ?? '');
  const [parentTeamId, setParentTeamId] = useState(team?.parentTeamId ?? '');
  const now = new Date().toISOString();

  const submit = (): void => {
    const trimmedCode = code.trim().toUpperCase();
    const record: TeamRecord = {
      id: team?.id ?? nextTeamId(teams, trimmedCode === '' ? 'TEAM' : trimmedCode),
      name: name.trim(),
      code: trimmedCode,
      ...(description.trim() === '' ? {} : { description: description.trim() }),
      ...(parentTeamId === '' ? {} : { parentTeamId }),
      status: team?.status ?? 'ACTIVE',
      createdAt: team?.createdAt ?? now,
      updatedAt: now,
    };
    onSave(record);
  };

  return (
    <div className="confirm-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="tm-team-editor-title">
        <h2 id="tm-team-editor-title" className="confirm-title">{t(lang, team === null ? 'teamMgmt.team.createTitle' : 'teamMgmt.team.editTitle')}</h2>
        <label className="dr-toolbar-field">
          {t(lang, 'teamMgmt.team.name')}
          <input className="input" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="dr-toolbar-field">
          {t(lang, 'teamMgmt.team.code')}
          <input className="input" value={code} maxLength={40} required onChange={(e) => setCode(e.target.value)} />
        </label>
        <label className="dr-toolbar-field">
          {t(lang, 'teamMgmt.team.description')}
          <textarea className="input" value={description} maxLength={2000} rows={3} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="dr-toolbar-field">
          {t(lang, 'teamMgmt.team.parent')}
          <select className="input" value={parentTeamId} onChange={(e) => setParentTeamId(e.target.value)}>
            <option value="">{t(lang, 'teamMgmt.team.noParent')}</option>
            {teams
              .filter((x) => x.id !== team?.id)
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
          </select>
        </label>
        <div className="confirm-actions">
          <button type="button" className="btn" onClick={onCancel}>
            {t(lang, 'teamMgmt.team.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={name.trim() === '' || code.trim() === ''} onClick={submit}>
            {t(lang, 'teamMgmt.team.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
