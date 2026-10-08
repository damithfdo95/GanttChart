import { useState } from 'react';
import { memberLabel } from '../../domain/people';
import type { Language, RcsMember, RcsMemberNameHistory } from '../../types';
import { t } from '../../i18n';
import { Field } from '../../components/Field';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { useTenant } from '../../app/tenant-context';
import { normalizeMemberNameHistory } from '../../domain/members';
import { emailTaken, isLinked, normalizeMemberEmail } from '../../domain/teamMembers';
import { hasMemberReferences, memberReferenceScope } from '../../domain/identityResolution';
import { validateRcsMember } from '../../lib/validation/validateMember';
import { errorKey } from '../tenancy/format';
import { IdentityResolutionCenter } from './IdentityResolutionCenter';

interface MemberDraft {
  name: string;
  email: string;
  startDate: string;
  endDate: string;
  nameHistory: RcsMemberNameHistory[];
}

function draftFromMember(member: RcsMember): MemberDraft {
  return {
    name: member.name,
    email: member.email ?? '',
    startDate: member.startDate,
    endDate: member.endDate ?? '',
    nameHistory: (member.nameHistory ?? []).map((entry) => ({ name: entry.name, fromDate: entry.fromDate ?? '', toDate: entry.toDate ?? '' })),
  };
}

/**
 * Team Member profile details and identity resolution. The LIST of people (and adding, removing, role changes, logins) is the
 * Team Members directory; this opens one profile to edit what the directory does not show: dates, the previous names that older
 * records still use, and (while there is no login) the email.
 *
 * In Web storage a save goes through the server (so it is recorded in the administrative trail and checked there); in Local storage it
 * changes the workspace directly. The member id is permanent and is never shown or edited.
 */
export function RcsMembersTab({ editMemberId = null, onClose }: { editMemberId?: string | null; onClose?: () => void }) {
  const app = useAppStateCtx();
  const reportsApi = useReportsStateCtx();
  const { api } = useTenant();
  const lang: Language = app.state.language;
  const members = reportsApi.state.rcsMembers ?? [];
  const member = editMemberId === null ? undefined : members.find((m) => m.id === editMemberId);
  const [draft, setDraft] = useState<MemberDraft | null>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<ReturnType<typeof validateRcsMember>['errors']>({});
  const [emailError, setEmailError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A different profile was chosen: start its draft.
  if (member !== undefined && draftFor !== member.id) {
    setDraft(draftFromMember(member));
    setDraftFor(member.id);
    setErrors({});
    setEmailError(null);
    setSaved(null);
  }
  if (member === undefined && draftFor !== null) {
    setDraft(null);
    setDraftFor(null);
  }

  const setHistoryEntry = (index: number, patch: Partial<RcsMemberNameHistory>): void => {
    setDraft((prev) => (prev === null ? prev : { ...prev, nameHistory: prev.nameHistory.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)) }));
  };
  const addHistoryEntry = (): void => setDraft((prev) => (prev === null ? prev : { ...prev, nameHistory: [...prev.nameHistory, { name: '', fromDate: '', toDate: '' }] }));
  const removeHistoryEntry = (index: number): void => setDraft((prev) => (prev === null ? prev : { ...prev, nameHistory: prev.nameHistory.filter((_, i) => i !== index) }));

  const handleSubmit = async (): Promise<void> => {
    if (member === undefined || draft === null) return;
    const history = normalizeMemberNameHistory(draft.nameHistory);
    const candidate = { id: member.id, name: draft.name.trim(), team: member.team, role: member.role, startDate: draft.startDate, endDate: draft.endDate === '' ? undefined : draft.endDate, nameHistory: history };
    const outcome = validateRcsMember(candidate, members, member.id);
    if (!outcome.isValid) {
      setErrors(outcome.errors);
      return;
    }
    setErrors({});
    let email: string | null | undefined;
    if (!isLinked(member)) {
      email = draft.email.trim() === '' ? null : normalizeMemberEmail(draft.email);
      if (draft.email.trim() !== '' && email === null) {
        setEmailError(t(lang, 'tenancy.error.invalid_email'));
        return;
      }
      if (email !== null && emailTaken(members, email, member.id)) {
        setEmailError(t(lang, 'tenancy.error.member_email_taken'));
        return;
      }
    }
    setEmailError(null);
    if (api !== null) {
      setBusy(true);
      try {
        await api.editMember(member.id, {
          displayName: candidate.name,
          startDate: candidate.startDate,
          endDate: candidate.endDate ?? null,
          nameHistory: history.map((h) => ({ name: h.name, ...(h.fromDate === undefined ? {} : { fromDate: h.fromDate }), ...(h.toDate === undefined ? {} : { toDate: h.toDate }) })),
          ...(email === undefined ? {} : { email }),
        });
        setSaved(t(lang, 'dir.edit.saved'));
      } catch (e) {
        setEmailError(t(lang, errorKey(e)));
      } finally {
        setBusy(false);
      }
      return;
    }
    const { email: _e, ...rest } = member;
    reportsApi.upsertMember({ ...rest, name: candidate.name, startDate: candidate.startDate, endDate: candidate.endDate, nameHistory: history, ...(email === undefined ? (member.email === undefined ? {} : { email: member.email }) : email === null ? {} : { email }) });
    setSaved(t(lang, 'dir.edit.saved'));
  };

  /** A profile that nothing refers to and that has no login may be deleted for good; anything else is removed from use instead. */
  const referenced =
    member === undefined
      ? true
      : hasMemberReferences(member.id, memberReferenceScope({ attendance: reportsApi.state.attendance, testerAssignments: reportsApi.state.testerAssignments, projects: reportsApi.state.projects, reviews: reportsApi.state.reviews }));
  const canDelete = member !== undefined && !isLinked(member) && !referenced;

  const handleDelete = (): void => {
    if (member === undefined || !canDelete) return;
    if (window.confirm(t(lang, 'members.confirmDelete'))) {
      reportsApi.removeMember(member.id);
      onClose?.();
    }
  };

  /**
   * Ticket identity resolution routes the ACTIVE project's tickets through the app-state editing surface so the write-back stays
   * authoritative; all other projects go through the reports registry directly.
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

  const historyErrors = errors.nameHistoryEntries ?? {};

  return (
    <div className="app">
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

      {member === undefined || draft === null ? null : (
        <section className="dr-section" aria-labelledby="profile-edit-title">
          <h2 id="profile-edit-title">
            {t(lang, 'dir.edit.title')} — {memberLabel(lang, member)}
          </h2>
          <form
            className="input-grid"
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <Field label={t(lang, 'members.name')} error={errors.name !== undefined ? t(lang, errors.name) : undefined}>
              <input className="input" type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label={t(lang, 'dir.email')} error={emailError ?? undefined}>
              <input className="input" type="email" value={draft.email} disabled={isLinked(member)} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              {isLinked(member) ? <span className="link-help">{t(lang, 'dir.edit.emailLocked')}</span> : null}
            </Field>
            <Field label={t(lang, 'members.startDate')} error={errors.startDate !== undefined ? t(lang, errors.startDate) : undefined}>
              <input className="input" type="date" value={draft.startDate} onChange={(e) => setDraft({ ...draft, startDate: e.target.value })} />
            </Field>
            <Field label={t(lang, 'members.endDate')} error={errors.endDate !== undefined ? t(lang, errors.endDate) : undefined}>
              <input className="input" type="date" value={draft.endDate} onChange={(e) => setDraft({ ...draft, endDate: e.target.value })} />
            </Field>

            {/* V6.9-A: name history editor - previous names resolve to the same stable id. */}
            <fieldset className="npf-section members-history-section">
              <legend>{t(lang, 'members.nameHistory')}</legend>
              {draft.nameHistory.length === 0 ? (
                <p className="dr-empty">{t(lang, 'members.nameHistoryNone')}</p>
              ) : (
                draft.nameHistory.map((entry, index) => (
                  <div key={index} className="members-history-row">
                    <input className="table-input" type="text" aria-label={t(lang, 'members.name')} value={entry.name} onChange={(e) => setHistoryEntry(index, { name: e.target.value })} />
                    <input className="table-input input-date" type="date" aria-label={t(lang, 'members.nameHistoryFrom')} value={entry.fromDate} onChange={(e) => setHistoryEntry(index, { fromDate: e.target.value })} />
                    <input className="table-input input-date" type="date" aria-label={t(lang, 'members.nameHistoryTo')} value={entry.toDate} onChange={(e) => setHistoryEntry(index, { toDate: e.target.value })} />
                    <button type="button" className="btn-row-remove" aria-label={t(lang, 'buttons.remove')} title={t(lang, 'buttons.remove')} onClick={() => removeHistoryEntry(index)}>
                      ×
                    </button>
                    {historyErrors[index] !== undefined ? <p className="field-error">{t(lang, historyErrors[index])}</p> : null}
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
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {t(lang, 'dir.actions.save')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                {t(lang, 'buttons.close')}
              </button>
              {canDelete ? (
                <button type="button" className="btn btn-danger" onClick={handleDelete}>
                  {t(lang, 'buttons.remove')}
                </button>
              ) : null}
            </div>
            {saved === null ? null : (
              <p className="data-controls-message ok" role="status">
                {saved}
              </p>
            )}
          </form>
        </section>
      )}
    </div>
  );
}
