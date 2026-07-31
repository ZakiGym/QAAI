'use client';

import { forwardRef, useEffect, useId, useState } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Modal } from './Modal';

/**
 * Text input, with a label that is actually associated with it.
 *
 * There were 18 `<input>` elements, each repeating the same six utility classes
 * with drifting padding, and most of them sat next to a `<p>` acting as a label
 * with no `htmlFor` — so clicking the label did nothing and a screen reader
 * announced an unlabelled field.
 */

export interface FieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  /** Shown under the field. Becomes the error message when `error` is set. */
  hint?: string;
  error?: string | null;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const generated = useId();
  const inputId = id ?? generated;
  const describedBy = hint || error ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="text-ink-dim text-body-sm mb-1.5 block">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={cn(
          'border-line bg-surface-1 text-body-sm placeholder:text-ink-faint w-full rounded-md border px-3 py-2 outline-none',
          'focus:border-accent transition-colors',
          error && 'border-fail/60',
          className,
        )}
        {...rest}
      />
      {(hint || error) && (
        <p
          id={describedBy}
          className={cn('text-micro mt-1.5', error ? 'text-fail' : 'text-ink-faint')}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
});

/**
 * Ask for one string.
 *
 * Replaces `window.prompt`, which carried four flows including the core act of
 * the product — creating a test — and file moves, where the payload was a
 * hand-typed full path. An OS dialog in the system font, outside the dark UI,
 * with no validation and no way to show what a valid answer looks like.
 */
export function PromptDialog({
  open,
  onClose,
  onSubmit,
  title,
  label,
  hint,
  initialValue = '',
  placeholder,
  confirmLabel = 'Save',
  validate,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (value: string) => void;
  title: string;
  label?: string;
  hint?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return a message to block submission, or null to allow it. */
  validate?: (value: string) => string | null;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);

  // Reopening with a different subject must not show the previous subject's
  // text — the old dialog is remounted, not reused.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
      setError(null);
    }
  }, [open, initialValue]);

  function submit() {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('This cannot be empty.');
      return;
    }
    const problem = validate?.(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    onSubmit(trimmed);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Field
        data-autofocus
        label={label}
        hint={hint}
        error={error}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        // Enter submits, which is what the native prompt did and what everyone
        // expects from a single-field dialog.
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
    </Modal>
  );
}
