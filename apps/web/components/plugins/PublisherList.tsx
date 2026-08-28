'use client';

import { useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/layout';
import type { Publisher } from './types';

/**
 * Who this organisation trusts, and the fingerprint of what it trusts them
 * with.
 *
 * The fingerprint is the row. Everything else — the name, the date, the count —
 * is context for it. Trusting a publisher is a claim about the world that
 * cannot be checked by looking at any plugin, only by comparing these thirty-two
 * characters against what the publisher themselves publish, so the screen sets
 * them in mono at full length and does not truncate them. A fingerprint you
 * have to hover to read is a fingerprint nobody compares.
 *
 * Revoked rows STAY. A key that was trusted in July and is not trusted now is a
 * fact somebody will need in an incident review, and the plugins installed
 * under it are still sitting in the list above.
 */
export function PublisherList({
  publishers,
  onRevoke,
  canEdit,
}: {
  publishers: Publisher[];
  onRevoke: (publisher: Publisher) => void;
  canEdit: boolean;
}) {
  return (
    <ul className="divide-line divide-y">
      {publishers.map((publisher) => (
        <li key={publisher.id} className="flex items-start gap-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-row text-ink font-medium">{publisher.displayName}</span>
              <span className="text-ink-faint text-micro font-mono">{publisher.publisherId}</span>
              {publisher.revokedAt && (
                <Badge tone="fail" tint>
                  REVOKED
                </Badge>
              )}
            </div>
            {/* Full length, wrapping if it must. This is the value people check. */}
            <p className="text-ink-dim text-micro mt-1 font-mono break-all">
              {publisher.fingerprint}
            </p>
            <p className="text-ink-faint text-micro mt-1">
              {publisher.pluginCount === 0
                ? 'Nothing installed under this key.'
                : `${publisher.pluginCount} plugin${publisher.pluginCount === 1 ? '' : 's'} installed under this key.`}
            </p>
          </div>

          {canEdit && !publisher.revokedAt && (
            <Button size="sm" variant="danger" onClick={() => onRevoke(publisher)}>
              Revoke
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Add a signing key.
 *
 * The hint under the key field is the important copy on this dialog: it says
 * where the value should have come from. A key pasted from the same page that
 * offered the download proves nothing at all — it is the attacker's key if the
 * page is the attacker's — and this is the one moment where saying so costs a
 * sentence and buys the entire trust model.
 */
export function TrustDialog({
  open,
  onClose,
  onTrust,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onTrust: (input: { publisherId: string; displayName: string; publicKey: string }) => void;
  busy: boolean;
}) {
  const [publisherId, setPublisherId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [publicKey, setPublicKey] = useState('');

  const ready = publisherId.trim() && displayName.trim() && publicKey.trim();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trust a publisher"
      description="Plugins can only be installed if they are signed by a key you have added here."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!ready}
            onClick={() =>
              onTrust({
                publisherId: publisherId.trim().toLowerCase(),
                displayName: displayName.trim(),
                publicKey: publicKey.trim(),
              })
            }
          >
            Trust this key
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label="Publisher id"
          value={publisherId}
          onChange={(event) => setPublisherId(event.target.value)}
          placeholder="acme"
          spellCheck={false}
          className="font-mono"
          hint="Exactly the name their manifests are signed under — lowercase, hyphens."
        />
        <Field
          label="Name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Acme Inc"
        />
        <Field
          label="Ed25519 public key"
          value={publicKey}
          onChange={(event) => setPublicKey(event.target.value)}
          placeholder="base64 — raw 32 bytes, or the SPKI DER"
          spellCheck={false}
          className="font-mono"
          hint="Get this from the publisher directly, not from the page that offered you the download. We show you its fingerprint once it is added, so you can confirm it against their own site."
        />
      </div>
    </Modal>
  );
}
