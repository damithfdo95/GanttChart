import { useState } from 'react';
import { t } from '../../i18n';
import { useReportsStateCtx } from '../../app/state-contexts';
import { newBuildRow } from '../../components/ProjectReferenceCard';
import type { Language, ProjectBuildRef, ProjectReference, ProjectRecord } from '../../types';

/** Test Environment & Links (SV): edit the tester-facing reference details of the active project. Collapsed by default. */
export function ProjectReferenceEditor({ lang, project }: { lang: Language; project: ProjectRecord }) {
  const reports = useReportsStateCtx();
  const [open, setOpen] = useState(false);
  const reference: ProjectReference = project.reference ?? {};
  const builds: ProjectBuildRef[] = reference.builds ?? [];

  const save = (next: ProjectReference): void => {
    const clean: ProjectReference = { ...next };
    if (clean.notes !== undefined && clean.notes.trim() === '') delete clean.notes;
    if (clean.builds !== undefined) {
      const kept = clean.builds.filter((b) => b.environment.trim() !== '' || b.applicationVersion.trim() !== '' || b.homeVersion.trim() !== '');
      if (kept.length === 0) delete clean.builds;
      else clean.builds = kept;
    }
    reports.updateProject(project.id, { reference: Object.keys(clean).length === 0 ? undefined : clean });
  };

  const setUrl = (key: 'testrailUrl' | 'questionSheetUrl' | 'buildFileUrl' | 'releaseTicketsUrl' | 'releaseManualUrl', value: string): void =>
    save({ ...reference, [key]: value.trim() === '' ? undefined : value.trim() });

  const setNotes = (value: string): void => save({ ...reference, notes: value });

  const setBuild = (index: number, patch: Partial<ProjectBuildRef>): void => {
    const next = builds.map((b, i) => (i === index ? { ...b, ...patch } : b));
    save({ ...reference, builds: next });
  };
  const addBuild = (): void => save({ ...reference, builds: [...builds, newBuildRow()] });
  const removeBuild = (index: number): void => save({ ...reference, builds: builds.filter((_, i) => i !== index) });

  return (
    <section className="dr-section" aria-labelledby="ref-editor-title">
      <div className="dr-button-row">
        <h2 id="ref-editor-title">{t(lang, 'ref.title')}</h2>
        <span className={`config-status${project.reference !== undefined ? ' config-status-ok' : ''}`}>
          {project.reference !== undefined ? `✓ ${t(lang, 'common.configured')}` : t(lang, 'common.notConfigured')}
        </span>
        <button
          type="button"
          className="btn btn-ghost panel-toggle"
          aria-expanded={open}
          aria-controls="ref-editor-body"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="panel-toggle-chevron" aria-hidden="true">{open ? '▼' : '▶'}</span>
          {t(lang, open ? 'common.collapse' : 'common.expand')}
        </button>
      </div>
      {open ? (
        <div id="ref-editor-body" className="panel-toggle-body">
          <p className="dr-summary">{t(lang, 'ref.help')}</p>
          <div className="plan-config-grid">
            {renderUrlField('testrailUrl', 'ref.testrailUrl')}
            {renderUrlField('questionSheetUrl', 'ref.questionSheetUrl')}
            {renderUrlField('buildFileUrl', 'ref.buildFileUrl')}
            {renderUrlField('releaseTicketsUrl', 'ref.releaseTicketsUrl')}
            {renderUrlField('releaseManualUrl', 'ref.releaseManualUrl')}
          </div>
          {renderBuilds()}
          {renderNotes()}
        </div>
      ) : null}
    </section>
  );

  function renderUrlField(key: 'testrailUrl' | 'questionSheetUrl' | 'buildFileUrl' | 'releaseTicketsUrl' | 'releaseManualUrl', labelKey: 'ref.testrailUrl' | 'ref.questionSheetUrl' | 'ref.buildFileUrl' | 'ref.releaseTicketsUrl' | 'ref.releaseManualUrl') {
    return (
      <label className="settings-field">
        {t(lang, labelKey)}
        <input
          className="input"
          type="url"
          placeholder="https://"
          value={reference[key] ?? ''}
          onChange={(e) => setUrl(key, e.target.value)}
        />
      </label>
    );
  }

  function renderBuilds() {
    return (
      <div>
        <h3>{t(lang, 'ref.builds')}</h3>
        <div className="table-wrap">
          <table className="dr-table ref-builds-table">
            <thead>
              <tr>
                <th>{t(lang, 'ref.environment')}</th>
                <th>{t(lang, 'ref.applicationVersion')}</th>
                <th>{t(lang, 'ref.homeVersion')}</th>
                <th>{t(lang, 'columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((build, i) => (
                <tr key={build.id}>
                  <td>
                    <input
                      className="table-input"
                      type="text"
                      placeholder={t(lang, 'ref.environmentPlaceholder')}
                      value={build.environment}
                      aria-label={`${t(lang, 'ref.environment')} (${i + 1})`}
                      onChange={(e) => setBuild(i, { environment: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="table-input"
                      type="text"
                      value={build.applicationVersion}
                      aria-label={`${t(lang, 'ref.applicationVersion')} (${i + 1})`}
                      onChange={(e) => setBuild(i, { applicationVersion: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="table-input"
                      type="text"
                      value={build.homeVersion}
                      aria-label={`${t(lang, 'ref.homeVersion')} (${i + 1})`}
                      onChange={(e) => setBuild(i, { homeVersion: e.target.value })}
                    />
                  </td>
                  <td>
                    <button type="button" className="btn-row-remove" onClick={() => removeBuild(i)}>
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn" onClick={addBuild}>
          {t(lang, 'ref.addBuild')}
        </button>
      </div>
    );
  }

  function renderNotes() {
    return (
      <label className="settings-field">
        {t(lang, 'ref.notes')}
        <textarea
          className="input"
          rows={3}
          maxLength={2000}
          value={reference.notes ?? ''}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
    );
  }
}
