import { useMemo } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useConfirm } from '../../components/ConfirmDialog';
import { applyPlaceholderCleanup, planPlaceholderCleanup } from '../../domain/members/legacyPlaceholders';
import { t } from '../../i18n';
import type { Language } from '../../types';

/**
 * Older workspaces were created with eight placeholder people (USER0001 to USER0008). Nothing creates them any more. If they are still
 * in this workspace, an SV can clean them up here: placeholders nothing refers to are removed; placeholders that attendance, tickets,
 * performance, assignments or reviews refer to are kept for the history but become inactive, so no selector offers them. Nothing is
 * converted into a real account and nothing is guessed from a name.
 */
export function LegacyPlaceholderNotice({ lang }: { lang: Language }) {
  const reports = useReportsStateCtx();
  const confirm = useConfirm();
  const s = reports.state;
  const plan = useMemo(() => planPlaceholderCleanup(s.rcsMembers ?? [], { attendance: s.attendance, testerAssignments: s.testerAssignments, projects: s.projects, reviews: s.reviews }), [s.rcsMembers, s.attendance, s.testerAssignments, s.projects, s.reviews]);
  if (plan.remove.length === 0 && plan.retire.length === 0) return null;

  const run = async (): Promise<void> => {
    const ok = await confirm({
      title: t(lang, 'tenancy.legacy.confirmTitle'),
      body: <p>{t(lang, 'tenancy.legacy.confirmBody', { remove: plan.remove.length, retire: plan.retire.length })}</p>,
      confirmLabel: t(lang, 'tenancy.legacy.clean'),
      cancelLabel: t(lang, 'tenancy.cancel'),
      severity: 'warning',
    });
    if (!ok) return;
    reports.setRcsMembers(applyPlaceholderCleanup(s.rcsMembers ?? [], plan));
  };

  return (
    <section className="dr-section" role="note" aria-labelledby="legacy-title">
      <h2 id="legacy-title">{t(lang, 'tenancy.legacy.title')}</h2>
      <p>{t(lang, 'tenancy.legacy.body', { remove: plan.remove.length, retire: plan.retire.length })}</p>
      <button type="button" className="btn" onClick={() => void run()}>
        {t(lang, 'tenancy.legacy.clean')}
      </button>
    </section>
  );
}
