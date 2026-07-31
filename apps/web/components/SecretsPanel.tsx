'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Secret } from '../lib/api';
import { Button } from './ui/Button';
import { Field } from './ui/Field';
import { ConfirmDialog } from './ui/Modal';

/**
 * The secrets of one environment.
 *
 * Everything here is write-only by design: you set a value, and from then on the
 * UI only ever shows its name and a masked hint (••••••••+last4). The plaintext
 * lives in the AES-256-GCM vault and is decrypted solely inside a test run — it
 * is never sent back to the browser, so there is nothing here to leak.
 */
export function SecretsPanel({
  projectId,
  environmentId,
}: {
  projectId: string;
  environmentId: string;
}) {
  const base = `/projects/${projectId}/environments/${environmentId}/secrets`;
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [envText, setEnvText] = useState('');
  const [importNote, setImportNote] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Secret | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    const data = await api<{ secrets: Secret[] }>(base).catch(() => ({ secrets: [] }));
    setSecrets(data.secrets);
  }, [base]);

  useEffect(() => {
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

  return (
    <div className="space-y-4">
      <div className="border-line divide-line divide-y overflow-hidden rounded-lg border">
        {secrets.map((secret) => (
          <div key={secret.id} className="flex items-center gap-4 px-4 py-2.5">
            <span className="font-mono text-xs font-medium">{secret.name}</span>
            <span className="text-ink-faint font-mono text-xs">{secret.value}</span>
            <Button
              variant="danger"
              size="sm"
              className="ml-auto"
              onClick={() => setPendingDelete(secret)}
            >
              Delete
            </Button>
          </div>
        ))}
        {secrets.length === 0 && (
          <p className="text-ink-faint px-4 py-4 text-center text-xs">
            No secrets yet. Tests read these as environment variables.
          </p>
        )}
      </div>

      <form onSubmit={add} className="flex items-center gap-2">
        {/* Neither input had a label of any kind — the placeholder was the only
            thing naming the field, and it disappears the moment you type. */}
        <div className="w-48 shrink-0">
          <Field
            aria-label="Secret name"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="SECRET_NAME"
            className="font-mono text-xs"
          />
        </div>
        <div className="min-w-0 flex-1">
          <Field
            aria-label="Secret value"
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
            autoComplete="off"
            className="text-xs"
          />
        </div>
        <Button type="submit" variant="primary" size="sm" loading={busy}>
          Set
        </Button>
      </form>

      <div>
        <Button variant="ghost" size="sm" className="-ml-2.5" onClick={() => setShowImport((s) => !s)}>
          {showImport ? '– Hide .env import' : '+ Import a .env file'}
        </Button>
        {showImport && (
          <div className="mt-2 space-y-2">
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder={'API_TOKEN=sk-…\nADMIN_PASSWORD=…'}
              rows={5}
              className="border-line bg-surface-1 focus:border-accent w-full rounded-md border px-3 py-2 font-mono text-xs outline-none"
            />
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => void importEnv()} loading={busy}>
                Import into vault
              </Button>
              <span className="text-ink-faint text-micro">
                Parsed on the server; values are sealed and never shown again.
              </span>
            </div>
          </div>
        )}
      </div>

      {importNote && <p className="text-ink-dim text-xs tabular-nums">{importNote}</p>}
      {error && <p className="text-fail text-xs">{error}</p>}

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
    </div>
  );
}
