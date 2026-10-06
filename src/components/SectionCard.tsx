import type { ReactNode } from 'react';

type Span = 3 | 4 | 5 | 12;

interface SectionCardProps {
  title: string;
  subtitle?: string;
  span?: Span;
  children: ReactNode;
}

const SPAN_CLASS: Record<Span, string> = {
  3: 'span-3',
  4: 'span-4',
  5: 'span-5',
  12: 'span-12',
};

/** Dashboard section container with bilingual title (e.g. 入力条件 / INPUT). */
export function SectionCard({ title, subtitle, span = 12, children }: SectionCardProps) {
  return (
    <section className={`section-card ${SPAN_CLASS[span]}`}>
      <header className="section-card-header">
        <h2>{title}</h2>
        {subtitle ? <span className="section-card-subtitle">{subtitle}</span> : null}
      </header>
      <div>{children}</div>
    </section>
  );
}
