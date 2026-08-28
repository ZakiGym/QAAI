'use client';

import { useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Badge, SectionLabel } from '../ui/layout';
import { CapabilityGrants } from './CapabilityGrants';
import { blockingReason, previewInstall } from './preview';
import type { PluginRegistry } from './types';

/**
 * Install a plugin.
 *
 * Two inputs, and the second one is not busywork. The first is the signed
 * document the publisher ships. The second is the SHA-256 of the file you
 * actually downloaded — which is the only way anybody finds out that the mirror
 * they fetched from is serving something the publisher never signed. Asking for
 * it here, next to the manifest, is what makes that a thing a person checks
 * rather than a thing an incident report mentions afterwards.
 *
 * ─── What this dialog does not do ────────────────────────────────────────────
 *
 * It does not verify the signature, and it says so where the reader is looking
 * rather than in a footnote. The org's trusted keys never leave the server. The
 * preview panel exists to catch the mistakes that are knowable in the browser —
 * a publisher you have not trusted, a protocol mismatch, the wrong file — so
 * they are fixed with the document still on screen; every one of them is
 * checked again on submit, by the endpoint, which is where the answer is real.
 *
 * A panel that showed a row of green ticks and stayed quiet about provenance
 * would be read as "we checked", and somebody would approve on that basis.
 */
export function InstallDialog({
  open,
  onClose,
  registry,
  onInstall,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  registry: PluginRegistry;
  onInstall: (payload: {
    manifest: unknown;
    signature: { algorithm: string; value: string };
    bundleSha256: string;
  }) => void;
  busy: boolean;
}) {
  const [text, setText] = useState('');
  const [digest, setDigest] = useState('');

  const preview = useMemo(
    () => previewInstall(text, digest, registry),
    [text, digest, registry],
  );
  const blocked = blockingReason(preview, digest);

  const submit = () => {
    if (preview.state !== 'ready' || blocked) return;
    onInstall({
      manifest: preview.document.manifest,
      signature: preview.document.signature,
      bundleSha256: digest.trim().toLowerCase(),
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Install a plugin"
      description="Paste the signed manifest the publisher gave you, and the checksum of the file you downloaded."
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            loading={busy}
            disabled={blocked !== null}
            title={blocked ?? undefined}
          >
            Install
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div>
          <SectionLabel>Signed manifest</SectionLabel>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={7}
            spellCheck={false}
            placeholder={`{ "manifest": { "schema": "${registry.manifestSchema}", … }, "signature": { … } }`}
            aria-label="Signed manifest"
            className="border-line text-micro placeholder:text-ink-faint w-full resize-y rounded-md border bg-transparent px-2.5 py-2 font-mono outline-none focus:border-accent transition-colors"
          />
        </div>

        <Field
          label="SHA-256 of the bundle"
          value={digest}
          onChange={(event) => setDigest(event.target.value)}
          spellCheck={false}
          placeholder="shasum -a 256 acme-lighthouse.tgz"
          className="font-mono"
          hint="Compared against the digest inside the signed manifest. A mismatch means the file you have is not the file the publisher vouched for."
        />

        {preview.state === 'unreadable' && (
          <p className="text-fail text-row-sub" role="alert">
            {preview.message}
          </p>
        )}

        {preview.state === 'ready' && (
          <div className="border-line space-y-5 rounded-lg border p-4">
            <div>
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-row text-ink font-medium">
                  {preview.document.manifest.displayName}
                </span>
                <span className="text-ink-faint text-micro font-mono">
                  {preview.document.manifest.name} {preview.document.manifest.version}
                </span>
              </div>
              <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">
                {preview.document.manifest.description}
              </p>
              <p className="text-ink-faint text-micro mt-2 font-mono">
                by {preview.document.manifest.publisher} · protocol{' '}
                {preview.document.manifest.protocol} · sha256:
                {preview.document.manifest.code.sha256.slice(0, 12)}…
              </p>
            </div>

            <div>
              <SectionLabel>What it will be able to reach</SectionLabel>
              <CapabilityGrants grants={preview.grants} unrecognised={preview.unrecognised} />
            </div>

            {preview.objections.length > 0 && (
              <ul className="space-y-2">
                {preview.objections.map((objection) => (
                  <li key={objection.kind} className="flex items-start gap-2">
                    <Badge tone="fail" tint className="mt-[2px]">
                      {objection.blocking ? 'BLOCKED' : 'CHECK'}
                    </Badge>
                    <span className="text-row-sub text-ink-dim leading-relaxed">
                      {objection.message}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {/*
              Said plainly, and never conditionally. `signatureChecked` is a
              `false` literal in the preview's type, so there is no state in
              which this line could be replaced by a reassuring one without the
              change being deliberate and visible in a diff.
            */}
            <p className="text-ink-faint text-micro border-line border-t pt-3 leading-relaxed">
              Nothing on this screen has checked the signature. That happens on the server, against
              the key you trusted for {preview.document.manifest.publisher}, when you press Install
              — and the install is refused if it does not match.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
