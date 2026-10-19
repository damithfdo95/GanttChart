import { useState } from 'react';
import { t } from '../../i18n';
import { useConfirm } from '../../components/ConfirmDialog';
import { useReportsStateCtx } from '../../app/state-contexts';
import { distinctAssignees, nextProjectOwnerId, normalizeOwnerText } from '../../domain/projectOwners';
import type { Language, ProjectOwnerEntry } from '../../types';

type Message = { kind: 'ok' | 'error'; text: string } | null;

interface Draft {
  /** The row being edited, or null when adding a fresh row. */
  id: string | null;
  project: string;
  assignee: string;
  /** Kept when editing so a row's creation time never changes. */
  createdAt: string;
}

const EMPTY_DRAFT: Draft = { id: null, project: '', assignee: '', createdAt: '' };

/**
 * Project Owner registry (Team Members screen, below the directory): ONE
 * project paired with ONE free-text assignee per row. The assignee is not
 * a member identity — the name is typed freely, but once registered it is
 * suggested again so the same person can be picked for other projects. The
 * New Project dialog reads the same registry to offer owners.
 */
export function ProjectOwnersSection({ lang }: { lang: Language }) {
  const reportsApi = useReportsStateCtx();
  const confirm = useConfirm();
  const entries = reportsApi.state.projectOwners ?? [];
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [message, setMessage] = useState<Message>(null);

  const sorted = [...entries].sort((a, b) => a.project.localeCompare(b.project) || a.assignee.localeCompare(b.assignee));

  const startEdit = (entry: ProjectOwnerEntry): void => {
    setDraft({ id: entry.id, project: entry.project, assignee: entry.assignee, createdAt: entry.createdAt });
    setMessage(null);
  };

  const reset = (): void => {
    setDraft(EMPTY_DRAFT);
    setMessage(null);
  };

  const handleSubmit = (): void => {
    const project = normalizeOwnerText(draft.project);
    const assignee = normalizeOwnerText(draft.assignee);
    if (project === '' || assignee === '') return; // `required` guards the typed input; normalization can still empty it
    if (draft.id === null) {
      reportsApi.upsertProjectOwner({ id: nextProjectOwnerId(entries), project, assignee, createdAt: new Date().toISOString() });
      setMessage({ kind: 'ok', text: t(lang, 'po.added', { project, assignee }) });
    } else {
      // Edit keeps the SAME id (the row's identity) and the original createdAt.
      reportsApi.upsertProjectOwner({ id: draft.id, project, assignee, createdAt: draft.createdAt });
      setMessage({ kind: 'ok', text: t(lang, 'po.updated', { project, assignee }) });
    }
    setDraft(EMPTY_DRAFT);
  };

  const handleDelete = async (entry: ProjectOwnerEntry): Promise<void> => {
    const ok = await confirm({
      title: t(lang, 'po.deleteTitle', { project: entry.project, assignee: entry.assignee }),
      body: <p>{t(lang, 'po.deleteBody', { project: entry.project, assignee: entry.assignee })}</p>,
      confirmLabel: t(lang, 'po.delete'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'warning',
    });
    if (!ok) return;
    reportsApi.removeProjectOwner(entry.id);
    if (draft.id === entry.id) setDraft(EMPTY_DRAFT);
    setMessage({ kind: 'ok', text: t(lang, 'po.removed', { project: entry.project }) });
  };

  const assignees = distinctAssignees(entries);

  return (
    <>
      <section className="dr-section team-add-card" aria-labelledby="po-title">
        <h2 id="po-title">{t(lang, 'po.title')}</h2>
        <p className="dr-summary">{t(lang, 'po.help')}</p>
        <div aria-live="polite">
          {message === null ? null : (
            <p className={`data-controls-message ${message.kind}`} role={message.kind === 'error' ? 'alert' : 'status'}>
              {message.text}
            </p>
          )}
        </div>
        <form
          className="tenancy-form"
          onSubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
        >
          <div className="form-field">
            <label className="link-confirm">
              {t(lang, 'po.project')}
              <input className="input" required value={draft.project} maxLength={120} onChange={(e) => setDraft({ ...draft, project: e.target.value })} autoComplete="off" />
            </label>
          </div>
          <div className="form-field">
            <label className="link-confirm">
              {t(lang, 'po.assignee')}
              <input className="input" required value={draft.assignee} maxLength={80} list="po-assignees" onChange={(e) => setDraft({ ...draft, assignee: e.target.value })} autoComplete="off" />
            </label>
            <datalist id="po-assignees">
              {assignees.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <p className="link-help">{t(lang, 'po.assigneeHint')}</p>
          </div>
          <div className="dr-button-row">
            <button type="submit" className="btn btn-primary">
              {t(lang, draft.id === null ? 'po.add' : 'po.update')}
            </button>
            {draft.id === null ? null : (
              <button type="button" className="btn btn-ghost" onClick={reset}>
                {t(lang, 'po.cancel')}
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="dr-section team-list-card" aria-labelledby="po-list-title">
        <h2 id="po-list-title">{t(lang, 'po.title')}</h2>
        {sorted.length === 0 ? (
          <p className="tenancy-empty" role="note">
            {t(lang, 'po.empty')}
          </p>
        ) : (
          <div className="tenancy-table-wrap">
            <table className="tenancy-table">
              <caption className="sr-only">{t(lang, 'po.title')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t(lang, 'po.colProject')}</th>
                  <th scope="col">{t(lang, 'po.colAssignee')}</th>
                  <th scope="col">
                    <span className="sr-only">{t(lang, 'dir.colActions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((entry) => (
                  <tr key={entry.id}>
                    <th scope="row">
                      <strong>{entry.project}</strong>
                    </th>
                    <td>{entry.assignee}</td>
                    <td className="dr-row-actions">
                      <button type="button" className="btn btn-ghost" onClick={() => startEdit(entry)}>
                        {t(lang, 'po.edit')}
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => void handleDelete(entry)}>
                        {t(lang, 'po.delete')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}