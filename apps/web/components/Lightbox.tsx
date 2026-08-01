'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StatusDot } from './ui';
import { cn } from '../lib/cn';

/**
 * The screenshot, at a size a person can actually read.
 *
 * The evidence rail renders a 1280×720 capture into a ~380px column, which is
 * a 30% downscale — text in it is illegible, and the screenshot is the single
 * artifact the product's pitch rests on ("here is what your app looked like
 * when it broke"). This opens it full-viewport with pan/zoom, walks the failing
 * test's captures with the arrow keys, and closes on Escape.
 *
 * ── Why this is not built on components/ui/Modal ──────────────────────────────
 * It should be, and the intent was to. Modal's panel is hard-capped at
 * `max-w-2xl` / `max-h-[76vh]` with `overflow-hidden`, its body at
 * `max-h-[52vh]`, and its only size knob is 'sm' | 'md' | 'lg' — there is no
 * escape hatch a caller can use. A 672px-wide viewport for a 1280px screenshot
 * is not meaningfully better than the 380px rail we are fixing, so hosting the
 * lightbox in it would defeat the change. Adding `size="full"` to Modal is the
 * right fix and is a two-line change — but Modal.tsx is owned by another agent
 * this cycle and is off limits here.
 *
 * So the focus contract is reproduced deliberately and identically to Modal's,
 * not casually re-invented: remember the previously focused element and restore
 * it on close, focus into the panel on open, lock body scroll, trap Tab, and
 * take Escape on the CAPTURE phase so a dialog opened from inside Monaco still
 * gets it. When Modal grows a full-bleed size, this component should be
 * reduced to its <Modal> body and these two effects deleted.
 */

export interface Shot {
  /** The step this capture belongs to — what the header names and what the
   *  parent selects when the arrow keys move. */
  stepIndex: number;
  title: string;
  status: string;
  src: string;
  alt: string;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;

/** Fit the whole image in the box, but never upscale — a blurry 2× of a small
 *  capture reads as a broken screenshot rather than a small one. */
function fitScale(natural: { w: number; h: number }, box: { w: number; h: number }): number {
  if (!natural.w || !natural.h || !box.w || !box.h) return 1;
  return Math.min(1, box.w / natural.w, box.h / natural.h);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function Lightbox({
  open,
  shots,
  index,
  onIndex,
  onClose,
  testName,
}: {
  open: boolean;
  shots: Shot[];
  /** Index into `shots`. Owned by the parent so closing leaves the rail on
   *  whatever step you arrowed to. */
  index: number;
  onIndex: (next: number) => void;
  onClose: () => void;
  testName: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  const shot = shots[index] ?? null;

  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  /** Null until the image has loaded at least once, so we don't flash a
   *  "0 × 0" size readout or fit against a natural size we don't have yet. */
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);

  const fit = fitScale(natural, box);

  /*
   * Pan is clamped to the image's own edges: at any zoom you can reach every
   * part of the capture and no further. Without this a stray drag throws the
   * screenshot off-screen and the only recovery is closing and reopening.
   */
  const clampPan = useCallback(
    (p: { x: number; y: number }, s: number) => {
      const overflowX = Math.max(0, (natural.w * s - box.w) / 2);
      const overflowY = Math.max(0, (natural.h * s - box.h) / 2);
      return { x: clamp(p.x, -overflowX, overflowX), y: clamp(p.y, -overflowY, overflowY) };
    },
    [natural.w, natural.h, box.w, box.h],
  );

  const resetToFit = useCallback(() => {
    setScale(fitScale(natural, box));
    setPan({ x: 0, y: 0 });
  }, [natural, box]);

  /** Zoom about a point, so the pixel under the cursor stays under the cursor. */
  const zoomAbout = useCallback(
    (nextScaleRaw: number, at?: { x: number; y: number }) => {
      const el = viewportRef.current;
      setScale((prev) => {
        const next = clamp(nextScaleRaw, Math.min(MIN_SCALE, fit), MAX_SCALE);
        if (next === prev) return prev;
        if (el && at) {
          const rect = el.getBoundingClientRect();
          // Cursor offset from the viewport centre, which is where the image
          // centre sits when pan is zero.
          const u = { x: at.x - rect.left - rect.width / 2, y: at.y - rect.top - rect.height / 2 };
          setPan((p) =>
            clampPan(
              { x: u.x - (next / prev) * (u.x - p.x), y: u.y - (next / prev) * (u.y - p.y) },
              next,
            ),
          );
        } else {
          setPan((p) => clampPan(p, next));
        }
        return next;
      });
    },
    [clampPan, fit],
  );

  // ── Measure the viewport ───────────────────────────────────────────────────
  useLayoutEffect(() => {
    if (!open) return;
    const el = viewportRef.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  // A new capture is a new image: drop the old zoom rather than inheriting a
  // pan that pointed at something in a different screenshot.
  useEffect(() => {
    setLoaded(false);
    setBroken(false);
    setNatural({ w: 0, h: 0 });
    setPan({ x: 0, y: 0 });
  }, [shot?.src]);

  // Fit once the natural size and the box are both known.
  useEffect(() => {
    if (!loaded || !box.w) return;
    setScale(fitScale(natural, box));
    setPan({ x: 0, y: 0 });
  }, [loaded, natural, box.w, box.h]);

  // ── Focus, scroll lock, restore (mirrors components/ui/Modal) ─────────────
  useEffect(() => {
    if (!open) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusFirst = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? panel.querySelector<HTMLElement>('button, a[href]'))?.focus();
    };
    focusFirst();
    // rAF does not fire in a hidden tab, so the synchronous call above is the
    // one that normally lands; this is the retry for content that mounts late.
    const timer = requestAnimationFrame(() => {
      if (!panelRef.current?.contains(document.activeElement)) focusFirst();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      cancelAnimationFrame(timer);
      restoreFocusTo.current?.focus?.();
    };
  }, [open]);

  // ── Keys ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
        return;
      }
      // Modifier combinations belong to the browser and to the app shell
      // (⌘K, ⌘\, ⌘/ all still work with the lightbox open).
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'ArrowLeft' && shots.length > 1) {
        e.preventDefault();
        onIndex((index - 1 + shots.length) % shots.length);
      } else if (e.key === 'ArrowRight' && shots.length > 1) {
        e.preventDefault();
        onIndex((index + 1) % shots.length);
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomAbout(scale * 1.25);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomAbout(scale / 1.25);
      } else if (e.key === '0') {
        e.preventDefault();
        resetToFit();
      } else if (e.key === '1') {
        e.preventDefault();
        zoomAbout(1);
      }
    };
    // Capture, for the same reason Modal does it: an editor or a table below
    // must not eat the Escape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose, onIndex, index, shots.length, scale, zoomAbout, resetToFit]);

  // ── Wheel zoom ────────────────────────────────────────────────────────────
  // Native and non-passive: React marks its own `wheel` handler passive on the
  // root, so preventDefault() from onWheel is ignored and the page scrolls.
  useEffect(() => {
    if (!open) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY / 300);
      zoomAbout(scale * factor, { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [open, scale, zoomAbout]);

  // ── Drag to pan ───────────────────────────────────────────────────────────
  const drag = useRef<{ id: number; x: number; y: number; from: { x: number; y: number } } | null>(
    null,
  );
  const [dragging, setDragging] = useState(false);

  if (!open || !shot) return null;

  const canPan = natural.w * scale > box.w + 1 || natural.h * scale > box.h + 1;
  const zoomPercent = Math.round(scale * 100);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      role="presentation"
      // Clicking the surround closes, exactly like Modal's backdrop. The panel
      // stops propagation, so a drag that ends outside does not close.
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Screenshot — step ${shot.stepIndex}: ${shot.title}`}
        className="flex min-h-0 flex-1 flex-col"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ── Header: what you are looking at, then the controls ───────────── */}
        <header className="border-line-strong bg-surface-1/95 flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-2.5">
          <StatusDot status={shot.status} />
          <span className="text-ink-faint font-mono text-micro tabular-nums">
            step {shot.stepIndex}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm" title={`${testName} — ${shot.title}`}>
            {shot.title}
            <span className="text-ink-faint ml-2 text-micro">{testName}</span>
          </span>

          {shots.length > 1 && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => onIndex((index - 1 + shots.length) % shots.length)}
                className="border-line hover:border-accent text-ink-dim hover:text-ink rounded-md border px-2 py-1 text-xs"
                title="Previous capture — ←"
                aria-label="Previous capture"
              >
                ←
              </button>
              <span className="text-ink-faint px-1 font-mono text-micro tabular-nums">
                {index + 1} / {shots.length}
              </span>
              <button
                type="button"
                onClick={() => onIndex((index + 1) % shots.length)}
                className="border-line hover:border-accent text-ink-dim hover:text-ink rounded-md border px-2 py-1 text-xs"
                title="Next capture — →"
                aria-label="Next capture"
              >
                →
              </button>
            </div>
          )}

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => zoomAbout(scale / 1.25)}
              className="border-line hover:border-accent text-ink-dim hover:text-ink rounded-md border px-2 py-1 text-xs"
              title="Zoom out — −"
              aria-label="Zoom out"
            >
              −
            </button>
            <span
              className="text-ink-faint w-12 text-center font-mono text-micro tabular-nums"
              aria-live="polite"
            >
              {zoomPercent}%
            </span>
            <button
              type="button"
              onClick={() => zoomAbout(scale * 1.25)}
              className="border-line hover:border-accent text-ink-dim hover:text-ink rounded-md border px-2 py-1 text-xs"
              title="Zoom in — +"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              onClick={resetToFit}
              className={cn(
                'border-line hover:border-accent rounded-md border px-2 py-1 text-xs',
                Math.abs(scale - fit) < 0.001 ? 'text-accent border-accent/50' : 'text-ink-dim',
              )}
              title="Fit to window — 0"
            >
              Fit
            </button>
            <button
              type="button"
              data-autofocus
              onClick={() => zoomAbout(1)}
              className={cn(
                'border-line hover:border-accent rounded-md border px-2 py-1 text-xs',
                Math.abs(scale - 1) < 0.001 ? 'text-accent border-accent/50' : 'text-ink-dim',
              )}
              title="Actual size — 1"
            >
              1:1
            </button>
          </div>

          {/* The captured size, because "is this a mobile viewport?" is a real
              triage question and the rail can never answer it. */}
          {loaded && (
            <span className="text-ink-faint shrink-0 font-mono text-micro tabular-nums">
              {natural.w}×{natural.h}
            </span>
          )}

          <a
            href={shot.src}
            target="_blank"
            rel="noreferrer"
            className="border-line hover:border-accent text-ink-dim hover:text-ink shrink-0 rounded-md border px-2 py-1 text-xs"
            title="Open the raw PNG in a new tab"
          >
            Open
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-ink-faint hover:text-ink shrink-0 px-1 text-sm leading-none"
            title="Close — Esc"
          >
            ✕
          </button>
        </header>

        {/* ── The image ────────────────────────────────────────────────────── */}
        <div
          ref={viewportRef}
          className={cn(
            'relative min-h-0 flex-1 overflow-hidden',
            dragging ? 'cursor-grabbing' : canPan ? 'cursor-grab' : 'cursor-zoom-in',
          )}
          onPointerDown={(e) => {
            if (!canPan) return;
            drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: pan };
            setDragging(true);
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d || d.id !== e.pointerId) return;
            setPan(
              clampPan({ x: d.from.x + (e.clientX - d.x), y: d.from.y + (e.clientY - d.y) }, scale),
            );
          }}
          onPointerUp={(e) => {
            if (drag.current?.id === e.pointerId) {
              drag.current = null;
              setDragging(false);
            }
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          // Double-click is the muscle memory for "get me closer" / "get me back".
          onDoubleClick={(e) =>
            Math.abs(scale - fit) < 0.001
              ? zoomAbout(1, { x: e.clientX, y: e.clientY })
              : resetToFit()
          }
        >
          {broken ? (
            // A missing artifact is an honest empty state, never a crash.
            <div className="text-ink-faint absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm">
              <p>This screenshot is no longer available.</p>
              <p className="font-mono text-micro">The artifact may have aged out of storage.</p>
            </div>
          ) : (
            <img
              src={shot.src}
              alt={shot.alt}
              draggable={false}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                setLoaded(true);
              }}
              onError={() => setBroken(true)}
              className="absolute top-1/2 left-1/2 max-w-none origin-center select-none"
              style={{
                transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px)) scale(${scale})`,
                // No transition: a transform transition fights every wheel
                // event and makes zooming feel like it is lagging behind you.
                imageRendering: scale > 1.5 ? 'pixelated' : 'auto',
                visibility: loaded ? 'visible' : 'hidden',
              }}
            />
          )}
        </div>

        <footer className="border-line-strong bg-surface-1/95 text-ink-faint flex shrink-0 items-center gap-4 border-t px-4 py-1.5 text-micro">
          <span>drag to pan</span>
          <span>scroll to zoom</span>
          <span>double-click 1:1</span>
          {shots.length > 1 && <span>← → steps</span>}
          <span className="ml-auto">Esc to close</span>
        </footer>
      </div>
    </div>
  );
}
