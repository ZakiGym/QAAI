'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Secret } from '../lib/api';
import { shortAgo } from './setup/time';
import { Button } from './ui/Button';
import { ConfirmDialog } from './ui/Modal';
import { SectionLabel, SkeletonRows } from './ui/layout';

/**
 * The secrets of one environment.
 *
 * Everything here is write-only by design: you set a value, and from then on the
 * UI only ever shows its name and a masked hint (••••••••+last4). The plaintext
 * lives in the AES-256-GCM vault and is decrypted solely inside a test run — it
 * is never sent back to the browser, so there is nothing here to leak.
 *
 * "Rotate" is not a second endpoint — setting a name that already exists IS the
 * rotation, and it is the only way to change a value the server will never read
 * back to you. So the link fills the add row rather than opening anything: the
 * act and the affordance are the same act.
 */
export function SecretsPanel({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const base = `/projects/${projectId}/environments/${environmentId}/secrets`;
  // `null` until the first fetch settles. Initialising to `[]` meant the empty
  // state — "No secrets yet" — was what rendered during every load, telling
  // someone with twelve secrets that they had none.
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [envText, setEnvText] = useState('');
  const [importNote, setImportNote] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Secret | null>(null);
  const [deleting, setDeleting] = useState(false);
  const valueRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const data = await api<{ secrets: Secret[] }>(base).catch(() => ({ secrets: [] }));
    setSecrets(data.secrets);
  }, [base]);

  useEffect(() => {
    setSecrets(null);
    void load();
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !value) return;
    setBusy(true);
    setError(null);
    try {
      await api(base, { method: 'PUT', body: JSON.stringify({ name: name.trim(), value }) });
      setName('');
      setValue('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the secret');
    } finally {
      setBusy(false);
    }
  }

  async function remove(secret: Secret) {
    setDeleting(true);
    try {
      await api(`${base}/${secret.id}`, { method: 'DELETE' }).catch(() => {});
      await load();
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  async function importEnv() {
    if (!envText.trim()) return;
    setBusy(true);
    setError(null);
    setImportNote(null);
    try {
      const { imported, skipped, rejected } = await api<{
        imported: string[];
        skipped: string[];
        rejected: number;
      }>(`${base}/import`, {
        method: 'POST',
        body: JSON.stringify({ content: envText, overwrite: true }),
      });
      // Only already-known names are ever named back; anything else is a count,
      // because a rejected "name" can be a fragment of the pasted secret itself.
      setImportNote(
        [
          `Imported ${imported.length}`,
          skipped.length ? `kept ${skipped.length} existing (${skipped.join(', ')})` : '',
          rejected ? `${rejected} line(s) ignored — names must be SCREAMING_SNAKE_CASE` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      );
      setEnvText('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  function rotate(secret: Secret) {
    setName(secret.name);
    setValue('');
    valueRef.current?.focus();
  }

  return (
    <section className="mt-7">
      <SectionLabel>Secrets · Vault</SectionLabel>

      {secrets === null ? (
        <SkeletonRows rows={3} />
      ) : secrets.length === 0 ? (
        <p className="border-line text-ink-faint text-row-sub border-b py-2.5">
          No secrets here yet. Tests read these as environment variables — an admin password, a
          test-mode API key, an SMTP URL.
        </p>
      ) : (
        <div>
          {secrets.map((secret) => (
            <div
              key={secret.id}
              className="border-line flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b py-2.5"
            >
              {/* `min-w` so the row wraps its metadata rather than eliding the
                  name — the name is the only part of a secret we can ever show,
                  and `ADMIN_P…` identifies nothing. */}
              <span className="min-w-[150px] flex-1 font-mono text-[12px] break-all">
                {secret.name}
              </span>
              <span className="text-ink-faint text-micro font-mono tabular-nums">
                {secret.value} · set {shortAgo(secret.updatedAt)} ago
              </span>
              <button
                type="button"
                onClick={() => rotate(secret)}
                className="text-ink-faint hover:text-ink text-[11.5px] transition-colors"
              >
                rotate
              </button>
              <button
                type="button"
                onClick={() => setPendingDelete(secret)}
                className="text-ink-faint hover:text-fail text-[11.5px] transition-colors"
              >
                delete
              </button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={add} className="mt-3 flex flex-wrap gap-2">
        {/* Neither input had a label of any kind — the placeholder was the only
            thing naming the field, and it disappears the moment you type. */}
        <input
          aria-label="Secret name"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="NAME"
          className="border-line placeholder:text-ink-faint focus:border-accent w-[110px] shrink-0 rounded-md border bg-transparent px-2.5 py-[7px] font-mono text-[11.5px] outline-none transition-colors"
        />
        <input
          ref={valueRef}
          aria-label="Secret value"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value — encrypted on write"
          autoComplete="off"
          className="border-line placeholder:text-ink-faint focus:border-accent min-w-[120px] flex-1 rounded-md border bg-transparent px-2.5 py-[7px] font-mono text-[11.5px] outline-none transition-colors"
        />
        <Button type="submit" size="sm" loading={busy}>
          Add
        </Button>
      </form>

      <p className="text-ink-faint text-micro mt-2.5 font-mono">
        AES-256-GCM · bound to (org, name) · values are never shown back — rotate to change
      </p>

      <div className="mt-3">
        <button
          type="button"
          onClick={() => setShowImport((s) => !s)}
          aria-expanded={showImport}
          className="text-accent text-[12px] hover:underline"
        >
          {showImport ? '– hide .env import' : '+ import a .env file'}
        </button>
        {showImport && (
          <div className="mt-2 space-y-2">
            <textarea
              aria-label=".env contents"
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={'API_TOKEN=sk-…\nADMIN_PASSWORD=…'}
              rows={5}
              className="border-line focus:border-accent text-micro w-full rounded-md border bg-transparent px-3 py-2 font-mono outline-none transition-colors"
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" onClick={() => void importEnv()} loading={busy}>
                Import into vault
              </Button>
              <span className="text-ink-faint text-micro font-mono">
                parsed on the server · values are sealed and never shown again
              </span>
            </div>
          </div>
        )}
      </div>

      {importNote && (
        <p className="text-ink-dim text-micro mt-2 font-mono tabular-nums" role="status">
          {importNote}
        </p>
      )}
      {error && (
        <p className="text-fail text-micro mt-2" role="alert">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete);
        }}
        title={pendingDelete ? `Delete ${pendingDelete.name}?` : 'Delete secret'}
        body="Any test using it will fail until it is set again."
        confirmLabel="Delete secret"
        busy={deleting}
      />
    </section>
  );
}
