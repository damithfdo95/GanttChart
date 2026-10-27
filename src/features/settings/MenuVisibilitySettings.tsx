import { useMemo } from 'react';
import { useReportsStateCtx } from '../../app/state-contexts';
import { navItems } from '../../app/navigation';
import type { ScreenId } from '../../app/access';
import { t } from '../../i18n';
import type { Language } from '../../types';

interface MenuVisibilitySettingsProps {
  lang: Language;
}

/**
 * Settings → Left Menu Visibility (SV only): which screens appear in the
 * left navigation. The SV toggles each item on/off; the choice is stored in
 * the workspace settings (`hiddenNavItems`) and applied to the menu in the
 * app shell. Only screens the SV can see are offered — a Tester's own menu
 * is never affected.
 */
export function MenuVisibilitySettings({ lang }: MenuVisibilitySettingsProps) {
  const reports = useReportsStateCtx();
  const hidden = useMemo(() => new Set(reports.state.settings.hiddenNavItems ?? []), [reports.state.settings.hiddenNavItems]);

  // The SV's own menu (role 'admin') is the set of items they can toggle.
  // The Settings screen itself is never offered — you cannot hide the page
  // you are configuring from.
  const svItems = useMemo(() => navItems('admin').filter((item) => item.id !== 'settings'), []);

  const toggle = (id: ScreenId): void => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    reports.updateSettings({ hiddenNavItems: [...next].sort() });
  };

  return (
    <>
      <p className="dr-summary">{t(lang, 'settings.menuVisibility.help')}</p>
      <div className="menu-visibility-grid">
        {svItems.map((item) => {
          const isHidden = hidden.has(item.id);
          return (
            <label key={item.id} className="field-check menu-visibility-item">
              <input type="checkbox" checked={!isHidden} onChange={() => toggle(item.id)} />
              {t(lang, item.key)}
            </label>
          );
        })}
      </div>
    </>
  );
}