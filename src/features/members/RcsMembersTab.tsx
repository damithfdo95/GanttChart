import { useMemo, useState } from 'react';
import { memberLabel } from '../../domain/people';
import type { Language, RcsMember, RcsMemberNameHistory } from '../../types';
import { t } from '../../i18n';
import { formatDate, todayEpochDays } from '../../lib/dates/dates';
import { Field } from '../../components/Field';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { nameHistoryEntryLabel, nextMemberId, normalizeMemberNameHistory } from '../../domain/members';
import { hasMemberReferences, memberReferenceScope } from '../../domain/identityResolution';
import { validateRcsMember } from '../../lib/validation/validateMember';
import { IdentityResolutionCenter } from './IdentityResolutionCenter';

interface MemberDraft {
  id: string;
  name: string;
  team: string;
  role: string;
  startDate: string;
  endDate: string;
  nameHistory: RcsMemberNameHistory[];
}

function draftFromMember(member: RcsMember): MemberDraft {
  return {
    id: member.id,
    name: member.name,
    team: member.team,
    role: member.role,
    startDate: member.startDate,
    endDate: member.endDate ?? '',
    nameHistory: (member.nameHistory ?? []).map((entry) => ({
      name: entry.name,
      fromDate: entry.fromDate ?? '',
      toDate: entry.toDate ?? '',
    })),
  };
}

/**
 * RCS Member Master workspace (V6.8): the stable roster behind every
 * assignment, execution record and review. Member IDs are permanent —
 * editing a member never regenerates its id, and deactivating a member
 * never removes it from historical records.
 *
 * V6.9-A: the form edits the member's name history (validated), the table
 * shows each member's historical names, deletion is blocked for members
 * with identity references (deactivation is recommended instead), and the
 * Identity Resolution Center manages legacy attendance/ticket identities.
 */
export function RcsMembersTab() {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const lang: Language = app.state.language;
  const members = reportsApi.state.rcsMembers ?? [];
  const today = formatDate(todayEpochDays());

  const suggestedId = useMemo(() => nextMemberId(members), [members]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemberDraft>(() => ({
    id: suggestedId,
    name: '',
    team: 'RCS',
    role: 'Tester',
    startDate: today,
    endDate: '',
    nameHistory: [],
  }));
  const [errors, setErrors] = useState<ReturnType<typeof validateRcsMember>['errors']>({});

  const startEdit = (member: RcsMember): void => {
    setEditingId(member.id);
    setDraft(draftFromMember(member));
    setErrors({});
  };

  const startAdd = (): void => {
    setEditingId(null);
    setDraft({ id: nextMemberId(members), name: '', team: 'RCS', role: 'Tester', startDate: today, endDate: '', nameHistory: [] });
    setErrors({});
  };

  const setHistoryEntry = (index: number, patch: Partial<RcsMemberNameHistory>): void => {
    setDraft((prev) => ({
      ...prev,
      nameHistory: prev.nameHistory.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)),
    }));
  };

  const addHistoryEntry = (): void => {
    setDraft((prev) => ({ ...prev, nameHistory: [...prev.nameHistory, { name: '', fromDate: '', toDate: '' }] }));
  };

  const removeHistoryEntry = (index: number): void => {
    setDraft((prev) => ({ ...prev, nameHistory: prev.nameHistory.filter((_, i) => i !== index) }));
  };

  const handleSubmit = (): void => {
    const candidate = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      team: draft.team.trim(),
      role: draft.role.trim(),
      startDate: draft.startDate,
      endDate: draft.endDate === '' ? undefined : draft.endDate,
      nameHistory: normalizeMemberNameHistory(draft.nameHistory),
    };
    const outcome = validateRcsMember(candidate, members, editingId ?? undefined);
    if (!outcome.isValid) {
      setErrors(outcome.errors);
      return;
    }
    setErrors({});
    const existing = members.find((member) => member.id === candidate.id);
    reportsApi.upsertMember({
      id: candidate.id,
      name: candidate.name,
      team: candidate.team,
      role: candidate.role,
      startDate: candidate.startDate,
      endDate: candidate.endDate,
      // Editing never changes the id, so active state survives edits.
      active: existing !== undefined ? existing.active : true,
      nameHistory: candidate.nameHistory,
    });
    startAdd();
  };

  const toggleActive = (member: RcsMember): void => {
    reportsApi.upsertMember({ ...member, active: !member.active });
  };

  /**
   * V6.9-A §29: deleting a member with identity references would destroy
   * historical identity. Such members are deactivated instead — the
   * supervisor confirms, and nothing is cascade-deleted. Unreferenced
   * members use the normal delete confirmation.
   */
  const handleRemove = (member: RcsMember): void => {
    const referenced = hasMemberReferences(
      member.id,
      memberReferenceScope({
        attendance: reportsApi.state.attendance,
        testerAssignments: reportsApi.state.testerAssignments,
        projects: reportsApi.state.projects,
        reviews: reportsApi.state.reviews,
      }),
    );
    if (referenced) {
      const proceed = window.confirm(
        t(lang, 'members.referencedCannotDelete', { name: memberLabel(lang, member) }),
      );
      if (!proceed) return;
      if (member.active) {
        reportsApi.upsertMember({ ...member, active: false });
        if (editingId === member.id) startAdd();
      }
      return;
    }
    if (window.confirm(t(lang, 'members.confirmDelete'))) {
      reportsApi.removeMember(member.id);
      if (editingId === member.id) startAdd();
    }
  };

  /**
   * Ticket identity resolution routes the ACTIVE project's tickets through
   * the app-state editing surface so the write-back stays authoritative;
   * all other projects go through the reports registry directly.
   */
  const handleSetProjectTickets = (projectRecordId: string, tickets: import('../../types').BugTicket[]): void => {
    if (projectRecordId === reportsApi.state.activeProjectId) {
      app.updateField('bugTickets', tickets);
      return;
    }
    const project = reportsApi.state.projects.find((p) => p.id === projectRecordId);
    if (project === undefined) return;
    reportsApi.updateProject(projectRecordId, { inputs: { ...project.inputs, bugTickets: tickets } });
  };

  const sorted = useMemo(
    () => [...members].sort((a, b) => a.id.localeCompare(b.id)),
    [members],
  );

  const historyErrors = errors.nameHistoryEntries ?? {};

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title-group">
          <h1>{t(lang, 'members.title')}</h1>
          <span className="app-subtitle">{t(lang, 'members.subtitle')}</span>
        </div>
      </header>

      <IdentityResolutionCenter
        lang={lang}
        attendance={reportsApi.state.attendance}
        projects={reportsApi.state.projects}
        members={members}
        testerAssignments={reportsApi.state.testerAssignments}
        reviews={reportsApi.state.reviews}
        externalIdentities={reportsApi.state.externalIdentities}
        onUpdateAttendance={reportsApi.updateAttendance}
        onSetProjectTickets={handleSetProjectTickets}
        onAppendAudit={reportsApi.appendIdentityAudit}
      />

      <section className="dr-section">
        <h2>{editingId === null ? t(lang, 'members.addMember') : `${t(lang, 'members.editMember')} — ${editingId}`}</h2>
        <form
          className="input-grid"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          {/* The profile id is internal plumbing: generated, never typed and never shown. */}
          <Field label={t(lang, 'members.name')} error={errors.name !== undefined ? t(lang, errors.name) : undefined}>
            <input
              className="input"
              type="text"
              value={draft.name}
              onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
            />
          </Field>
          {/* Team is internal-only now (kept for exports/legacy data); new members default to RCS. */}
          <Field label={t(lang, 'members.role')} error={errors.role !== undefined ? t(lang, errors.role) : undefined}>
            <input
              className="input"
              type="text"
              value={draft.role}
              onChange={(e) => setDraft((prev) => ({ ...prev, role: e.target.value }))}
            />
          </Field>
          <Field label={t(lang, 'members.startDate')} error={errors.startDate !== undefined ? t(lang, errors.startDate) : undefined}>
            <input
              className="input"
              type="date"
              value={draft.startDate}
              onChange={(e) => setDraft((prev) => ({ ...prev, startDate: e.target.value }))}
            />
          </Field>
          <Field label={t(lang, 'members.endDate')} error={errors.endDate !== undefined ? t(lang, errors.endDate) : undefined}>
            <input
              className="input"
              type="date"
              value={draft.endDate}
              onChange={(e) => setDraft((prev) => ({ ...prev, endDate: e.target.value }))}
            />
          </Field>

          {/* V6.9-A: name history editor — previous names resolve to the same stable id. */}
          <fieldset className="npf-section members-history-section">
            <legend>{t(lang, 'members.nameHistory')}</legend>
            {draft.nameHistory.length === 0 ? (
              <p className="dr-empty">{t(lang, 'members.nameHistoryNone')}</p>
            ) : (
              draft.nameHistory.map((entry, index) => (
                <div key={index} className="members-history-row">
                  <input
                    className="table-input"
                    type="text"
                    aria-label={t(lang, 'members.name')}
                    value={entry.name}
                    onChange={(e) => setHistoryEntry(index, { name: e.target.value })}
                  />
                  <input
                    className="table-input input-date"
                    type="date"
                    aria-label={t(lang, 'members.nameHistoryFrom')}
                    value={entry.fromDate}
                    onChange={(e) => setHistoryEntry(index, { fromDate: e.target.value })}
                  />
                  <input
                    className="table-input input-date"
                    type="date"
                    aria-label={t(lang, 'members.nameHistoryTo')}
                    value={entry.toDate}
                    onChange={(e) => setHistoryEntry(index, { toDate: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn-row-remove"
                    aria-label={t(lang, 'buttons.remove')}
                    title={t(lang, 'buttons.remove')}
                    onClick={() => removeHistoryEntry(index)}
                  >
                    ×
                  </button>
                  {historyErrors[index] !== undefined ? (
                    <p className="field-error">{t(lang, historyErrors[index])}</p>
                  ) : null}
                </div>
              ))
            )}
            <div className="dr-button-row">
              <button type="button" className="btn btn-ghost" onClick={addHistoryEntry}>
                {t(lang, 'members.nameHistoryAdd')}
              </button>
            </div>
          </fieldset>

          <div className="dr-button-row">
            <button type="submit" className="btn">
              {t(lang, 'members.saveMember')}
            </button>
            {editingId !== null ? (
              <button type="button" className="btn btn-ghost" onClick={startAdd}>
                {t(lang, 'buttons.close')}
              </button>
            ) : null}
          </div>
        </form>
      </section>

      <section className="dr-section">
        <h2>{t(lang, 'members.title')}</h2>
        {sorted.length === 0 ? (
          <p className="dr-empty">{t(lang, 'members.none')}</p>
        ) : (
          <div className="table-wrap">
            <table className="dr-table">
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'members.name')}</th>
                  <th scope="col">{t(lang, 'members.role')}</th>
                  <th scope="col">{t(lang, 'members.startDate')}</th>
                  <th scope="col">{t(lang, 'members.endDate')}</th>
                  <th scope="col">{t(lang, 'members.status')}</th>
                  <th scope="col">{t(lang, 'members.nameHistory')}</th>
                  <th scope="col">{t(lang, 'columns.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((member) => (
                  <tr key={member.id} className={editingId === member.id ? 'row-selected' : undefined}>
                    <td>{member.name}</td>
                    <td>{member.role}</td>
                    <td>{member.startDate}</td>
                    <td>{member.endDate ?? '—'}</td>
                    <td>{member.active ? t(lang, 'members.active') : t(lang, 'members.inactive')}</td>
                    <td className="note-cell">
                      {(member.nameHistory ?? []).length === 0
                        ? t(lang, 'members.nameHistoryNone')
                        : (member.nameHistory ?? []).map((entry) => nameHistoryEntryLabel(entry)).join(' / ')}
                    </td>
                    <td className="dr-row-actions">
                      <button type="button" className="btn" onClick={() => toggleActive(member)}>
                        {member.active ? t(lang, 'members.setInactive') : t(lang, 'members.setActive')}
                      </button>
                      <button type="button" className="btn" onClick={() => startEdit(member)}>
                        {t(lang, 'buttons.edit')}
                      </button>
                      <button type="button" className="btn btn-danger" onClick={() => handleRemove(member)}>
                        {t(lang, 'buttons.remove')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
