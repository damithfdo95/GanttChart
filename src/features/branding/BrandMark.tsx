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

export function BrandMark({ lang, className = 'brand-logo' }: { lang: Language; className?: string }) {
  const src = useLogo();
  const reports = useReportsStateCtx();
  if (src === null) return null;
  return <img className={className} src={src} alt={toolNameOf(reports.state.settings, lang)} />;
}
