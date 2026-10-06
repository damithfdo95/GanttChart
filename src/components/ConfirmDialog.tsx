import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

/**
 * One accessible confirmation dialog for consequential actions.
 *
 *  - `severity` sets the tone: "normal" (reversible), "warning" (reversible but disruptive,
 *    e.g. locks people out), "danger" (permanent). The confirm button is styled to match.
 *  - `typed` asks the person to type exact words before the confirm button works (permanent
 *    actions). The server checks the same words again; this is a guard against slips, not security.
 *  - Keyboard: focus moves into the dialog (to Cancel for warning/danger, so Enter never confirms
 *    by accident), Tab stays inside, Escape cancels, focus returns to where it was.
 *  - The meaning is carried by words and a symbol, never by colour alone.
 */

export type ConfirmSeverity = 'normal' | 'warning' | 'danger';

export interface TypedConfirmation {
  label: string;
  /** What must be typed. */
  expected: string;
  /** Compare case-insensitively and ignoring surrounding spaces (for email addresses). */
  loose?: boolean;
}

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  severity?: ConfirmSeverity;
  typed?: TypedConfirmation[];
}

export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

/** Does what the person typed satisfy every required confirmation? */
export function typedSatisfied(typed: readonly TypedConfirmation[] | undefined, values: readonly string[]): boolean {
  if (typed === undefined || typed.length === 0) return true;
  return typed.every((t, i) => {
    const v = values[i] ?? '';
    return t.loose === true ? v.trim().toLowerCase() === t.expected.trim().toLowerCase() : v === t.expected;
  });
}

const SYMBOL: Record<ConfirmSeverity, string> = { normal: 'ℹ', warning: '⚠', danger: '⛔' };

const ConfirmContext = createContext<ConfirmFn | null>(null);

/** `await confirm({...})` -> true when confirmed, false on Cancel / Escape. */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (confirm === null) {
    // Outside a provider (e.g. an isolated render) nothing may proceed silently.
    return () => Promise.resolve(false);
  }
  return confirm;
}

interface Pending {
  options: ConfirmOptions;
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is open cancels the first (never two stacked dialogs).
        setPending((previous) => {
          previous?.resolve(false);
          return { options, resolve };
        });
      }),
    [],
  );

  const settle = (ok: boolean): void => {
    pending?.resolve(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending === null ? null : <ConfirmDialog options={pending.options} onSettle={settle} />}
    </ConfirmContext.Provider>
  );
}

export function ConfirmDialog({ options, onSettle }: { options: ConfirmOptions; onSettle: (ok: boolean) => void }) {
  const { title, body, confirmLabel, cancelLabel, typed } = options;
  const severity = options.severity ?? 'normal';
  const [values, setValues] = useState<string[]>(() => (typed ?? []).map(() => ''));
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const ok = typedSatisfied(typed, values);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Cancel first for anything consequential; a plain confirmation may start on the confirm button.
    (severity === 'normal' ? confirmRef.current : cancelRef.current)?.focus();
    return () => previous?.focus?.();
  }, [severity]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onSettle(false);
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input, [href], select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="confirm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onSettle(false)}>
      <div ref={ref} className={`confirm-dialog confirm-${severity}`} role={severity === 'normal' ? 'dialog' : 'alertdialog'} aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onKeyDown={onKeyDown}>
        <h2 id={titleId} className="confirm-title">
          <span aria-hidden="true">{SYMBOL[severity]} </span>
          {title}
        </h2>
        <div id={bodyId} className="confirm-body">
          {body}
        </div>
        {(typed ?? []).map((t, i) => (
          <label key={t.label} className="link-confirm">
            {t.label}
            <input
              className="input"
              value={values[i] ?? ''}
              onChange={(e) => setValues((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => e.key === 'Enter' && ok && onSettle(true)}
            />
          </label>
        ))}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn" onClick={() => onSettle(false)}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" className={`btn ${severity === 'danger' ? 'btn-danger' : severity === 'warning' ? 'btn-warning' : 'btn-primary'}`} disabled={!ok} onClick={() => onSettle(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
