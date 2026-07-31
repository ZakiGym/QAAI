'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';

/**
 * Which app am I looking at?
 *
 * Six screens — Quality, Flow map, Editor, Source control, Import, and the ⌘P
 * file index — silently did `const first = projects[0]` and never said which
 * project that was. The data model is multi-project, the runs page lists
 * project cards, and the pricing page sells "3 projects" and "10 projects";
 * every screen where work actually happens was single-project by accident.
 *
 * An eng manager with three apps under test opened Quality, saw a flake radar,
 * and had no way to know it belonged to the wrong app. This is the structural
 * hole the rest of the layout problems sit on.
 *
 * The selection is global and persisted, because it is an ambient fact about
 * the session rather than a property of any one screen — the same reason the
 * sidebar collapse state lives in the shell.
 */

const STORAGE_KEY = 'qaai.project.selected';

export interface ProjectLite {
  id: string;
  name: string;
  primaryFramework: string;
  environments: Array<{ id: string; name: string; kind: string; baseUrl: string }>;
}

interface ProjectContextValue {
  projects: ProjectLite[];
  project: ProjectLite | null;
  projectId: string | null;
  setProjectId: (id: string) => void;
  /** False once the first fetch settles, so screens can tell "none" from "not yet". */
  loading: boolean;
  reload: () => Promise<void>;
}

const Ctx = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { projects } = await api<{ projects: ProjectLite[] }>('/projects');
      setProjects(projects);

      setSelectedId((current) => {
        // A stored id for a project that has since been archived or belongs to
        // another org must not win — it would leave every screen querying a
        // project the user cannot see and rendering an unexplained empty state.
        const stored = safeRead();
        const valid = (id: string | null) => (id && projects.some((p) => p.id === id) ? id : null);
        return valid(current) ?? valid(stored) ?? projects[0]?.id ?? null;
      });
    } catch {
      /* signed out, or the API is down — screens surface their own error */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setProjectId = useCallback((id: string) => {
    setSelectedId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private mode — the selection is just per-session */
    }
  }, []);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      project: projects.find((p) => p.id === selectedId) ?? null,
      projectId: selectedId,
      setProjectId,
      loading,
      reload: load,
    }),
    [projects, selectedId, setProjectId, loading, load],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function safeRead(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Never throws without a provider — several surfaces render outside the shell,
 * and a missing provider should not take a page down over a project name.
 */
export function useProject(): ProjectContextValue {
  return (
    useContext(Ctx) ?? {
      projects: [],
      project: null,
      projectId: null,
      setProjectId: () => {},
      loading: false,
      reload: async () => {},
    }
  );
}
