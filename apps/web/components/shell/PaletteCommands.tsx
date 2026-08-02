'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PaletteItem } from '../CommandPalette';

/**
 * Commands contributed by whatever screen is open.
 *
 * The palette listed fifteen navigation entries and three view toggles, which
 * makes it a menu of places and never a way to do anything. The actions people
 * actually repeat — re-run this, compare it with the last one, open the trace —
 * are all specific to a screen and all conditional on that screen's data: there
 * is no honest "open the trace" command until something knows a trace exists.
 *
 * So a screen registers its own, for as long as it is mounted. Two properties
 * this design is chosen for:
 *
 *   · A command can never outlive the screen that can service it. The effect's
 *     cleanup removes it, so navigating away cannot leave a "Cancel this run"
 *     in the palette pointing at a run you are no longer looking at.
 *   · A screen only offers what it has checked. The cockpit registers "Open the
 *     trace" only once it has a result that kept one, which is the difference
 *     between a shortcut and a link to an empty state.
 */

interface Registry {
  register: (key: string, items: PaletteItem[]) => void;
  unregister: (key: string) => void;
  items: PaletteItem[];
}

const Ctx = createContext<Registry | null>(null);

export function PaletteCommandsProvider({ children }: { children: React.ReactNode }) {
  const [groups, setGroups] = useState<Record<string, PaletteItem[]>>({});

  /*
   * `register` and `unregister` are stable for the life of the provider.
   *
   * That is load-bearing, not tidiness: registering changes `items`, which
   * re-renders every consumer. If the callbacks changed identity with it, a
   * screen's registration effect would re-fire on its own registration and
   * never settle.
   */
  const api = useMemo(
    () => ({
      register: (key: string, items: PaletteItem[]) =>
        setGroups((prev) => ({ ...prev, [key]: items })),
      unregister: (key: string) =>
        setGroups((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        }),
    }),
    [],
  );

  const value = useMemo<Registry>(
    () => ({ ...api, items: Object.values(groups).flat() }),
    [api, groups],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read by the shell. Empty outside a provider, which is the correct answer. */
export function usePaletteRegistry(): PaletteItem[] {
  return useContext(Ctx)?.items ?? [];
}

/**
 * Contribute commands for as long as this component is mounted.
 *
 * `deps` behaves exactly like `useMemo`'s: the factory re-runs, and the
 * registration is replaced, only when they change. Taking deps rather than a
 * ready-made array is deliberate — an array rebuilt every render would
 * re-register on every render, and since registering re-renders the consumer
 * that is an infinite loop rather than a performance note.
 *
 * The `run` closures are always the latest ones even between re-registrations,
 * because the factory is re-run through a ref on every render; a stale closure
 * here would mean "Cancel this run" cancelling with last render's state.
 */
export function usePaletteCommands(
  key: string,
  factory: () => PaletteItem[],
  deps: React.DependencyList,
): void {
  const registry = useContext(Ctx);
  const latest = useRef(factory);
  latest.current = factory;

  useEffect(() => {
    if (!registry) return;
    // Indirected through the ref so the registered `run` always sees current
    // props and state, without the identity of the closures forcing a
    // re-registration on every render.
    registry.register(
      key,
      latest.current().map((item) => ({
        ...item,
        run: () => {
          const current = latest.current().find((candidate) => candidate.id === item.id);
          (current ?? item).run();
        },
      })),
    );
    return () => registry.unregister(key);
    // `registry` is deliberately not a dep: its `items` change on every
    // registration, and re-registering on that would never settle. Its
    // register/unregister are stable by construction (see the provider).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);
}
