'use client';

import { useEffect, useId, useState } from 'react';
import {
  CREATABLE_TEST_TYPES,
  NEW_TEST_TEMPLATES,
  TEST_TYPE_LABELS,
  testFileSlug,
  type TestType,
} from '@qaai/shared';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { Modal } from './ui/Modal';

/**
 * The "+ new test" dialog (§8).
 *
 * This replaces a name-only PromptDialog that hardcoded `type: 'E2E'` — the
 * API accepted every test type and the UI could mint exactly one. The picker
 * offers precisely the types with a runner plugin behind them, no more: each
 * choice creates a file the plugin has already validated as runnable
 * (packages/runner/src/plugins/new-test-templates.test.ts holds the templates
 * to that), so nothing this dialog can produce fails its first run with
 * "invalid spec".
 *
 * The hint under the picker is the honest part — what the type does and the
 * dependency it needs, said before the file exists rather than by the first
 * red run. The path line updates live because the extension follows the type,
 * and a person choosing API should see `.api.json` before pressing Create.
 */
export function NewTestDialog({
  open,
  dir,
  onClose,
  onCreate,
}: {
  open: boolean;
  /** Folder the file lands in, for the live path preview. */
  dir: string;
  onClose: () => void;
  onCreate: (name: string, type: TestType) => void;
}) {
  const [name, setName] = useState('New test');
  const [type, setType] = useState<TestType>('E2E');
  const [error, setError] = useState<string | null>(null);
  const typeId = useId();

  // Reopening must not show the previous visit's choices — the same
  // remount-not-reuse contract PromptDialog keeps.
  useEffect(() => {
    if (open) {
      setName('New test');
      setType('E2E');
      setError(null);
    }
  }, [open]);

  const template = NEW_TEST_TEMPLATES[type];

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('This cannot be empty.');
      return;
    }
    onCreate(trimmed, type);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New test"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          data-autofocus
          label="Test name"
          error={error}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          // Enter submits, as it does in every single-decision dialog here.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />

        <div>
          <label
            htmlFor={typeId}
            className="text-meta text-ink-faint mb-2 block font-mono tracking-[0.08em] uppercase"
          >
            Type
          </label>
          <select
            id={typeId}
            value={type}
            onChange={(e) => setType(e.target.value as TestType)}
            className="border-line text-row-sub focus:border-accent w-full rounded-md border bg-transparent px-2.5 py-2 outline-none transition-colors"
          >
            {CREATABLE_TEST_TYPES.map((t) => (
              <option key={t} value={t}>
                {TEST_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          {template && (
            <p className="text-micro text-ink-faint mt-1.5 font-mono">{template.hint}</p>
          )}
        </div>

        <p className="text-micro text-ink-faint font-mono">
          It lands in {dir}/{testFileSlug(name.trim())}
          {template?.fileSuffix ?? '.spec.ts'}
        </p>
      </div>
    </Modal>
  );
}
