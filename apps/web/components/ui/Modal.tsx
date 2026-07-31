'use client';

import { useCallback, useEffect, useRef } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

/**
 * One dialog.
 *
 * There were three independent implementations — CommandPalette, VersionHistory
 * and the ShortcutSheet — each hand-rolling `fixed inset-0`, its own backdrop,
 * its own Escape listener and its own outside-click handler. None of them
 * trapped focus, so tabbing out of a modal put you on the page behind it while
 * the overlay was still up.
 */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  /*
   * Focus is its own effect, keyed on `open` ALONE.
   *
   * It started life inside the keydown effect, whose deps include `onClose`.
   * Callers pass an inline arrow for that more often than not, so the effect
   * tore down and re-ran on every render — and its cleanup calls
   * `restoreFocusTo.current.focus()`, which yanked focus straight back out of
   * the dialog. The observable result was a dialog that opened with focus still
   * on `<body>`: a keyboard user had to Tab into it, and a screen reader
   * announced nothing.
   */
  useEffect(() => {
    if (!open) return;

    // Remember where focus came from so closing returns it there. Without this
    // a keyboard user is dumped at the top of the document every time.
    restoreFocusTo.current = document.activeElement as HTMLElement | null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    /*
     * `[data-autofocus]` must be checked in its OWN query.
     *
     * A single grouped selector looks equivalent and is not: querySelector
     * returns the first match in DOCUMENT order, not in selector order, and the
     * ✕ close button is the first focusable element in the panel. So every
     * dialog opened with focus on Close — one stray Return from dismissing the
     * thing you had just opened, and a screen reader announcing "Close" instead
     * of the field.
     */
    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? panel.querySelector<HTMLElement>('input, button, a[href]'))?.focus();
    };

    /*
     * Focus synchronously first, then retry on the next frame.
     *
     * This was rAF-only, and rAF does not fire in a background or hidden tab —
     * so a dialog opened in one never received focus at all, and the effect was
     * observable even in a foreground automation context: the dialog opened
     * with `document.activeElement` still on `<body>`.
     *
     * The effect runs after commit, so the panel is already in the DOM and the
     * synchronous call is the one that normally lands. The frame-later retry
     * exists for content that mounts a tick late (a list still resolving), and
     * it checks first so it cannot steal focus back from a field the user has
     * already started typing in.
     */
    focusFirst();
    const timer = requestAnimationFrame(() => {
      if (!panelRef.current?.contains(document.activeElement)) focusFirst();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      cancelAnimationFrame(timer);
      restoreFocusTo.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      // Focus trap. Querying on each Tab rather than caching handles dialogs
      // whose contents change while open (a list that finishes loading).
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    // Capture, so a dialog opened from inside Monaco still gets its Escape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-8 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'border-line-strong bg-surface-1 max-h-[76vh] w-full overflow-hidden rounded-xl border shadow-[var(--shadow-overlay)]',
          size === 'sm' && 'max-w-sm',
          size === 'md' && 'max-w-md',
          size === 'lg' && 'max-w-2xl',
        )}
      >
        <div className="border-line flex items-start gap-3 border-b px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">{title}</h2>
            {description && <p className="text-ink-dim text-body-sm mt-1">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-faint hover:text-ink shrink-0 text-sm leading-none"
          >
            ✕
          </button>
        </div>
        {children && <div className="max-h-[52vh] overflow-y-auto px-5 py-4">{children}</div>}
        {footer && (
          <div className="border-line bg-surface-1 flex items-center justify-end gap-2 border-t px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Destructive confirmation.
 *
 * Replaces eight `window.confirm()` calls, every one of which guarded something
 * irreversible: revoking an API key, deleting an environment *and all its
 * secrets*, deleting a secret, disconnecting a remote, deleting a test, deleting
 * a folder — and approving a heal, which is the product's entire trust contract
 * ("the agent proposes, you decide") delegated to an unstyleable Chrome dialog
 * in the system font.
 *
 * The confirm button carries the specific verb ("Delete environment"), never
 * "OK". At the moment of deciding, the button label is the last thing read.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  confirmLabel,
  tone = 'danger',
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  /** Say what will actually happen, including anything that cascades. */
  body: string;
  confirmLabel: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
}) {
  const confirm = useCallback(() => {
    onConfirm();
  }, [onConfirm]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={tone} onClick={confirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-ink-dim text-body-sm leading-relaxed">{body}</p>
    </Modal>
  );
}
