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
    <div className="border-line/60 flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
      {icon && <div className="text-ink-faint mb-3.5" aria-hidden="true">{icon}</div>}
      <h3 className="text-ink text-sm font-medium">{title}</h3>
      <p className="text-ink-dim text-body-sm mt-1.5 max-w-sm leading-relaxed">{body}</p>
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
  const className = primary
    ? 'bg-accent text-body-sm rounded-md px-3.5 py-2 font-medium text-white hover:opacity-90'
    : 'border-line text-ink-dim hover:text-ink hover:border-line-strong text-body-sm rounded-md border px-3.5 py-2';

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
