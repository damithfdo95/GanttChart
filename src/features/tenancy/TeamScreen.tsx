import { useCallback } from 'react';
import { useTenant } from '../../app/tenant-context';
import { useAppStateCtx, useReportsStateCtx } from '../../app/state-contexts';
import { ownMemberOf } from '../../app/access';
import { resolveBilingualName } from '../../i18n';
import { RcsMembersTab } from '../members/RcsMembersTab';
import { t } from '../../i18n';
import type { PrincipalDto, StorageMode } from '../../../shared/tenancy';
import type { TenancyApi } from '../../lib/tenancy/api';
import type { Language, ProjectRecord, RcsMember, TesterProjectAssignment } from '../../types';
import { AuditLog } from './AuditLog';
import { StatusBadge, UsersManager } from './UsersManager';
import { TesterWorkload } from './TesterWorkload';

/** What each storage mode means, in plain words. Used wherever a person decides or wonders. */
export function StorageModeExplainer({ lang, mode }: { lang: Language; mode: StorageMode }) {
  const items = mode === 'web' ? (['web1', 'web2', 'web3', 'web4'] as const) : (['local1', 'local2', 'local3', 'local4'] as const);
  return (
    <div className="storage-explainer" role="note">
      <strong>{t(lang, mode === 'web' ? 'tenancy.storage.webTitle' : 'tenancy.storage.localTitle')}</strong>
      <ul>
        {items.map((k) => (
          <li key={k}>{t(lang, `tenancy.storage.${k}`)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Team Members. An SV manages the workspace's people (Web storage) and the roster of profiles; a Tester sees only their own
 * profile. In Local storage it explains why nobody can be added, instead of showing a dead button.
 */
export function TeamScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { principal, api } = useTenant();
  const { state } = useAppStateCtx();
  const reports = useReportsStateCtx();
  if (principal === null || api === null) return null;
  const lang = state.language;
  const members = reports.state.rcsMembers ?? [];
  if (principal.role === 'user') {
    return <MyProfile lang={lang} principal={principal} members={members} projects={reports.state.projects} assignments={reports.state.testerAssignments ?? []} />;
  }
  return (
    <>
      <TeamView lang={lang} principal={principal} api={api} members={members} onOpenSettings={onOpenSettings} />
      {principal.role === 'admin' && principal.tenant?.storageMode === 'web' ? <TesterWorkload lang={lang} /> : null}
      {principal.role === 'admin' ? <RcsMembersTab /> : null}
    </>
  );
}

/** "My Team Member Profile": what a Tester sees on the Team Members screen. Nothing about anyone else. */
export function MyProfile({
  lang,
  principal,
  members,
  projects,
  assignments,
}: {
  lang: Language;
  principal: PrincipalDto;
  members: readonly RcsMember[];
  projects: readonly ProjectRecord[];
  assignments: readonly TesterProjectAssignment[];
}) {
  const own = ownMemberOf(members, principal.userId);
  const mine = principal.userId === null ? [] : assignments.filter((a) => a.userId === principal.userId && a.active && (a.endDate === undefined || a.endDate === '' || a.endDate >= new Date().toISOString().slice(0, 10)));
  const projectName = (stable: string): string => {
    const p = projects.find((x) => x.projectId === stable);
    return p === undefined ? stable : `${resolveBilingualName(lang, { nameEn: p.nameEn, nameJa: p.nameJa }) || stable} (${stable})`;
  };
  return (
    <div className="team-screen">
      <section className="dr-section" aria-labelledby="my-profile-title">
        <h1 id="my-profile-title">{t(lang, 'team.myProfile.title')}</h1>
        <p className="dr-summary">{t(lang, 'team.myProfile.help')}</p>
        <dl className="cc-facts">
          <div>
            <dt>{t(lang, 'team.myProfile.name')}</dt>
            <dd>{principal.displayName ?? own?.name ?? '—'}</dd>
          </div>
          <div>
            <dt>{t(lang, 'tenancy.users.emailLabel')}</dt>
            <dd>{principal.email}</dd>
          </div>
          <div>
            <dt>{t(lang, 'tenancy.users.colRole')}</dt>
            <dd>{t(lang, 'tenancy.role.tester')}</dd>
          </div>
          <div>
            <dt>{t(lang, 'tenancy.users.colStatus')}</dt>
            <dd>
              <StatusBadge lang={lang} status="active" />
            </dd>
          </div>
          <div>
            <dt>{t(lang, 'team.myProfile.workspace')}</dt>
            <dd>{principal.tenant?.name ?? '—'}</dd>
          </div>
          <div>
            <dt>{t(lang, 'team.myProfile.profileId')}</dt>
            <dd>{own?.id ?? t(lang, 'tenancy.members.noProfile')}</dd>
          </div>
        </dl>
        {own === null ? <p role="note">{t(lang, 'team.myProfile.notLinked')}</p> : null}
        <h2>{t(lang, 'team.myProfile.assigned')}</h2>
        {mine.length === 0 ? (
          <p>{t(lang, 'team.myProfile.assignedNone')}</p>
        ) : (
          <ul>
            {mine.map((a) => (
              <li key={a.id}>{projectName(a.projectId)}</li>
            ))}
          </ul>
        )}
        <p className="link-help">{t(lang, 'team.myProfile.readOnlyNote')}</p>
      </section>
    </div>
  );
}

/** The SV's screen itself, independent of app state so it can be rendered and tested on its own. */
export function TeamView({ lang, principal, api, members = [], onOpenSettings }: { lang: Language; principal: PrincipalDto; api: TenancyApi; members?: readonly RcsMember[]; onOpenSettings: () => void }) {
  const loadAudit = useCallback(() => api.tenantAudit(), [api]);
  if (principal.tenant === null || principal.role !== 'admin') return null;
  const tenant = principal.tenant;

  return (
    <div className="team-screen">
      <header className="dr-section">
        <h1>{t(lang, 'team.title')}</h1>
        <p>
          <strong>{tenant.name}</strong> · {t(lang, tenant.storageMode === 'web' ? 'tenancy.mode.web' : 'tenancy.mode.local')} · {t(lang, principal.isOwner ? 'tenancy.owner.youAre' : 'tenancy.role.sv')}
        </p>
      </header>
      {tenant.storageMode === 'web' ? (
        <>
          <UsersManager lang={lang} api={api} members={members} currentUserId={principal.userId} />
          <AuditLog lang={lang} load={loadAudit} title={t(lang, 'tenancy.audit.workspaceTitle')} emptyKey="tenancy.audit.empty" />
        </>
      ) : (
        <>
          <section className="dr-section tenancy-empty" aria-labelledby="team-local-title">
            <h2 id="team-local-title">{t(lang, 'team.members.title')}</h2>
            <p role="status">
              <strong>{t(lang, 'tenancy.users.localOnly')}</strong>
            </p>
            <StorageModeExplainer lang={lang} mode="local" />
            <StorageModeExplainer lang={lang} mode="web" />
            <button type="button" className="btn btn-primary" onClick={onOpenSettings}>
              {t(lang, 'team.openStorageSettings')}
            </button>
          </section>
          <AuditLog lang={lang} load={loadAudit} title={t(lang, 'tenancy.audit.workspaceTitle')} emptyKey="tenancy.audit.empty" />
        </>
      )}
    </div>
  );
}
