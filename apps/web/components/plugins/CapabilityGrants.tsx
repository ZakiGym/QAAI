'use client';

import { cn } from '../../lib/cn';
import { Badge } from '../ui/layout';
import type { CapabilityGrant } from './preview';
import type { CapabilityInfo, CapabilityName } from './types';

/**
 * What this plugin will be able to reach — the only part of the install screen
 * that has to be read.
 *
 * Written as full sentences rather than as a row of chips, and that is the
 * whole argument for this component existing. `network · page · secrets` is a
 * list somebody scans in half a second and approves; "Read the decrypted
 * secrets of the project it runs against" is a sentence they have to finish. A
 * permission screen that can be skimmed is a permission screen that gets
 * clicked through, and this one is about running a stranger's code against a
 * customer's application.
 *
 * Each row carries its BOUND as well as its grant, because the honest version
 * of "reads your secrets" includes "on the projects you enable it for". Showing
 * the frightening half alone trains people to distrust the whole screen, which
 * costs attention on the row that genuinely matters.
 */
export function CapabilityGrants({
  grants,
  unrecognised = [],
  className,
}: {
  grants: CapabilityGrant[];
  /**
   * Capabilities the manifest asked for that this build has no copy for. Shown,
   * never dropped: a row silently omitted is a permission granted without being
   * displayed, which is the worst thing this screen could do.
   */
  unrecognised?: string[];
  className?: string;
}) {
  if (grants.length === 0 && unrecognised.length === 0) {
    return (
      <p className={cn('text-ink-faint text-row-sub', className)}>
        This plugin asks for nothing. That is unusual — check you have the right file.
      </p>
    );
  }

  return (
    <ul className={cn('divide-line divide-y', className)}>
      {grants.map(({ info, beyondPlan }) => (
        <li key={info.name} className="py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-row text-ink font-medium">{info.label}</span>
            {info.governed && (
              <Badge tone={beyondPlan ? 'fail' : 'flake'} tint={beyondPlan}>
                {beyondPlan ? 'NOT ON YOUR PLAN' : 'AUDITED'}
              </Badge>
            )}
          </div>
          <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">{info.grants}</p>
          <p className="text-ink-faint text-micro mt-1">{info.bounded}</p>
        </li>
      ))}

      {unrecognised.map((name) => (
        <li key={name} className="py-3">
          <div className="flex items-baseline gap-2">
            <span className="text-row text-ink font-mono">{name}</span>
            <Badge tone="fail" tint>
              UNKNOWN
            </Badge>
          </div>
          <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">
            This build of QAAI has no description for that capability, so nobody can tell you what
            it does. Do not install it.
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The compact form, for a plugin already installed.
 *
 * A chip row is acceptable HERE and not on the install screen, because the
 * decision has been made and this is a reminder rather than a request. The
 * governed ones still carry a different tone: on a list of eight plugins, the
 * question worth answering at a glance is which of them can reach secrets.
 */
export function CapabilityChips({
  capabilities,
  vocabulary,
}: {
  capabilities: CapabilityName[];
  vocabulary: CapabilityInfo[];
}) {
  const known = new Map(vocabulary.map((c) => [c.name, c]));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {capabilities.map((name) => {
        const info = known.get(name);
        return (
          // The tooltip sits on a wrapper rather than on Badge, which takes no
          // `title` — and it is only ever a shortcut. The full sentence for
          // every capability is on the install dialog, where the decision is
          // actually made; a chip a mouse has to hover is not where a
          // permission gets explained.
          <span key={name} title={info?.grants}>
            <Badge tone={info?.governed ? 'flake' : 'neutral'}>
              {(info?.label ?? name).toUpperCase()}
            </Badge>
          </span>
        );
      })}
    </div>
  );
}
