/**
 * What a plugin may ask for, in ONE place.
 *
 * This module exists because there were two answers. The registry's manifest
 * offered `network`, `page`, `filesystem`, `env`, `secrets`, `subprocess` — the
 * RAW capabilities, the things a plugin would like. The runner's sandbox grants
 * `log`, `http`, `secrets`, `fixtures` — the MEDIATED ones, the things QAAI can
 * hand over and still take back — and refuses the raw list by name, with a
 * sentence each.
 *
 * Only `secrets` appeared in both. So an org could install a plugin declaring
 * `network`, be told it was fine, and watch the runner decline to load it on
 * every run afterwards. That fails closed, which is why it is a broken surface
 * rather than a hole — but it is the same "two definitions of one word" defect
 * this codebase keeps producing, and here it would have been discovered by a
 * customer at 3am rather than at install time.
 *
 * The runner's model wins, because it is the one with an argument behind it:
 * you may grant only what you can mediate. A worker thread shares the process's
 * file descriptors and sockets, so `filesystem` and `network` cannot be taken
 * back once given — they are not capabilities QAAI is in a position to offer.
 *
 * So the install screen, the API's validation and the runner's loader all read
 * THIS list, and a plugin that wants something unmediated is refused at the
 * install screen with the sentence naming what to declare instead.
 *
 * Deliberately free of `node:crypto` and of everything else that cannot run in
 * a browser: the install screen imports it through the package barrel, and the
 * signing half (plugin-manifest.ts) is kept out of that barrel for exactly that
 * reason.
 */

/** Everything QAAI mediates, and therefore everything it will grant. */
export const PLUGIN_CAPABILITIES = ['log', 'http', 'secrets', 'fixtures'] as const;
export type PluginCapability = (typeof PLUGIN_CAPABILITIES)[number];

const GRANTABLE: ReadonlySet<string> = new Set<string>(PLUGIN_CAPABILITIES);

export const isGrantableCapability = (name: string): name is PluginCapability =>
  GRANTABLE.has(name);

export interface CapabilityCopy {
  /** Shown as the row title on the install screen. */
  label: string;
  /** What the plugin will be able to do. Written for the person approving it. */
  grants: string;
  /**
   * The limit that still applies once granted. Present so the screen can be
   * specific instead of frightening — "reads secrets" without "only for the
   * project you enable it on" reads as "reads everything".
   */
  bounded: string;
}

/**
 * The sentences the install screen shows, beside the enum rather than in the
 * web app: the API refuses on these same names, and the approver and the
 * enforcer must not end up describing different things.
 */
export const PLUGIN_CAPABILITY_COPY: Record<PluginCapability, CapabilityCopy> = {
  log: {
    label: 'Write to the run log',
    grants: 'Add lines to the log of the run it is part of.',
    bounded: 'Its own run. Output is capped, and the lines are attributed to the plugin.',
  },
  http: {
    label: 'Request the app under test',
    grants: 'Ask QAAI to make HTTP requests on its behalf.',
    bounded:
      'QAAI makes the request, against the environment’s own origin — the plugin never holds a socket.',
  },
  secrets: {
    label: 'Project secrets',
    grants: 'Read the decrypted secrets it names in its manifest.',
    bounded: 'Those secrets, on the projects you enable it for — not the org’s, and not all of them.',
  },
  fixtures: {
    label: 'Test data',
    grants: 'Read the fixtures QAAI hands the run.',
    bounded: 'What the run already loaded. It cannot open files of its own.',
  },
};

/**
 * Capabilities a plugin may ask for and QAAI will not give, each with the
 * reason the person installing it gets to read.
 *
 * Every entry says one thing in a different costume: a worker thread shares the
 * process's file descriptors, sockets and syscall surface, so these cannot be
 * taken back once granted. Each names the mediated capability to declare
 * instead, because a refusal that does not say what to do next is a dead end.
 */
export const REFUSED_CAPABILITIES: Readonly<Record<string, string>> = {
  filesystem:
    'a worker thread shares the process’s file descriptors, so QAAI cannot take back read or write access once it is given. Declare `fixtures` and read the test data QAAI hands you instead.',
  network:
    'raw sockets cannot be scoped to the environment under test from inside the process. Declare `http` and QAAI will make the request for you, against the environment’s own origin.',
  process:
    'reading or mutating the worker process would let a plugin reach the run’s other tenants. There is no mediated form of this.',
  env: 'the worker runs with an empty environment by design. Declare `secrets` and name the secrets you need.',
  child_process:
    'a subprocess escapes every limit the sandbox applies, because the limits are the thread’s and not the machine’s.',
  subprocess:
    'a subprocess escapes every limit the sandbox applies, because the limits are the thread’s and not the machine’s.',
  browser:
    'driving the page directly would let a plugin act as the test rather than observe it. Declare `http` for requests, or emit steps and let QAAI drive.',
  page: 'driving the page directly would let a plugin act as the test rather than observe it. Declare `http` for requests, or emit steps and let QAAI drive.',
  database:
    'the run’s database connection is the platform’s, not the tenant’s. There is no mediated form of this.',
};

/** The reason a capability is refused, or null when it is one QAAI grants. */
export function capabilityRefusal(name: string): string | null {
  if (isGrantableCapability(name)) return null;
  return (
    REFUSED_CAPABILITIES[name] ??
    `QAAI does not know this capability, and grants only what it can mediate: ${PLUGIN_CAPABILITIES.join(', ')}.`
  );
}
