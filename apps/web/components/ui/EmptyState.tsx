'use client';

/**
 * The empty state.
 *
 * Roughly fifteen lists in QAAI render "No runs yet." in grey when they have
 * nothing to show, which is the least useful thing an empty screen can say: it
 * confirms what the user can already see and gives them nothing to do. A new
 * account is *entirely* empty states, so this is most people's first impression
 * of the product.
 *
 * The shape here is deliberate — say what would be here, explain why it isn't
 * yet, and offer the one action that fills it. The action is the point; the
 * text is scaffolding around it.
 */

export function EmptyState({
  title,
  body,
  action,
  secondary,
  icon,
}: {
  /** What would live here — not "Nothing found". */
  title: string;
  /** Why it is empty, and what filling it gets them. One or two sentences. */
  body: string;
  /** The single thing to do next. Omit only when the user genuinely cannot act. */
  action?: { label: string; onClick?: () => void; href?: string };
  secondary?: { label: string; onClick?: () => void; href?: string };
  icon?: React.ReactNode;
}) {
  return (
    // Dashed hairline at the dropzone radius — this is the same gesture as the
    // import dropzone: an outline around space that is waiting to be filled.
    <div className="border-line flex flex-col items-center rounded-xl border border-dashed px-6 py-14 text-center">
      {icon && (
        <div className="text-ink-faint mb-3.5" aria-hidden="true">
          {icon}
        </div>
      )}
      <h3 className="text-ink font-display text-base font-semibold">{title}</h3>
      <p className="text-ink-dim text-body-sm mt-2 max-w-sm leading-relaxed">{body}</p>
      {(action || secondary) && (
        <div className="mt-5 flex items-center gap-2">
          {action && <Action {...action} primary />}
          {secondary && <Action {...secondary} />}
        </div>
      )}
    </div>
  );
}

function Action({
  label,
  onClick,
  href,
  primary,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
}) {
  // Same geometry as Button, because it is a button — the only reason this is
  // not one is that half of these are links, and `<Button>` is a `<button>`.
  const className = primary
    ? 'bg-accent text-accent-ink text-row-sub rounded-md px-3.5 py-[7px] font-semibold hover:opacity-90'
    : 'border-line text-ink-dim hover:text-ink hover:border-line-strong text-row-sub rounded-md border px-3.5 py-[7px]';

  if (href) {
    return (
      <a href={href} className={className}>
        {label}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className={className}>
      {label}
    </button>
  );
}
