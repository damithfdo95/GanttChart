import { useId, useState, type ReactNode } from 'react';
import { t } from '../../i18n';
import type { Language } from '../../types';

interface SettingsCollapsibleProps {
  lang: Language;
  /** The section title (also the accessible name). */
  title: string;
  /** Optional status hint shown next to the title (e.g. "Configured"). */
  status?: string;
  /** Open on first render; the user can still toggle freely afterwards. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A collapsible Settings section for rarely-used components. The header keeps
 * the section title and an optional status hint, plus an Expand / Collapse
 * button (the same panel-toggle pattern as the JIRA / TestRail integrations).
 * The body is only rendered while expanded, so collapsed sections stay light.
 */
export function SettingsCollapsible({ lang, title, status, defaultOpen = false, children }: SettingsCollapsibleProps) {
  const [open, setOpen] = useState(defaultOpen);
  // One id per section: several collapsibles share the Settings page, so a fixed id would be duplicated.
  const titleId = useId();
  return (
    <section className="dr-section" aria-labelledby={titleId}>
      <div className="dr-button-row">
        <h2 id={titleId}>{title}</h2>
        {status === undefined ? null : <span className="config-status">{status}</span>}
        <button
          type="button"
          className="btn btn-ghost panel-toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="panel-toggle-chevron" aria-hidden="true">{open ? '▼' : '▶'}</span>
          {t(lang, open ? 'common.collapse' : 'common.expand')}
        </button>
      </div>
      {open ? <div className="panel-toggle-body">{children}</div> : null}
    </section>
  );
}