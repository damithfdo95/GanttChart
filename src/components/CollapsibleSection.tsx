import type { ReactNode } from 'react';

interface CollapsibleSectionProps {
  title: string;
  /** Bilingual subtitle shown next to the title (e.g. the other language). */
  subtitle?: string;
  /** Open on first render; the user can still toggle freely afterwards. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * Progressive-disclosure section (usability pass): a full-width section
 * card whose header is a native <details> summary — collapsible content
 * without extra state or libraries. Keyboard and screen-reader support come
 * free from the native element.
 */
export function CollapsibleSection({ title, subtitle, defaultOpen = false, children }: CollapsibleSectionProps) {
  return (
    <details className="section-card collapsible-section span-12" open={defaultOpen}>
      <summary className="collapsible-summary">
        <h2>{title}</h2>
        {subtitle ? <span className="section-card-subtitle">{subtitle}</span> : null}
        <span className="collapsible-chevron" aria-hidden="true">▶</span>
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}
