'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Transient feedback.
 *
 * Most of what QAAI does is slow and happens somewhere else — a run is queued
 * on a worker, a push goes to GitHub, a login is driven in a real browser. Up
 * to now those finished silently, so the honest user experience was "press the
 * button, wait, guess". A toast is the smallest thing that closes that loop.
 *
 * Deliberately not a notification centre: toasts are for the result of
 * something the user just did. Anything that matters after they navigate away
 * belongs in the run record, not here.
 */

export type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional one-click follow-up, e.g. "View run". */
  action?: { label: string; run: () => void };
}

interface ToastApi {
  toast: (kind: ToastKind, message: string, action?: Toast['action']) => void;
  success: (message: string, action?: Toast['action']) => void;
  error: (message: string, action?: Toast['action']) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/**
 * Errors stay until dismissed.
 *
 * A failure that vanishes after four seconds is a failure the user cannot act
 * on — they look away, and the only record of what went wrong is gone. Success
 * is different: it needs acknowledging, not reading.
 */
const DISMISS_MS: Record<ToastKind, number | null> = {
  success: 4000,
  info: 6000,
  error: null,
};

let nextId = 1;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((kind: ToastKind, message: string, action?: Toast['action']) => {
    const id = nextId++;
    // Cap the stack. A loop that fails 200 times should not paper over the app;
    // the oldest go, because the newest are the ones being reacted to.
    setToasts((current) => [...current, { id, kind, message, action }].slice(-4));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      toast,
      success: (message, action) => toast('success', message, action),
      error: (message, action) => toast('error', message, action),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // `pointer-events-none` on the stack, re-enabled per toast, so the
        // column never blocks clicks on the page behind it.
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const STYLE: Record<ToastKind, { border: string; dot: string; label: string }> = {
  success: { border: 'border-pass/40', dot: 'bg-pass', label: 'Success' },
  error: { border: 'border-fail/40', dot: 'bg-fail', label: 'Error' },
  info: { border: 'border-line-strong', dot: 'bg-accent', label: 'Info' },
};

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const ms = DISMISS_MS[toast.kind];
    if (ms === null) return;
    const timer = setTimeout(onDismiss, ms);
    return () => clearTimeout(timer);
  }, [toast.kind, onDismiss]);

  const style = STYLE[toast.kind];

  return (
    <div
      // Errors assert so a screen reader interrupts; success is polite.
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto bg-surface-1 flex items-start gap-2.5 rounded-lg border px-3.5 py-3 shadow-[var(--shadow-overlay)] ${style.border}`}
    >
      <span
        className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-row text-ink break-words">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.run();
              onDismiss();
            }}
            className="text-accent text-row-sub mt-1.5 font-medium hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-ink-faint hover:text-ink shrink-0 text-sm leading-none"
        aria-label={`Dismiss ${style.label.toLowerCase()}`}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Never throws when there is no provider.
 *
 * A missing provider should not take a page down over a status message, and
 * several surfaces here render outside the shell. Falling back to a no-op that
 * still logs keeps the failure visible to a developer and invisible to a user.
 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  return (
    context ?? {
      toast: (kind, message) => console.warn(`[toast:${kind}] ${message}`),
      success: (message) => console.warn(`[toast:success] ${message}`),
      error: (message) => console.warn(`[toast:error] ${message}`),
    }
  );
}
