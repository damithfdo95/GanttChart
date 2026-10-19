import { t } from '../i18n';
import { generateId } from '../lib/id';
import type { Language, ProjectBuildRef, ProjectRecord } from '../types';

/** True when a value looks like an http(s) URL (rendered as a link then). */
export function isLinkable(value: string | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim()) && value.trim() !== '';
}

/**
 * The tester-facing reference card of one project: its builds (environment →
 * Application / Home version) and every URL a Tester needs to start work.
 * All URLs open in a NEW TAB (target=_blank + rel=noopener noreferrer).
 * Purely presentational — the SV edits this data in the Gantt Planning View.
 */

export function ProjectReferenceCard({ lang, project }: { lang: Language; project: ProjectRecord }) {
  const reference = project.reference;
  const testrailUrl = reference?.testrailUrl ?? project.testrailPlanUrl;
  const builds = (reference?.builds ?? []).filter(
    (b) => b.environment.trim() !== '' || b.applicationVersion.trim() !== '' || b.homeVersion.trim() !== '',
  );
  const links = [
    { key: 'ref.testrailUrl', url: testrailUrl },
    { key: 'ref.questionSheetUrl', url: reference?.questionSheetUrl },
    { key: 'ref.buildFileUrl', url: reference?.buildFileUrl },
    { key: 'ref.releaseTicketsUrl', url: reference?.releaseTicketsUrl },
    { key: 'ref.releaseManualUrl', url: reference?.releaseManualUrl },
  ].filter((l): l is { key: 'ref.testrailUrl' | 'ref.questionSheetUrl' | 'ref.buildFileUrl' | 'ref.releaseTicketsUrl' | 'ref.releaseManualUrl'; url: string } => isLinkable(l.url));
  if (reference === undefined && builds.length === 0) return null;
  return (
    <section className="dr-section ref-card" aria-labelledby={`ref-title-${project.id}`}>
      <h2 id={`ref-title-${project.id}`}>{t(lang, 'ref.title')}</h2>
      {builds.length > 0 ? (
        <div className="table-wrap">
          <table className="dr-table ref-builds-table">
            <thead>
              <tr>
                <th>{t(lang, 'ref.environment')}</th>
                <th>{t(lang, 'ref.applicationVersion')}</th>
                <th>{t(lang, 'ref.homeVersion')}</th>
              </tr>
            </thead>
            <tbody>
              {builds.map((build) => (
                <tr key={build.id}>
                  <td>{build.environment.trim()}</td>
                  <td className="num">{build.applicationVersion.trim() === '' ? '—' : build.applicationVersion.trim()}</td>
                  <td className="num">{build.homeVersion.trim() === '' ? '—' : build.homeVersion.trim()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {links.length > 0 ? (
        <ul className="ref-links">
          {links.map((link) => (
            <li key={link.key}>
              <span className="ref-link-label">{t(lang, link.key)}</span>
              <a href={link.url} target="_blank" rel="noopener noreferrer">
                {link.url.replace(/^https?:\/\//i, '')}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {reference?.notes !== undefined && reference.notes.trim() !== '' ? (
        <p className="ref-notes">{reference.notes}</p>
      ) : null}
    </section>
  );
}

/** An empty build row for the editor (id generated once per row). */
export function newBuildRow(): ProjectBuildRef {
  return { id: generateId(), environment: '', applicationVersion: '', homeVersion: '' };
}
