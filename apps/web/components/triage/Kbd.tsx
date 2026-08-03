import { cn } from '../../lib/cn';

/**
 * A keycap, printed on the control it belongs to.
 *
 * Triage is the one screen in this product that is meant to be driven from the
 * keyboard, and a binding nobody can see is a binding nobody uses — so the key
 * is drawn on the button rather than listed in a help sheet somewhere else.
 *
 * The border is a mix of `currentColor` so one component works both on the
 * accent-filled primary (where the text is `--color-accent-ink`) and on a plain
 * surface, without either caller knowing what colour it sits on.
 */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'rounded-[3px] border border-[color-mix(in_srgb,currentColor_35%,transparent)] px-1 font-mono text-[9.5px] leading-[1.6] font-medium',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
