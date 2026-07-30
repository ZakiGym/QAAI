'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, type Secret } from '../lib/api';

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
    if (!confirm(`Delete ${secret.name}? Any test using it will fail until it is set again.`)) return;
    await api(`${base}/${secret.id}`, { method: 'DELETE' }).catch(() => {});
    await load();
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
            <button
              type="button"
              onClick={() => void remove(secret)}
              className="text-fail ml-auto text-xs hover:underline"
            >
              Delete
            </button>
          </div>
        ))}
        {secrets.length === 0 && (
          <p className="text-ink-faint px-4 py-4 text-center text-xs">
            No secrets yet. Tests read these as environment variables.
          </p>
        )}
      </div>

      <form onSubmit={add} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="SECRET_NAME"
          className="border-line bg-surface-1 focus:border-accent w-48 rounded-md border px-3 py-1.5 font-mono text-xs outline-none"
        />
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          autoComplete="off"
          className="border-line bg-surface-1 focus:border-accent flex-1 rounded-md border px-3 py-1.5 text-xs outline-none"
        />
        <button
          type="submit"
          disabled={busy}
          className="bg-accent rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          Set
        </button>
      </form>

      <div>
        <button
          type="button"
          onClick={() => setShowImport((s) => !s)}
          className="text-ink-faint hover:text-ink text-xs"
        >
          {showImport ? '– Hide .env import' : '+ Import a .env file'}
        </button>
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
              <button
                type="button"
                onClick={() => void importEnv()}
                disabled={busy}
                className="border-line hover:border-accent rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
              >
                Import into vault
              </button>
              <span className="text-ink-faint text-micro">
                Parsed on the server; values are sealed and never shown again.
              </span>
            </div>
          </div>
        )}
      </div>

      {importNote && <p className="text-ink-dim text-xs">{importNote}</p>}
      {error && <p className="text-fail text-xs">{error}</p>}
    </div>
  );
}
