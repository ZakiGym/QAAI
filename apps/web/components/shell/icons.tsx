/**
 * The sidebar icon set — inline stroke SVGs, no icon dependency.
 *
 * Each is 24×24 on a currentColor stroke so it inherits the row's text colour
 * (dim when idle, bright when active) with no per-icon theming. Sized by the
 * caller via className; default 18px reads well at both the 240px and collapsed
 * rail widths.
 */

interface IconProps {
  className?: string;
}

function Svg({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      className={className ?? 'h-[18px] w-[18px]'}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** Runs — a list of executions. */
export function IconList(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <circle cx="3.5" cy="6" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="12" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="3.5" cy="18" r="0.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Dashboard — a 2×2 overview grid. */
export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

/** Editor — angle brackets. */
export function IconCode(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </Svg>
  );
}

/** Import — an arrow into a tray. */
export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </Svg>
  );
}

/** Add app — a plus in a rounded square. */
export function IconPlusSquare(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2.5" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </Svg>
  );
}

/** Flow map — connected nodes. */
export function IconMap(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.5 6h7" />
      <path d="M7 8.2 10.8 16" />
      <path d="M17 8.2 13.2 16" />
    </Svg>
  );
}

/** Triage — a magnifier over a decision. */
export function IconTriage(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20l-4.6-4.6" />
      <path d="M8 10.5l2 2 3.5-3.5" />
    </Svg>
  );
}

/** Quality — a shield with a check. */
export function IconShield(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3l7.5 3v6c0 4.5-3.2 7.9-7.5 9-4.3-1.1-7.5-4.5-7.5-9V6Z" />
      <path d="M9 12l2 2 4-4" />
    </Svg>
  );
}

/** Self-healing — a bandage / mend. */
export function IconHeal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 21s-7-4.35-9-8.5A5.5 5.5 0 0 1 12 6.5a5.5 5.5 0 0 1 9 6c-2 4.15-9 8.5-9 8.5Z" />
      <path d="M9.5 12h5" />
      <path d="M12 9.5v5" />
    </Svg>
  );
}

/** Source control — a git branch. */
export function IconBranch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <path d="M6 7.5v9" />
      <path d="M18 10.5c0 4-4 3.5-6 5.5" />
    </Svg>
  );
}

/** Environments / secrets — a key. */
export function IconKey(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.5 12.5 20 3" />
      <path d="M16 7l3 3" />
      <path d="M13.5 9.5l2.5 2.5" />
    </Svg>
  );
}

/** Settings — sliders. */
export function IconSliders(props: IconProps) {
  return (
    <Svg {...props}>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1.5" y1="14" x2="6.5" y2="14" />
      <line x1="9.5" y1="8" x2="14.5" y2="8" />
      <line x1="17.5" y1="16" x2="22.5" y2="16" />
    </Svg>
  );
}

/** The ⌘K search affordance. */
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </Svg>
  );
}

export function IconChevronsLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </Svg>
  );
}

export function IconChevronsRight(props: IconProps) {
  return (
    <Svg {...props}>
      <polyline points="13 17 18 12 13 7" />
      <polyline points="6 17 11 12 6 7" />
    </Svg>
  );
}
