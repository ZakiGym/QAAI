'use client';

import {
  LANGUAGES,
  LANGUAGE_LABELS,
  UI_FRAMEWORK_LABELS,
  type Language,
  type UiFramework,
} from '@qaai/shared';
import { Field } from '../ui/Field';
import { frameworksFor, type StackSuggestion } from './funnel';

const ENV_KINDS = [
  { value: 'LOCAL', label: 'Local' },
  { value: 'PREVIEW', label: 'Preview' },
  { value: 'STAGING', label: 'Staging' },
  { value: 'PRODUCTION', label: 'Production' },
] as const;

/**
 * Step 2 — what language the tests are written in, and with what.
 *
 * The framework list is derived from the language through
 * `FRAMEWORKS_BY_LANGUAGE`, which is the same table `createProjectSchema`
 * validates against. That is the entire fix for the bug this screen shipped
 * with: it had a local three-entry const, one of whose entries (Selenium) the
 * API refuses for the language the request defaulted to, so a third of the
 * first screen's options could not be submitted and the failure arrived as a
 * red box after three round-trips.
 *
 * When detection supplied the pre-selection, the reason for it sits under the
 * dropdown in detection's own words. A pre-filled field with no explanation is
 * indistinguishable from a default nobody chose, and this one is a claim about
 * the user's repo that they are entitled to overrule.
 */
export function StackStep({
  name,
  onName,
  language,
  framework,
  onLanguage,
  onFramework,
  suggestion,
  baseUrl,
  onBaseUrl,
  urlRequired,
  envKind,
  onEnvKind,
  disabled,
}: {
  name: string;
  onName: (value: string) => void;
  language: Language;
  framework: UiFramework;
  onLanguage: (value: Language) => void;
  onFramework: (value: UiFramework) => void;
  /** Present only when a codebase was read. Null means these are plain defaults. */
  suggestion: StackSuggestion | null;
  baseUrl: string;
  onBaseUrl: (value: string) => void;
  /** True on the crawl path, where there is nothing to explore without one. */
  urlRequired: boolean;
  envKind: string;
  onEnvKind: (value: string) => void;
  disabled?: boolean;
}) {
  const options = frameworksFor(language);
  // The suggestion is only an explanation while it is still what is selected.
  // Leaving it up after the user overrules it attributes their choice to us.
  const stillSuggested =
    suggestion && suggestion.language === language && suggestion.framework === framework;

  return (
    <div className="mt-5 space-y-4">
      <Field
        id="app-name"
        label="Name"
        required
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder="Acme Storefront"
        disabled={disabled}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="language" className={LABEL}>
            Language
          </label>
          <select
            id="language"
            value={language}
            onChange={(e) => onLanguage(e.target.value as Language)}
            disabled={disabled}
            className={SELECT}
          >
            {LANGUAGES.map((value) => (
              <option key={value} value={value}>
                {LANGUAGE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="framework" className={LABEL}>
            Framework
          </label>
          <select
            id="framework"
            value={framework}
            onChange={(e) => onFramework(e.target.value as UiFramework)}
            disabled={disabled}
            className={SELECT}
          >
            {options.map((value) => (
              <option key={value} value={value}>
                {UI_FRAMEWORK_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {stillSuggested ? (
        <p className="text-ink-dim text-micro leading-relaxed">
          <span className="text-pass font-mono">pre-selected</span> — {suggestion.why}. Change
          either dropdown if that is not the suite you want.
        </p>
      ) : suggestion ? (
        <p className="text-ink-faint text-micro leading-relaxed">
          QAAI read your repo as {LANGUAGE_LABELS[suggestion.language]} /{' '}
          {UI_FRAMEWORK_LABELS[suggestion.framework]} — {suggestion.why}. Your choice wins.
        </p>
      ) : (
        <p className="text-ink-faint text-micro leading-relaxed">
          Only pairs the generator can actually emit are offered — the framework list changes with
          the language, because a suite it cannot write is a suite that cannot run.
        </p>
      )}

      <div>
        <Field
          id="base-url"
          label={urlRequired ? 'URL to test' : 'URL to test (optional)'}
          type="url"
          required={urlRequired}
          value={baseUrl}
          onChange={(e) => onBaseUrl(e.target.value)}
          placeholder="https://staging.acme.com"
          aria-describedby="base-url-hint"
          className="font-mono"
          disabled={disabled}
        />
        {/* Not the Field's own `hint` — this one carries a control. */}
        <p id="base-url-hint" className="text-ink-faint text-micro mt-1.5 leading-relaxed">
          {urlRequired
            ? 'A staging or preview URL is best. '
            : 'Leave it blank to skip the crawl — you can add an environment later and explore then. '}
          To test the bundled demo, use{' '}
          <button
            type="button"
            onClick={() => onBaseUrl('http://localhost:5050')}
            className="text-accent font-mono underline"
            disabled={disabled}
          >
            http://localhost:5050
          </button>
          .
        </p>
      </div>

      {baseUrl.trim().length > 0 && (
        <div className="max-w-[220px]">
          <label htmlFor="env-kind" className={LABEL}>
            Environment
          </label>
          <select
            id="env-kind"
            value={envKind}
            onChange={(e) => onEnvKind(e.target.value)}
            disabled={disabled}
            className={SELECT}
          >
            {ENV_KINDS.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

const LABEL = 'text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase';
const SELECT =
  'border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors disabled:opacity-50';
