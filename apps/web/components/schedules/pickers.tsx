'use client';

import { useId } from 'react';
import type { EnvironmentRef, SuiteRef } from './types';

/**
 * The three selects both dialogs need.
 *
 * `<Field>` covers text inputs and nothing else, so every screen that needed a
 * labelled select re-declared the same six utility classes inline (see the kind
 * picker on the environments screen). This is that markup, once, kept local to
 * this feature rather than pushed into components/ui — the shared layer belongs
 * to the design system's owner, and one more caller is not yet a case for
 * changing it.
 */
export function Picker({
  label,
  value,
  onChange,
  hint,
  disabled,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="w-full">
      <label
        htmlFor={id}
        className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors disabled:opacity-50"
      >
        {children}
      </select>
      {hint && <p className="text-ink-faint text-micro mt-1.5 font-mono">{hint}</p>}
    </div>
  );
}

/**
 * What runs, and where.
 *
 * A schedule and a monitor answer this pair identically — both hold a suiteId
 * and an environmentId and both are meaningless without them — so they ask it
 * with the same two controls in the same order. The environment's kind is shown
 * next to its name because "production" as a NAME and PRODUCTION as a kind are
 * independent in this data model, and the one that decides how frightened to be
 * is the kind.
 */
export function TargetFields({
  suites,
  environments,
  suiteId,
  environmentId,
  onSuite,
  onEnvironment,
}: {
  suites: SuiteRef[];
  environments: EnvironmentRef[];
  suiteId: string;
  environmentId: string;
  onSuite: (id: string) => void;
  onEnvironment: (id: string) => void;
}) {
  return (
    <>
      <Picker label="Suite" value={suiteId} onChange={onSuite} hint="the tests it runs">
        {suites.map((suite) => (
          <option key={suite.id} value={suite.id}>
            {suite.name}
          </option>
        ))}
      </Picker>
      <Picker
        label="Environment"
        value={environmentId}
        onChange={onEnvironment}
        hint="where it points"
      >
        {environments.map((environment) => (
          <option key={environment.id} value={environment.id}>
            {environment.name} · {environment.kind.toLowerCase()}
          </option>
        ))}
      </Picker>
    </>
  );
}

/**
 * Every zone the browser's ICU knows, which is the same list the API validates
 * against and the same one the worker parses with.
 *
 * A select rather than a text field on purpose: the timezone is the field with
 * the worst failure mode on this screen — get it wrong and the API refuses, or
 * worse, accepts something plausible and the nightly fires an hour off — and a
 * list of real zones makes the whole class of typo impossible. The fallback
 * list is tiny and only exists for an engine without `supportedValuesOf`;
 * anything it lacks can still be reached, because an existing schedule's own
 * zone is always added below.
 */
const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Singapore',
  'Australia/Sydney',
];

export function timeZoneOptions(current: string): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function'
      ? (Intl.supportedValuesOf('timeZone'))
      : FALLBACK_ZONES;
  // `current` first and de-duplicated: a schedule created before this screen
  // existed may hold a zone ICU lists under another name, and losing it on the
  // next save would move the run without anyone asking for it.
  return [...new Set([current, 'UTC', ...supported].filter(Boolean))];
}

/** The browser's own zone — the only sensible default for a NEW schedule. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
