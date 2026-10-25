import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../i18n';
import type { Language } from '../types';

/**
 * Keeps a rendering failure in ONE screen from blanking the whole app: the navigation stays usable and the person gets a calm
 * recovery state (try again, go to the Dashboard, or reload when the app itself was updated underneath them). The technical message
 * is logged to the console for support; the screen shows only a short code, never a stack trace or internal text.
 */

export type RenderFailureKind = 'update' | 'render';

/** A lazy screen that cannot be fetched after a new release is deployed fails differently from a bug in the screen. */
export function classifyRenderFailure(error: unknown): RenderFailureKind {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /ChunkLoadError|dynamically imported module|Importing a module script failed|Loading chunk|Failed to fetch dynamically/i.test(text) ? 'update' : 'render';
}

interface Props {
  lang: Language;
  /** Navigates to the Dashboard (the way out of a screen that keeps failing). */
  onHome: () => void;
  children: ReactNode;
}

interface State {
  failure: RenderFailureKind | null;
  at: string | null;
}

export function RenderFailure({ lang, kind, at, onRetry, onHome }: { lang: Language; kind: RenderFailureKind; at: string | null; onRetry: () => void; onHome: () => void }) {
  return (
    <section className="dr-section" role="alert" aria-labelledby="render-failure-title">
      <h2 id="render-failure-title">{t(lang, kind === 'update' ? 'error.update.title' : 'error.render.title')}</h2>
      <p>{t(lang, kind === 'update' ? 'error.update.body' : 'error.render.body')}</p>
      <div className="dr-button-row">
        {kind === 'update' ? (
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            {t(lang, 'error.reload')}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" onClick={onRetry}>
            {t(lang, 'error.retry')}
          </button>
        )}
        <button type="button" className="btn" onClick={onHome}>
          {t(lang, 'error.home')}
        </button>
      </div>
      {at !== null ? <p className="exec-help">{t(lang, 'error.code', { code: kind === 'update' ? 'APP_UPDATED' : 'SCREEN_RENDER_FAILED', at })}</p> : null}
    </section>
  );
}

export class ScreenErrorBoundary extends Component<Props, State> {
  override state: State = { failure: null, at: null };

  static getDerivedStateFromError(error: unknown): State {
    return { failure: classifyRenderFailure(error), at: new Date().toISOString() };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Not swallowed: the technical detail goes to the console (and any browser error monitoring), the screen shows a short code.
    console.error('screen render failed', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.failure === null) return this.props.children;
    return (
      <RenderFailure
        lang={this.props.lang}
        kind={this.state.failure}
        at={this.state.at}
        onRetry={() => this.setState({ failure: null, at: null })}
        onHome={() => {
          this.setState({ failure: null, at: null });
          this.props.onHome();
        }}
      />
    );
  }
}
