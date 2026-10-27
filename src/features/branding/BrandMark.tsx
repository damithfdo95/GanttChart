import { useReportsStateCtx } from '../../app/state-contexts';
import { logoSrc, usableBranding } from '../../../shared/branding';
import { toolNameOf } from '../../domain/branding';
import type { Language } from '../../types';

/**
 * The workspace logo, shown after sign-in only. Anything missing, damaged or unsupported shows nothing at all (never a broken image), and the
 * picture is only ever built from a record that passed the same check the server applies.
 */
export function useLogo(): string | null {
  const reports = useReportsStateCtx();
  for (const b of reports.state.brandings ?? []) {
    const ok = usableBranding(b);
    if (ok !== null) return logoSrc(ok);
  }
  return null;
}

/**
 * The sidebar brand: the logo (when one exists) with the workspace name beside it; without a logo the name stands alone. A long name
 * wraps instead of overflowing. The picture is decorative because the name is always written out next to it.
 */
export function SidebarBrandMark({ lang }: { lang: Language }) {
  const src = useLogo();
  const reports = useReportsStateCtx();
  const name = toolNameOf(reports.state.settings, lang);
  if (src === null) return <span className="brand-mark brand-mark--textonly">{name}</span>;
  return (
    <span className="brand-mark">
      <img className="brand-logo" src={src} alt="" />
      <span className="brand-mark-name">{name}</span>
    </span>
  );
}

export function BrandMark({ lang, className = 'brand-logo' }: { lang: Language; className?: string }) {
  const src = useLogo();
  const reports = useReportsStateCtx();
  if (src === null) return null;
  return <img className={className} src={src} alt={toolNameOf(reports.state.settings, lang)} />;
}
