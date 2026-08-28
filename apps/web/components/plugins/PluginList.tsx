'use client';

import { Button } from '../ui/Button';
import { Badge } from '../ui/layout';
import { cn } from '../../lib/cn';
import { CapabilityChips } from './CapabilityGrants';
import type { CapabilityInfo, InstalledPlugin } from './types';

/**
 * What is installed, and — the part that actually matters — where it is
 * allowed to run.
 *
 * The per-project row is not a settings detail tucked behind a link. It is on
 * the plugin's own row because "installed" and "running against production" are
 * two different states of the world and the screen has to show which one you
 * are in without a click. A registry that lists eight plugins and says nothing
 * about where they execute is a registry that answers the easy question.
 *
 * The toggles are drawn as a strip of project names rather than as switches in
 * a table, because the count is small (a plan tops out at ten projects) and the
 * useful reading is the shape of the strip: which names are lit.
 */
export function PluginList({
  plugins,
  projects,
  vocabulary,
  onToggle,
  onUninstall,
  canEdit,
  pending,
}: {
  plugins: InstalledPlugin[];
  projects: Array<{ id: string; name: string }>;
  vocabulary: CapabilityInfo[];
  onToggle: (plugin: InstalledPlugin, projectId: string, enabled: boolean) => void;
  onUninstall: (plugin: InstalledPlugin) => void;
  canEdit: boolean;
  /** `${pluginId}:${projectId}` currently in flight, so one row can be busy. */
  pending: string | null;
}) {
  return (
    <ul className="divide-line divide-y">
      {plugins.map((plugin) => (
        <li key={plugin.id} className="py-4">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-row text-ink font-medium">{plugin.displayName}</span>
                <span className="text-ink-faint text-micro font-mono">
                  {plugin.name} {plugin.version}
                </span>
                {plugin.publisherRevoked && (
                  <Badge tone="fail" tint>
                    KEY REVOKED
                  </Badge>
                )}
              </div>

              <p className="text-ink-dim text-row-sub mt-1 leading-relaxed">{plugin.description}</p>

              {/*
                The single most important line this list can carry. A plugin
                whose publisher's key was revoked AFTER it was installed is
                still here and still running; nothing about its own row would
                otherwise say so, and the reader would have to notice that two
                separate lists disagree.
              */}
              {plugin.publisherRevoked && (
                <p className="text-fail text-row-sub mt-2 leading-relaxed">
                  You revoked {plugin.publisher}’s signing key. This plugin is still installed and
                  its signature can no longer be checked against anything.
                </p>
              )}

              <p className="text-ink-faint text-micro mt-2 font-mono">
                by {plugin.publisher} · sha256:{plugin.codeSha256.slice(0, 12)}… · {plugin.codeEntry}
              </p>

              <div className="mt-2.5">
                <CapabilityChips capabilities={plugin.capabilities} vocabulary={vocabulary} />
              </div>
            </div>

            {canEdit && (
              <Button size="sm" variant="danger" onClick={() => onUninstall(plugin)}>
                Uninstall
              </Button>
            )}
          </div>

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <span className="text-micro text-ink-faint font-mono tracking-[0.1em] uppercase">
              Runs on
            </span>
            {projects.length === 0 && (
              <span className="text-ink-faint text-row-sub">No projects yet.</span>
            )}
            {projects.map((project) => {
              // Absent means never decided, and never decided means off. The
              // registry stores it the same way, for the same reason: a plugin
              // must not go live on a project created after it was installed.
              const on = plugin.projects[project.id] === true;
              const key = `${plugin.id}:${project.id}`;
              return (
                <button
                  key={project.id}
                  type="button"
                  disabled={!canEdit || pending === key}
                  aria-pressed={on}
                  onClick={() => onToggle(plugin, project.id, !on)}
                  className={cn(
                    'text-micro rounded-sm border px-2 py-[3px] font-mono tracking-[0.04em] transition-colors',
                    on
                      ? 'border-accent/50 text-accent bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]'
                      : 'border-line text-ink-faint hover:text-ink-dim hover:border-line-strong',
                    (!canEdit || pending === key) && 'cursor-not-allowed opacity-50',
                  )}
                >
                  {project.name}
                </button>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}
