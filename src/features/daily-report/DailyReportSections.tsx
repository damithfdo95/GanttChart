/**
 * Daily Report screen sections: finalized-report banners, the EOD/morning
 * preview blocks and the history table. Extracted from DailyReport.tsx so
 * the screen file holds state wiring and derivation only.
 */

import { t, LANGUAGES, type TranslationKey } from '../../i18n';
import type { DailyReport as DailyReportEntity, Language } from '../../types';
import { publicationStatusOf } from '../../../shared/reportPublication';
import { TablePager } from '../../components/TablePager';
import type { usePagedRows } from '../../lib/pagination/usePagedRows';

type Pager = ReturnType<typeof usePagedRows<DailyReportEntity>>;

/** The delivery side of a finalized report: what the supervisor may do with it, and who published it (resolved by the screen). */
export interface ReportDeliveryControls {
  /** May this person publish (a supervisor, never a Tester) AND is the report still unpublished? */
  canPublish: boolean;
  /** Display name of the publisher (member name, else a stable id), or '' when unknown. */
  publishedByLabel: string;
  /** Text to show in a selectable box when the clipboard refused; null when there is none. */
  fallbackText: string | null;
  onCopyPlain: () => void;
  onCopyChat: () => void;
  onExport: () => void;
  onPrint: () => void;
  onMarkPublished: () => void;
}

export interface ViewingReportBannerProps {
  uiLang: Language;
  viewingReport: DailyReportEntity;
  onClose: () => void;
  onRevise: () => void;
  /** Absent in contexts that only display the report. */
  delivery?: ReportDeliveryControls;
}

export function ViewingReportBanner({ uiLang, viewingReport, onClose, onRevise, delivery }: ViewingReportBannerProps) {
  const published = publicationStatusOf(viewingReport) === 'published';
  return (
    <section className="dr-section dr-finalized">
      <h2>
        {t(uiLang, 'dailyReport.readOnly')} — {viewingReport.reportDate} (
        {LANGUAGES.find((option) => option.code === viewingReport.language)?.native ?? viewingReport.language})
        {viewingReport.revisionOf !== null ? ` · ${t(uiLang, 'dailyReport.revision', { date: viewingReport.reportDate })}` : ''}
      </h2>
      <p className="dr-summary">
        {t(uiLang, 'columns.finalizedAt')}: {viewingReport.finalizedAt ?? '—'} · {t(uiLang, 'columns.finalizedBy')}:{' '}
        {viewingReport.finalizedBy ?? '—'}
      </p>
      <p className="dr-summary" data-testid="report-publication">
        {t(uiLang, 'dailyReport.statusFinalized')} · {t(uiLang, 'columns.publication')}:{' '}
        <span className={published ? 'gap-pill ok' : 'gap-pill'}>{t(uiLang, published ? 'dailyReport.publication.published' : 'dailyReport.publication.notPublished')}</span>
        {published ? (
          <>
            {' '}
            · {t(uiLang, 'columns.publishedAt')}: {viewingReport.publishedAt ?? '—'} · {t(uiLang, 'columns.publishedBy')}: {delivery?.publishedByLabel === undefined || delivery.publishedByLabel === '' ? '—' : delivery.publishedByLabel}
            {viewingReport.publicationMethod === undefined ? '' : ` · ${t(uiLang, 'dailyReport.publication.method')}: ${t(uiLang, `dailyReport.publication.method.${viewingReport.publicationMethod}` as TranslationKey)}`}
          </>
        ) : null}
      </p>
      <pre className="dr-preview-readonly">{viewingReport.previewText}</pre>
      {delivery !== undefined ? (
        <div className="no-print">
          <div className="dr-button-row">
            <button type="button" className="btn" onClick={delivery.onCopyPlain}>
              {t(uiLang, 'dailyReport.publication.copyPlain')}
            </button>
            <button type="button" className="btn" onClick={delivery.onCopyChat}>
              {t(uiLang, 'dailyReport.publication.copyChat')}
            </button>
            <button type="button" className="btn" onClick={delivery.onExport}>
              {t(uiLang, 'buttons.exportTxt')}
            </button>
            <button type="button" className="btn" onClick={delivery.onPrint}>
              {t(uiLang, 'dailyReport.publication.print')}
            </button>
            {delivery.canPublish ? (
              <button type="button" className="btn btn-primary" onClick={delivery.onMarkPublished}>
                {t(uiLang, 'dailyReport.publication.markPublished')}
              </button>
            ) : null}
          </div>
          {delivery.canPublish ? <p className="exec-help">{t(uiLang, 'dailyReport.publication.hint')}</p> : null}
          {delivery.fallbackText !== null ? (
            <div>
              <p className="qa-warning" role="note">{t(uiLang, 'dailyReport.publication.copyManual')}</p>
              <textarea className="dr-preview" readOnly rows={10} value={delivery.fallbackText} aria-label={t(uiLang, 'dailyReport.publication.copyManual')} onFocus={(e) => e.currentTarget.select()} />
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="exec-help no-print">{t(uiLang, 'dailyReport.editRevisionHint')}</p>
      <div className="dr-button-row no-print">
        <button type="button" className="btn" onClick={onClose}>
          {t(uiLang, 'buttons.close')}
        </button>
        <button type="button" className="btn" onClick={onRevise}>
          {t(uiLang, 'buttons.revise')}
        </button>
      </div>
    </section>
  );
}

export interface FinalizedExistsBannerProps {
  uiLang: Language;
  onEditRevision: () => void;
  onView: () => void;
  onNewDraft: () => void;
}

export function FinalizedExistsBanner({ uiLang, onEditRevision, onView, onNewDraft }: FinalizedExistsBannerProps) {
  return (
    <section className="dr-section dr-finalized">
      <h2>{t(uiLang, 'dailyReport.finalizedExistsTitle')}</h2>
      <p className="dr-empty">{t(uiLang, 'dailyReport.finalizedExistsBody')}</p>
      <div className="dr-button-row">
        <button type="button" className="btn" onClick={onEditRevision}>
          {t(uiLang, 'dailyReport.editRevision')}
        </button>
        <button type="button" className="btn" onClick={onView}>
          {t(uiLang, 'buttons.view')}
        </button>
        <button type="button" className="btn" onClick={onNewDraft}>
          {t(uiLang, 'dailyReport.newDraftForDate')}
        </button>
      </div>
    </section>
  );
}

export interface EodPreviewSectionProps {
  uiLang: Language;
  hasDraft: boolean;
  previewText: string;
  onPreviewChange: (text: string) => void;
  onGenerate: () => void;
  onRefreshData: () => void;
  onSaveDraft: () => void;
  onFinalize: () => void;
  onDeleteDraft: () => void;
  onCopy: () => void;
  onExportTxt: () => void;
  onExportPdf: () => void;
  onExportExcel: () => void;
}

export function EodPreviewSection({
  uiLang,
  hasDraft,
  previewText,
  onPreviewChange,
  onGenerate,
  onRefreshData,
  onSaveDraft,
  onFinalize,
  onDeleteDraft,
  onCopy,
  onExportTxt,
  onExportPdf,
  onExportExcel,
}: EodPreviewSectionProps) {
  return (
    <section className="dr-section">
      <h2>{t(uiLang, 'dailyReport.previewSection')}</h2>
      <div className="dr-button-row">
        <button type="button" className="btn" disabled={!hasDraft} onClick={onGenerate}>
          {t(uiLang, 'buttons.generate')}
        </button>
        <button type="button" className="btn" disabled={!hasDraft} onClick={onRefreshData}>
          {t(uiLang, 'buttons.refreshData')}
        </button>
        <button type="button" className="btn" disabled={!hasDraft} onClick={onSaveDraft}>
          {t(uiLang, 'buttons.saveDraft')}
        </button>
        <button type="button" className="btn" disabled={!hasDraft} onClick={onFinalize}>
          {t(uiLang, 'buttons.finalize')}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!hasDraft}
          title={t(uiLang, 'dailyReport.deleteDraftHint')}
          onClick={onDeleteDraft}
        >
          {t(uiLang, 'buttons.deleteDraft')}
        </button>
      </div>
      <textarea
        className="dr-preview"
        rows={20}
        aria-label={t(uiLang, 'dailyReport.previewSection')}
        value={previewText}
        onChange={(e) => onPreviewChange(e.target.value)}
      />
      <div className="dr-button-row">
        <button type="button" className="btn" onClick={onCopy}>
          {t(uiLang, 'buttons.copy')}
        </button>
        <button type="button" className="btn" onClick={onExportTxt}>
          {t(uiLang, 'buttons.exportTxt')}
        </button>
        <button type="button" className="btn" onClick={onExportPdf}>
          {t(uiLang, 'buttons.exportPdf')}
        </button>
        <button type="button" className="btn" onClick={onExportExcel}>
          {t(uiLang, 'buttons.exportExcel')}
        </button>
      </div>
    </section>
  );
}

export interface MorningPreviewSectionProps {
  uiLang: Language;
  hasDraft: boolean;
  morningPreview: string;
  onPreviewChange: (text: string) => void;
  onGenerate: () => void;
  onRefreshData: () => void;
  onSaveDraft: () => void;
  onDeleteDraft: () => void;
  onCopy: () => void;
  onExportTxt: () => void;
  onExportPdf: () => void;
  onExportExcel: () => void;
}

export function MorningPreviewSection({
  uiLang,
  hasDraft,
  morningPreview,
  onPreviewChange,
  onGenerate,
  onRefreshData,
  onSaveDraft,
  onDeleteDraft,
  onCopy,
  onExportTxt,
  onExportPdf,
  onExportExcel,
}: MorningPreviewSectionProps) {
  return (
    <section className="dr-section">
      <h2>{t(uiLang, 'dailyReport.morningPreviewSection')}</h2>
      <div className="dr-button-row">
        <button type="button" className="btn" disabled={!hasDraft} onClick={onGenerate}>
          {t(uiLang, 'buttons.generate')}
        </button>
        <button type="button" className="btn" disabled={!hasDraft} onClick={onRefreshData}>
          {t(uiLang, 'buttons.refreshData')}
        </button>
        <button type="button" className="btn" disabled={!hasDraft} onClick={onSaveDraft}>
          {t(uiLang, 'buttons.saveDraft')}
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!hasDraft}
          title={t(uiLang, 'dailyReport.deleteDraftHint')}
          onClick={onDeleteDraft}
        >
          {t(uiLang, 'buttons.deleteDraft')}
        </button>
      </div>
      <textarea
        className="dr-preview"
        rows={20}
        aria-label={t(uiLang, 'dailyReport.morningPreviewSection')}
        value={morningPreview}
        onChange={(e) => onPreviewChange(e.target.value)}
      />
      <div className="dr-button-row">
        <button type="button" className="btn" onClick={onCopy}>
          {t(uiLang, 'buttons.copy')}
        </button>
        <button type="button" className="btn" onClick={onExportTxt}>
          {t(uiLang, 'buttons.exportTxt')}
        </button>
        <button type="button" className="btn" onClick={onExportPdf}>
          {t(uiLang, 'buttons.exportPdf')}
        </button>
        <button type="button" className="btn" onClick={onExportExcel}>
          {t(uiLang, 'buttons.exportExcel')}
        </button>
      </div>
    </section>
  );
}

export interface ReportHistoryTableProps {
  uiLang: Language;
  pager: Pager;
  currentDraftId: string | undefined;
  onView: (id: string) => void;
}

export function ReportHistoryTable({ uiLang, pager, currentDraftId, onView }: ReportHistoryTableProps) {
  return (
    <section className="dr-section">
      <h2>{t(uiLang, 'dailyReport.historySection')}</h2>
      <div className="table-wrap">
        <table className="dr-table">
          <thead>
            <tr>
              <th scope="col">{t(uiLang, 'columns.date')}</th>
              <th scope="col">{t(uiLang, 'columns.language')}</th>
              <th scope="col">{t(uiLang, 'columns.status')}</th>
              <th scope="col">{t(uiLang, 'columns.finalizedAt')}</th>
              <th scope="col">{t(uiLang, 'columns.finalizedBy')}</th>
              <th scope="col">{t(uiLang, 'columns.publication')}</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {pager.pagedRows.map((report) => (
              <tr
                key={report.id}
                className={
                  report.status === 'FINALIZED' ? 'completes' : currentDraftId !== undefined && report.id === currentDraftId ? 'current-draft' : undefined
                }
              >
                <td>{report.reportDate}</td>
                <td>{LANGUAGES.find((option) => option.code === report.language)?.native ?? report.language}</td>
                <td>
                  {report.status === 'FINALIZED'
                    ? t(uiLang, 'dailyReport.statusFinalized')
                    : t(uiLang, 'dailyReport.statusDraft')}
                  {report.revisionOf !== null
                    ? ` (${t(uiLang, 'dailyReport.revision', { date: report.reportDate })})`
                    : ''}
                </td>
                <td>{report.finalizedAt ?? '—'}</td>
                <td>{report.finalizedBy ?? '—'}</td>
                <td>
                  {report.status === 'FINALIZED'
                    ? t(uiLang, publicationStatusOf(report) === 'published' ? 'dailyReport.publication.published' : 'dailyReport.publication.notPublished')
                    : '—'}
                </td>
                <td>
                  <button type="button" className="btn" onClick={() => onView(report.id)}>
                    {t(uiLang, 'buttons.view')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TablePager lang={uiLang} pager={pager} />
    </section>
  );
}
