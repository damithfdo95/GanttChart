import { useMemo, useState } from 'react';
import { useAskConfirm } from '../../components/ConfirmDialog';
import type { Language, RcsMember, TesterDailyPerformance, BugTicket } from '../../types';
import { t } from '../../i18n';
import { formatInteger } from '../../lib/formatting/format';
import { collectUnlinkedTesters, buildMergeNameHistoryEntry, type UnlinkedTesterEvidence } from '../../domain/identityResolution';

interface UnlinkedTestersPanelProps {
  lang: Language;
  members: readonly RcsMember[];
  allRecords: readonly TesterDailyPerformance[];
  allTickets: readonly BugTicket[];
  /** Period/project scope — the panel reflects exactly what the main view hides. */
  scope: { range?: { start: string; end: string } | null; projectIds?: readonly string[] | null };
  /** Add a name-history entry to a member (merge) or create a new member. */
  onMergeToMember: (memberId: string, recordedName: string) => void;
  onCreateMember: (recordedName: string) => void;
}

/**
 * Unlinked Testers panel (V6.10): every recorded tester name that matches no
 * Team Member, with its evidence. The supervisor confirms each one by merging
 * it into an existing member (adds the name to that member's name history so
 * all legacy records resolve to the stable id) or by creating a new member.
 * The main performance table never shows these names — only this panel does.
 */
export function UnlinkedTestersPanel({
  lang,
  members,
  allRecords,
  allTickets,
  scope,
  onMergeToMember,
  onCreateMember,
}: UnlinkedTestersPanelProps) {
  const ask = useAskConfirm(lang);
  const [expanded, setExpanded] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>({});

  const unlinked = useMemo(
    () => collectUnlinkedTesters(allRecords, allTickets, members, scope),
    [allRecords, allTickets, members, scope],
  );

  if (unlinked.length === 0) {
    return (
      <section className="dr-section">
        <h2>{t(lang, 'performance.unlinkedTitle')}</h2>
        <p className="dr-empty">{t(lang, 'performance.unlinkedNone')}</p>
      </section>
    );
  }

  const setTarget = (name: string, memberId: string): void => {
    setTargets((prev) => ({ ...prev, [name]: memberId }));
  };

  const handleMerge = async (entry: UnlinkedTesterEvidence): Promise<void> => {
    const targetId = targets[entry.name];
    if (targetId === undefined || targetId === '') return;
    const member = members.find((m) => m.id === targetId);
    if (member === undefined) return;
    if (buildMergeNameHistoryEntry(entry.name, member) === null) return;
    if (!(await ask(t(lang, 'performance.unlinkedConfirmMerge', { name: entry.name, member: member.name }), { severity: 'warning' }))) return;
    onMergeToMember(member.id, entry.name);
    setTargets((prev) => {
      const next = { ...prev };
      delete next[entry.name];
      return next;
    });
  };

  const handleCreate = async (entry: UnlinkedTesterEvidence): Promise<void> => {
    if (!(await ask(t(lang, 'performance.unlinkedConfirmCreate', { name: entry.name }), { severity: 'warning' }))) return;
    onCreateMember(entry.name);
  };

  return (
    <section className="dr-section">
      <h2>{t(lang, 'performance.unlinkedTitle')}</h2>
      <p className="dr-summary">{t(lang, 'performance.unlinkedDescription', { count: unlinked.length })}</p>
      <div className="dr-button-row">
        <button type="button" className="btn" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? t(lang, 'buttons.close') : t(lang, 'performance.unlinkedOpen', { count: unlinked.length })}
        </button>
      </div>
      {expanded ? (
        <div className="table-wrap">
          <table className="dr-table table-wide">
            <thead>
              <tr>
                <th scope="col">{t(lang, 'performance.tester')}</th>
                <th scope="col" className="num">{t(lang, 'performance.activeDays')}</th>
                <th scope="col" className="num">{t(lang, 'performance.cases')}</th>
                <th scope="col" className="num">{t(lang, 'performance.bugs')}</th>
                <th scope="col">{t(lang, 'performance.unlinkedMergeInto')}</th>
                <th scope="col">{t(lang, 'columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {unlinked.map((entry) => {
                const targetId = targets[entry.name] ?? '';
                const targetMember = members.find((m) => m.id === targetId);
                const canMerge = targetId !== '' && targetMember !== undefined && buildMergeNameHistoryEntry(entry.name, targetMember) !== null;
                return (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td className="num">{formatInteger(entry.activeDays, lang)}</td>
                    <td className="num">{formatInteger(entry.casesTested, lang)}</td>
                    <td className="num">{formatInteger(entry.bugsFound, lang)}</td>
                    <td>
                      <select
                        className="input"
                        value={targetId}
                        onChange={(e) => setTarget(entry.name, e.target.value)}
                        aria-label={t(lang, 'performance.unlinkedMergeInto')}
                      >
                        <option value="">{t(lang, 'performance.unlinkedSelectMember')}</option>
                        {members.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.name} ({member.role})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="dr-row-actions">
                      <button type="button" className="btn" disabled={!canMerge} onClick={() => handleMerge(entry)}>
                        {t(lang, 'performance.unlinkedMerge')}
                      </button>
                      <button type="button" className="btn" onClick={() => handleCreate(entry)}>
                        {t(lang, 'performance.unlinkedCreateMember')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}