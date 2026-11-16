import { useState } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { useAccess } from '../../app/access';
import type { Language, TransferChangeType } from '../../types';

export function AssignmentsTab({ lang, today }: { lang: Language; today: string }) {
  const reports = useReportsStateCtx();
  const access = useAccess();
  const s = reports.state;
  const [memberId, setMemberId] = useState(s.rcsMembers?.[0]?.id ?? '');
  const [toTeamId, setToTeamId] = useState(s.teams?.[0]?.id ?? '');
  const [kind, setKind] = useState<TransferChangeType>('PERMANENT_TRANSFER');
  const memberships = s.teamMemberships ?? [];
  const transfers = s.teamTransfers ?? [];
  const name = new Map((s.rcsMembers ?? []).map((m) => [m.id, m.name]));
  const team = new Map((s.teams ?? []).map((t) => [t.id, t.name]));
  const create = async () => {
    const current = memberships.find((m) => m.memberId === memberId && m.membershipKind === 'PRIMARY' && m.status === 'ACTIVE');
    if (!current || !toTeamId || current.teamId === toTeamId) return;
    const now = new Date().toISOString();
    const temporary = kind.startsWith('TEMPORARY');
    const plannedEndDate = temporary ? new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10) : undefined;
    const transfer = { id: `TR-${crypto.randomUUID()}`, memberId, fromTeamId: current.teamId, toTeamId, changeType: kind, effectiveDate: today, ...(plannedEndDate ? { plannedEndDate } : {}), status: temporary ? 'SCHEDULED' as const : 'COMPLETED' as const, sourceApproverId: access.userId ?? 'local', destinationApproverId: access.userId ?? 'local', createdBy: access.userId ?? 'local', createdAt: now, ...(!temporary ? { completedAt: now } : {}) };
    if (access.role !== null) { await fetch('/api/tenant/transfers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transfer) }); return; }
    reports.upsertTeamMembership({ ...current, effectiveTo: today, status: 'ENDED' });
    reports.upsertTeamMembership({ id: `TMB-${crypto.randomUUID()}`, memberId, teamId: toTeamId, membershipKind: kind === 'TEMPORARY_SUPPORT' ? 'SUPPORT' : kind === 'PERMANENT_SECONDARY_ASSIGNMENT' ? 'SECONDARY' : 'PRIMARY', durationType: temporary ? 'TEMPORARY' : 'PERMANENT', effectiveFrom: today, ...(plannedEndDate ? { effectiveTo: plannedEndDate } : {}), status: 'ACTIVE', createdBy: access.userId ?? 'local', createdAt: now });
    reports.upsertTeamTransfer(transfer);
  };
  return <section className="dr-section"><h2>{lang === 'ja' ? 'アサインと異動' : 'Assignments & Transfers'}</h2>
    {access.canManage ? <div className="form-grid"><label>{lang === 'ja' ? 'メンバー' : 'Member'}<select value={memberId} onChange={(e) => setMemberId(e.target.value)}>{(s.rcsMembers ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>{lang === 'ja' ? '異動先' : 'Destination'}<select value={toTeamId} onChange={(e) => setToTeamId(e.target.value)}>{(s.teams ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>{lang === 'ja' ? '種類' : 'Type'}<select value={kind} onChange={(e) => setKind(e.target.value as TransferChangeType)}><option>PERMANENT_TRANSFER</option><option>TEMPORARY_PRIMARY_TRANSFER</option><option>TEMPORARY_SUPPORT</option><option>PERMANENT_SECONDARY_ASSIGNMENT</option></select></label><button className="btn btn-primary" type="button" onClick={create}>{lang === 'ja' ? '適用' : 'Apply transfer'}</button></div> : null}
    <table className="data-table"><thead><tr><th>{lang === 'ja' ? 'メンバー' : 'Member'}</th><th>{lang === 'ja' ? '移動' : 'Movement'}</th><th>{lang === 'ja' ? '日付' : 'Date'}</th><th>Status</th></tr></thead><tbody>{transfers.map((x) => <tr key={x.id}><td>{name.get(x.memberId) ?? x.memberId}</td><td>{team.get(x.fromTeamId)} → {team.get(x.toTeamId)}</td><td>{x.effectiveDate}</td><td>{x.status}</td></tr>)}</tbody></table></section>;
}
