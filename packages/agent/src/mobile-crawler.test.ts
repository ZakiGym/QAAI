import { describe, expect, it } from 'vitest';
import {
  CRAWL_CAPS,
  DEFAULT_CRAWL_POLICY,
  ENUMERATION_OUTCOMES,
  MOBILE_PLATFORMS,
  exercisabilityCounts,
  frontierIsConsistent,
  parseSurfaceKey,
  shouldGenerateAgainst,
  type CrawlPolicy,
} from '@qaai/shared';
/*
 * The REAL `semanticFor`, imported rather than faked, for the reason
 * interact.test.ts imports the real `normaliseRoute`: the one thing a fake
 * could not prove is that this module's field extraction composes with the
 * classifier the rest of the product uses. A local copy that called an email
 * field 'freeform' would make every test here pass and every generated mobile
 * test type prose into an email box.
 */
import { semanticFor } from './crawler.js';
import { INTERACTION_KINDS } from './crawl/interact.js';
import { participationIsHole } from './reconcile.js';
import {
  APPIUM_CAPABILITIES,
  EXPANDED_SCREEN_CLASSES,
  MOBILE_BUDGETS,
  MOBILE_BUDGET_LABELS,
  MOBILE_CONTROL_AS_INTERACTION_KIND,
  MOBILE_CONTROL_KINDS,
  MOBILE_CONTROL_KIND_LABELS,
  MOBILE_CONTROL_KIND_WEIGHT,
  MOBILE_EDGE_KINDS,
  MOBILE_EDGE_KIND_LABELS,
  MOBILE_ENUMERATION_CAPABILITIES,
  MOBILE_FIELD_KINDS,
  MOBILE_FORM_FACTORS,
  MOBILE_IDENTITY_BASES,
  MOBILE_IDENTITY_BASIS_LABELS,
  MOBILE_ROUTE_PREFIX,
  MOBILE_SCREEN_CLASSES,
  MOBILE_SCREEN_CLASS_LABELS,
  MOBILE_UNAVAILABLE_REASONS,
  MOBILE_UNAVAILABLE_REMEDIES,
  MOBILE_CAPABILITY_COST,
  REQUIRED_MOBILE_CAPABILITIES,
  TABLET_SHORTEST_SIDE_DP,
  appiumMobileDevice,
  canonicalRole,
  classifyMobileControl,
  classifyScreen,
  describeMobileReplay,
  discardedByMobileBudgets,
  enumerateMobileScreens,
  fieldGroupFrom,
  formFactorOf,
  isMobileScreenRoute,
  isMobileFieldNode,
  isTappableNode,
  mobileAccessibleName,
  mobileBudgetsFeedTheFrontier,
  mobileBudgetsThatBit,
  mobileReconcileSource,
  mobileScreenIsGeneratable,
  mobileScreenRoute,
  mobileScreenSurfaceItems,
  mobileScreensOf,
  mobileSelectorFor,
  parseViewHierarchy,
  rankMobileCandidate,
  screenAnchorOf,
  screenDigest,
  screenMarkersOf,
  screenSignatureOf,
  viewNodeIdentity,
  type MobileAppIdentity,
  type MobileDevice,
  type MobileDeviceDescriptor,
  type MobileEnumerationCapability,
  type MobileEnumerationEnumerated,
  type MobileEnumerationResult,
  type MobileHttpTransport,
  type MobileOrientation,
  type MobilePrimitives,
  type MobileSwipeDirection,
  type RawScreen,
  type RawViewNode,
} from './mobile-crawler.js';

/**
 * WHAT IS AND IS NOT COVERED HERE, said plainly, in the style
 * `crawl/interact.test.ts` established.
 *
 * Every decision this module makes — is this one screen or two, what kind of
 * control is that, may we tap it, has the container ended, what did a budget
 * cost, did enumeration converge — is a pure function over plain data and is
 * tested below. So is `parseViewHierarchy`, against RECORDED Android and iOS
 * hierarchies: it is the one part of the adapter with judgement in it, and a
 * recorded dump is a complete fixture for it.
 *
 * NOT covered end to end: a real device. There is none here, and that is
 * exactly why `enumerateMobileScreens` takes a `MobileDevice` — the fake below
 * is a screen graph in a literal. `appiumMobileDevice`'s protocol translation
 * IS covered, against an injected transport that records the calls; what is
 * untested is the network round trip, which has no judgement in it.
 */

const primitives: MobilePrimitives = { semanticFor };

function policyWith(overrides: Partial<CrawlPolicy> = {}): CrawlPolicy {
  return { ...DEFAULT_CRAWL_POLICY, ...overrides };
}

const app: MobileAppIdentity = { platform: 'ANDROID', appId: 'com.acme.app' };

const phone: MobileDeviceDescriptor = {
  id: 'emulator-5554',
  platform: 'ANDROID',
  platformVersion: '14',
  formFactor: 'PHONE',
  widthDp: 411,
  heightDp: 891,
  emulator: true,
};

const tablet: MobileDeviceDescriptor = {
  ...phone,
  id: 'emulator-5556',
  formFactor: 'TABLET',
  widthDp: 800,
  heightDp: 1280,
};

function view(overrides: Partial<RawViewNode> & { ref: string }): RawViewNode {
  const base: Omit<RawViewNode, 'ref'> = {
    className: 'android.widget.Button',
    resourceId: null,
    accessibilityId: null,
    text: null,
    value: null,
    hint: null,
    enabled: true,
    displayed: true,
    clickable: true,
    longClickable: false,
    scrollable: false,
    focused: false,
    checkable: false,
    checked: false,
    selected: false,
    password: false,
    index: 0,
    depth: 1,
    bounds: { x: 0, y: 0, width: 100, height: 48 },
    container: null,
  };
  return { ...base, ...overrides };
}

function screen(overrides: Partial<RawScreen> = {}): RawScreen {
  return {
    activity: '.MainActivity',
    packageName: 'com.acme.app',
    title: null,
    nodes: [],
    keyboardShown: false,
    alertText: null,
    orientation: 'PORTRAIT',
    warnings: [],
    ...overrides,
  };
}

// ─── The fake device ─────────────────────────────────────────────────────────

interface FakeApp {
  start: string;
  screens: Record<string, RawScreen>;
  /** `${screenKey}|${viewNodeIdentity}` → the screen key the tap lands on. */
  taps?: Record<string, string>;
  /** `screenKey` → the screen key a back press lands on. */
  back?: Record<string, string>;
  /** `screenKey` → the screen key a swipe reveals. Used for the scroll tests. */
  swipes?: Record<string, string>;
  /** `screenKey` → the screen key a rotation lands on. Default: unchanged. */
  rotations?: Record<string, string>;
}

interface FakeDevice extends MobileDevice {
  readonly calls: string[];
  current(): string;
}

function fakeDevice(
  graph: FakeApp,
  options: {
    capabilities?: readonly MobileEnumerationCapability[];
    devices?: MobileDeviceDescriptor[];
    launchFails?: boolean;
  } = {},
): FakeDevice {
  let current = graph.start;
  const calls: string[] = [];
  const capabilities = options.capabilities ?? MOBILE_ENUMERATION_CAPABILITIES;
  const at = (): RawScreen => graph.screens[current] ?? screen();

  return {
    calls,
    current: () => current,
    capabilities: () => capabilities,
    devices: async () => options.devices ?? [phone],
    launch: async () => {
      calls.push('launch');
      if (options.launchFails === true) return { ok: false, error: 'app not installed' };
      current = graph.start;
      return { ok: true, error: null };
    },
    screen: async () => at(),
    tap: async (ref) => {
      const node = at().nodes.find((candidate) => candidate.ref === ref);
      if (node === undefined) return { ok: false, error: 'stale ref' };
      const identity = viewNodeIdentity(node);
      calls.push(`tap ${current}|${identity}`);
      const next = graph.taps?.[`${current}|${identity}`];
      if (next !== undefined) current = next;
      return { ok: true, error: null };
    },
    type: async (ref, value) => {
      calls.push(`type ${ref}=${value}`);
      return { ok: true, error: null };
    },
    swipe: async (input: { ref: string | null; direction: MobileSwipeDirection }) => {
      calls.push(`swipe ${input.direction}`);
      const next = graph.swipes?.[current];
      if (next !== undefined) current = next;
      return { ok: true, error: null };
    },
    back: async () => {
      calls.push(`back ${current}`);
      const next = graph.back?.[current];
      if (next !== undefined) current = next;
      return { ok: true, error: null, mechanism: 'HARDWARE_BUTTON' };
    },
    hideKeyboard: async () => {
      calls.push('hideKeyboard');
      const next = graph.rotations?.[`keyboard:${current}`];
      if (next !== undefined) current = next;
      return { ok: true, error: null };
    },
    rotate: async (orientation: MobileOrientation) => {
      calls.push(`rotate ${orientation}`);
      const next = graph.rotations?.[current];
      if (next !== undefined && orientation === 'LANDSCAPE') current = next;
      else if (orientation === 'PORTRAIT') current = graph.start;
      return { ok: true, error: null };
    },
  };
}

function enumerated(result: MobileEnumerationResult): MobileEnumerationEnumerated {
  if (result.status !== 'ENUMERATED') {
    throw new Error(`expected ENUMERATED, got UNAVAILABLE (${result.reason}: ${result.detail})`);
  }
  return result;
}

// ─── Recorded hierarchies ────────────────────────────────────────────────────

/**
 * A real-shaped Android uiautomator dump.
 *
 * Deliberately includes the four things a naive parser gets wrong: a literal
 * `>` inside an attribute value (legal in XML and common in a row label), an
 * `&amp;` entity, a clickable label THREE levels inside a
 * `BottomNavigationView` (so container inheritance is load-bearing), and a
 * `RecyclerView` whose rows carry no id at all.
 */
const ANDROID_DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" package="com.acme.app" bounds="[0,0][1080,2340]">
    <node index="0" class="androidx.appcompat.widget.Toolbar" resource-id="com.acme.app:id/toolbar" bounds="[0,0][1080,168]">
      <node index="0" class="android.widget.TextView" text="Orders &amp; returns" bounds="[48,60][600,140]" />
    </node>
    <node index="1" class="androidx.recyclerview.widget.RecyclerView" resource-id="com.acme.app:id/orders" scrollable="true" bounds="[0,168][1080,2100]">
      <node index="0" class="android.widget.LinearLayout" clickable="true" content-desc="Rows > 10" bounds="[0,168][1080,330]">
        <node index="0" class="android.widget.TextView" text="ORD-1001 · 2 minutes ago" bounds="[48,200][700,260]" />
      </node>
      <node index="1" class="android.widget.LinearLayout" clickable="true" content-desc="Order ORD-1002" bounds="[0,330][1080,492]" />
    </node>
    <node index="2" class="com.google.android.material.bottomnavigation.BottomNavigationView" resource-id="com.acme.app:id/tabs" bounds="[0,2100][1080,2340]">
      <node index="0" class="android.view.ViewGroup" bounds="[0,2100][540,2340]">
        <node index="0" class="android.widget.TextView" text="Orders" clickable="true" selected="true" bounds="[100,2160][440,2280]" />
      </node>
      <node index="1" class="android.view.ViewGroup" bounds="[540,2100][1080,2340]">
        <node index="0" class="android.widget.TextView" text="Account" clickable="true" selected="false" bounds="[640,2160][980,2280]" />
      </node>
    </node>
  </node>
</hierarchy>`;

/** A real-shaped iOS XCUITest dump: `visible`, x/y/w/h, and a secure field. */
const IOS_DUMP = `<AppiumAUT>
  <XCUIElementTypeApplication type="XCUIElementTypeApplication" name="Acme" label="Acme" enabled="true" visible="true" x="0" y="0" width="390" height="844">
    <XCUIElementTypeNavigationBar type="XCUIElementTypeNavigationBar" name="Sign in" enabled="true" visible="true" x="0" y="44" width="390" height="50"/>
    <XCUIElementTypeTextField type="XCUIElementTypeTextField" name="email" value="" enabled="true" visible="true" x="20" y="120" width="350" height="44"/>
    <XCUIElementTypeSecureTextField type="XCUIElementTypeSecureTextField" name="password" enabled="true" visible="true" x="20" y="180" width="350" height="44"/>
    <XCUIElementTypeSwitch type="XCUIElementTypeSwitch" name="remember me" value="0" enabled="true" visible="true" x="20" y="240" width="60" height="30"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="Sign in" label="Sign in" enabled="true" visible="true" x="20" y="300" width="350" height="44"/>
    <XCUIElementTypeButton type="XCUIElementTypeButton" name="hidden-cta" enabled="true" visible="false" x="0" y="0" width="0" height="0"/>
  </XCUIElementTypeApplication>
</AppiumAUT>`;

// ─── The vocabularies ────────────────────────────────────────────────────────

describe('the vocabularies', () => {
  /*
   * THE PATTERN THIS CODEBASE ENFORCES, and the reason it is enforced twice.
   * Eight GateRule kinds shipped unsaveable for two slices because only the
   * compiler-enforced `Record` existed and nothing checked it at run time, and
   * `check:wiring` cannot see that class of defect. A `Record<Kind, …>` keeps a
   * LABEL from going missing; these tests keep the two from drifting in the
   * other direction, where a label exists for a kind the union dropped.
   */
  it('gives every control kind a label, a weight and a policy mapping', () => {
    for (const kind of MOBILE_CONTROL_KINDS) {
      expect(MOBILE_CONTROL_KIND_LABELS[kind], kind).toBeTruthy();
      expect(MOBILE_CONTROL_KIND_WEIGHT[kind], kind).toBeGreaterThanOrEqual(0);
      expect(MOBILE_CONTROL_KIND_WEIGHT[kind], kind).toBeLessThanOrEqual(1);
      expect(INTERACTION_KINDS, kind).toContain(MOBILE_CONTROL_AS_INTERACTION_KIND[kind]);
    }
    expect(Object.keys(MOBILE_CONTROL_KIND_LABELS).sort()).toEqual(
      [...MOBILE_CONTROL_KINDS].sort(),
    );
    expect(Object.keys(MOBILE_CONTROL_KIND_WEIGHT).sort()).toEqual(
      [...MOBILE_CONTROL_KINDS].sort(),
    );
    expect(Object.keys(MOBILE_CONTROL_AS_INTERACTION_KIND).sort()).toEqual(
      [...MOBILE_CONTROL_KINDS].sort(),
    );
  });

  it('labels every screen class, edge kind, budget and identity basis', () => {
    expect(Object.keys(MOBILE_SCREEN_CLASS_LABELS).sort()).toEqual(
      [...MOBILE_SCREEN_CLASSES].sort(),
    );
    expect(Object.keys(MOBILE_EDGE_KIND_LABELS).sort()).toEqual([...MOBILE_EDGE_KINDS].sort());
    expect(Object.keys(MOBILE_BUDGET_LABELS).sort()).toEqual([...MOBILE_BUDGETS].sort());
    expect(Object.keys(MOBILE_IDENTITY_BASIS_LABELS).sort()).toEqual(
      [...MOBILE_IDENTITY_BASES].sort(),
    );
  });

  it('costs every capability as an unknown, never as a zero', () => {
    expect(Object.keys(MOBILE_CAPABILITY_COST).sort()).toEqual(
      [...MOBILE_ENUMERATION_CAPABILITIES].sort(),
    );
    for (const capability of MOBILE_ENUMERATION_CAPABILITIES) {
      const cost = MOBILE_CAPABILITY_COST[capability];
      expect(cost, capability).toBeTruthy();
      // The sentence has to name the unknown, not report a zero.
      expect(cost.toLowerCase(), capability).not.toMatch(/\breports? 0\b|\bis 0\b|\bnone found\b/);
    }
    for (const required of REQUIRED_MOBILE_CAPABILITIES) {
      expect(MOBILE_ENUMERATION_CAPABILITIES).toContain(required);
    }
  });

  it('gives every unavailable reason a remedy a customer can act on', () => {
    expect(Object.keys(MOBILE_UNAVAILABLE_REMEDIES).sort()).toEqual(
      [...MOBILE_UNAVAILABLE_REASONS].sort(),
    );
    for (const reason of MOBILE_UNAVAILABLE_REASONS) {
      expect(MOBILE_UNAVAILABLE_REMEDIES[reason].length, reason).toBeGreaterThan(40);
    }
  });

  it('expands the app class and nothing else', () => {
    expect([...EXPANDED_SCREEN_CLASSES]).toEqual(['APP']);
    for (const kind of MOBILE_FIELD_KINDS) expect(MOBILE_CONTROL_KINDS).toContain(kind);
  });

  it('reuses the shared enumeration outcomes rather than respelling them', () => {
    expect(ENUMERATION_OUTCOMES).toContain('CONVERGED');
    expect(ENUMERATION_OUTCOMES).toContain('STOPPED');
    expect(ENUMERATION_OUTCOMES).toContain('FAILED');
  });
});

// ─── The hierarchy parser ────────────────────────────────────────────────────

describe('parseViewHierarchy — android', () => {
  const parsed = parseViewHierarchy(ANDROID_DUMP, 'ANDROID');

  it('reads every element, with no warnings on a well-formed dump', () => {
    expect(parsed.warnings).toEqual([]);
    expect(parsed.nodes.length).toBe(12);
  });

  it('survives a literal > inside an attribute value', () => {
    /*
     * THE DEFECT: a naive `indexOf('>')` ends the element at the `>` inside
     * `content-desc="Rows > 10"`, which silently drops `bounds` and every
     * attribute after it on exactly the rows that mention a comparison.
     */
    const row = parsed.nodes.find((node) => node.accessibilityId === 'Rows > 10');
    expect(row).toBeDefined();
    expect(row?.clickable).toBe(true);
    expect(row?.bounds).toEqual({ x: 0, y: 168, width: 1080, height: 162 });
  });

  it('decodes entities', () => {
    const heading = parsed.nodes.find((node) => node.text === 'Orders & returns');
    expect(heading).toBeDefined();
  });

  it('inherits the container down the tree, so a tab label is a tab', () => {
    /*
     * The tab's label is a TextView THREE levels inside a
     * BottomNavigationView. Without inheritance it classifies as nothing, and
     * the two most valuable controls on a native screen vanish from the
     * denominator.
     */
    const ordersTab = parsed.nodes.find((node) => node.text === 'Orders');
    expect(ordersTab?.container).toBe('tabbar');
    expect(classifyMobileControl(ordersTab!)).toBe('TAB_BAR_ITEM');
    const row = parsed.nodes.find((node) => node.accessibilityId === 'Order ORD-1002');
    expect(row?.container).toBe('list');
    expect(classifyMobileControl(row!)).toBe('LIST_ROW');
  });

  it('reads the toolbar title and the scrollable container', () => {
    expect(parsed.title).toBe('Orders & returns');
    const list = parsed.nodes.find((node) => node.resourceId === 'com.acme.app:id/orders');
    expect(list?.scrollable).toBe(true);
    expect(classifyMobileControl(list!)).toBe('SCROLL_CONTAINER');
  });

  it('builds a per-class xpath ref, so the index selects the element it names', () => {
    const refs = parsed.nodes.map((node) => node.ref);
    expect(new Set(refs).size).toBe(refs.length);
    /*
     * THE SEGMENT IS THE CLASS, because that is the xpath Appium resolves. A
     * ref built from the literal `node` tag resolves to nothing against the
     * driver, so every tap would come back "element not found".
     */
    expect(refs[0]).toBe('/hierarchy[1]/android.widget.FrameLayout[1]');
    expect(refs).toContain(
      '/hierarchy[1]/android.widget.FrameLayout[1]/androidx.appcompat.widget.Toolbar[1]',
    );
    expect(refs.some((ref) => ref.includes('/android.widget.LinearLayout[2]'))).toBe(true);
    expect(refs.some((ref) => ref.includes('/node['))).toBe(false);
  });
});

describe('parseViewHierarchy — ios', () => {
  const parsed = parseViewHierarchy(IOS_DUMP, 'IOS');

  it('keeps the envelope in the xpath while leaving it out of the node list', () => {
    /*
     * `/AppiumAUT/XCUIElementTypeApplication[1]/…` is what Appium resolves.
     * Dropping the envelope from the path yields a relative xpath the driver
     * cannot resolve, so every tap would come back "element not found".
     */
    expect(parsed.nodes.some((node) => node.className === 'AppiumAUT')).toBe(false);
    expect(parsed.nodes.some((node) => node.className === 'XCUIElementTypeApplication')).toBe(
      false,
    );
    expect(parsed.nodes[0]?.ref).toBe(
      '/AppiumAUT[1]/XCUIElementTypeApplication[1]/XCUIElementTypeNavigationBar[1]',
    );
  });

  it('reads name, value and the visible flag', () => {
    expect(parsed.warnings).toEqual([]);
    const email = parsed.nodes.find((node) => node.accessibilityId === 'email');
    expect(email?.className).toBe('XCUIElementTypeTextField');
    expect(email?.displayed).toBe(true);
    expect(email?.bounds).toEqual({ x: 20, y: 120, width: 350, height: 44 });
    const hidden = parsed.nodes.find((node) => node.accessibilityId === 'hidden-cta');
    expect(hidden?.displayed).toBe(false);
    expect(classifyMobileControl(hidden!)).toBeNull();
  });

  it('NEVER captures a secure field value, even when the dump reports one', () => {
    /*
     * THE DEFECT, and it is a security defect rather than a tidiness one. iOS
     * reports a secure field's contents in `value`, so a dump taken while a
     * sign-in form is half typed carries a partial password — and a
     * `RawViewNode` flows into a screen digest, a stored FlowMap, an exported
     * report and a cockpit.
     */
    const withTyped = IOS_DUMP.replace(
      'name="password" enabled="true"',
      'name="password" value="hunter2-partial" enabled="true"',
    );
    const reparsed = parseViewHierarchy(withTyped, 'IOS');
    const password = reparsed.nodes.find((node) => node.accessibilityId === 'password');
    expect(password?.password).toBe(true);
    expect(password?.value).toBeNull();
    expect(JSON.stringify(reparsed)).not.toContain('hunter2');

    const group = fieldGroupFrom({
      nodes: reparsed.nodes,
      screenId: 'id',
      route: '/mobile/ios/com.acme.Acme/x',
      keyboardBlocked: false,
      primitives,
    });
    const field = group?.fields.find((candidate) => candidate.label === 'password');
    expect(field?.secure).toBe(true);
    expect(field?.semantic).toBe('password');
    expect(JSON.stringify(group)).not.toContain('hunter2');
    // The screen's identity digest cannot carry it either.
    const signature = screenSignatureOf(
      screen({ activity: null, title: null, nodes: reparsed.nodes }),
      { platform: 'IOS', appId: 'com.acme.Acme' },
    );
    expect(JSON.stringify(signature)).not.toContain('hunter2');
  });

  it('trusts the platform secure flag over the label, so a PIN is not a card number', () => {
    /*
     * THE DEFECT: `semanticFor` reads "pin" as `unknown` and "Card PIN" as
     * `credit_card`, so a synthetic generator would type a card number into a
     * four-digit secure field. The platform's own `secure` flag is a statement
     * by the developer and beats every heuristic available to us, which is why
     * it short-circuits the classifier rather than being one more input to it.
     */
    const withPin = IOS_DUMP.replace(
      'XCUIElementTypeSecureTextField" name="password"',
      'XCUIElementTypeSecureTextField" name="Card PIN"',
    );
    const reparsed = parseViewHierarchy(withPin, 'IOS');
    const pin = reparsed.nodes.find((node) => node.accessibilityId === 'Card PIN');
    expect(pin?.password).toBe(true);
    // What the label alone would have said, to make the difference visible.
    expect(semanticFor('', 'textfield', 'Card PIN', null)).toBe('credit_card');
    const group = fieldGroupFrom({
      nodes: reparsed.nodes,
      screenId: 'id',
      route: '/mobile/ios/com.acme.Acme/x',
      keyboardBlocked: false,
      primitives,
    });
    expect(group?.fields.find((field) => field.label === 'Card PIN')?.semantic).toBe('password');
  });

  it('classifies an iOS control although the dump has no clickable attribute', () => {
    /*
     * THE DEFECT THIS COVERS IS THE WHOLE iOS AXIS. iOS hierarchies carry no
     * `clickable`, so a clickability test alone returns null for every control
     * on every iPhone screen — an iOS app would enumerate as screens with no
     * controls on any of them, which is a zero that is not a measurement.
     */
    const signIn = parsed.nodes.find(
      (node) => node.className === 'XCUIElementTypeButton' && node.accessibilityId === 'Sign in',
    );
    expect(signIn?.clickable).toBe(false);
    expect(isTappableNode(signIn!)).toBe(true);
    expect(classifyMobileControl(signIn!)).toBe('BUTTON');
  });

  it('takes the navigation bar title as the anchor when there is no activity', () => {
    const raw = screen({
      activity: null,
      packageName: 'com.acme.Acme',
      title: parsed.title,
      nodes: parsed.nodes,
    });
    const anchor = screenAnchorOf(raw);
    expect(anchor.basis).toBe('ANCHORED');
    expect(anchor.anchor).toBe('title:sign in');
  });

  it('classifies the native field kinds', () => {
    const kinds = parsed.nodes
      .map((node) => classifyMobileControl(node))
      .filter((kind) => kind !== null);
    expect(kinds).toContain('TEXT_FIELD');
    expect(kinds).toContain('SWITCH');
    expect(kinds).toContain('BUTTON');
    expect(kinds).toContain('NAV_BAR_ITEM');
  });
});

describe('parseViewHierarchy — the failure modes it must name', () => {
  it('warns rather than reporting an empty screen for an empty source', () => {
    const parsed = parseViewHierarchy('   ', 'ANDROID');
    expect(parsed.nodes).toEqual([]);
    expect(parsed.warnings.join(' ')).toContain('empty page source');
  });

  it('warns when an element never closes, so a half-read dump says so', () => {
    const parsed = parseViewHierarchy('<hierarchy><node class="android.widget.Button"', 'ANDROID');
    expect(parsed.warnings.join(' ')).toContain('not closed');
  });

  it('warns when nothing parsed at all', () => {
    const parsed = parseViewHierarchy('not xml at all', 'ANDROID');
    expect(parsed.warnings.join(' ')).toContain('no elements');
  });
});

// ─── Screen identity ─────────────────────────────────────────────────────────

describe('screen identity', () => {
  it('ranks the anchor by what the app declares', () => {
    expect(screenAnchorOf(screen({ activity: '.CheckoutActivity' })).anchor).toBe(
      'activity:.CheckoutActivity',
    );
    expect(screenAnchorOf(screen({ activity: null, title: 'Checkout' })).anchor).toBe(
      'title:checkout',
    );
    expect(
      screenAnchorOf(
        screen({
          activity: null,
          title: null,
          nodes: [view({ ref: 'a', depth: 0, resourceId: 'com.acme.app:id/root' })],
        }),
      ).anchor,
    ).toBe('root:com.acme.app:id/root');
    const none = screenAnchorOf(
      screen({ activity: null, title: null, nodes: [view({ ref: 'a' })] }),
    );
    expect(none.anchor).toBeNull();
    expect(none.basis).toBe('STRUCTURAL');
    expect(none.why).toContain('control set');
  });

  it('IS ONE NODE on a phone and on a tablet', () => {
    /*
     * THE REQUIREMENT, as the arithmetic it protects. A tablet shows the
     * master-detail two-pane layout of the same screen: same activity, extra
     * controls, different geometry. Two nodes here would double the mobile
     * denominator on any customer who ships both form factors.
     */
    const onPhone = screen({
      activity: '.OrdersActivity',
      nodes: [
        view({
          ref: 'a',
          accessibilityId: 'orders-list',
          bounds: { x: 0, y: 0, width: 411, height: 800 },
        }),
      ],
    });
    const onTablet = screen({
      activity: '.OrdersActivity',
      nodes: [
        view({
          ref: 'a',
          accessibilityId: 'orders-list',
          bounds: { x: 0, y: 0, width: 400, height: 1280 },
        }),
        view({
          ref: 'b',
          accessibilityId: 'order-detail-pane',
          bounds: { x: 400, y: 0, width: 400, height: 1280 },
        }),
      ],
    });
    const left = screenSignatureOf(onPhone, app);
    const right = screenSignatureOf(onTablet, app);
    expect(left.id).toBe(right.id);
    expect(left.basis).toBe('ANCHORED');
  });

  it('IS ONE NODE across a rotation', () => {
    const portrait = screen({
      activity: '.OrdersActivity',
      orientation: 'PORTRAIT',
      nodes: [
        view({
          ref: 'a',
          accessibilityId: 'cta',
          bounds: { x: 0, y: 700, width: 411, height: 48 },
        }),
      ],
    });
    const landscape = screen({
      ...portrait,
      orientation: 'LANDSCAPE',
      nodes: [
        view({
          ref: 'a',
          accessibilityId: 'cta',
          bounds: { x: 500, y: 300, width: 300, height: 48 },
        }),
      ],
    });
    expect(screenSignatureOf(portrait, app).id).toBe(screenSignatureOf(landscape, app).id);
  });

  it('is NOT a new node when the live tab is re-selected, and IS when another is', () => {
    const onOrders = screen({
      activity: '.ShellActivity',
      nodes: [
        view({ ref: 'a', accessibilityId: 'tab-orders', container: 'tabbar', selected: true }),
        view({ ref: 'b', accessibilityId: 'tab-account', container: 'tabbar', selected: false }),
      ],
    });
    // Re-tapping the live tab changes nothing the app declares.
    const reselected = screen({ ...onOrders, nodes: [...onOrders.nodes] });
    expect(screenSignatureOf(onOrders, app).id).toBe(screenSignatureOf(reselected, app).id);

    const onAccount = screen({
      activity: '.ShellActivity',
      nodes: [
        view({ ref: 'a', accessibilityId: 'tab-orders', container: 'tabbar', selected: false }),
        view({ ref: 'b', accessibilityId: 'tab-account', container: 'tabbar', selected: true }),
      ],
    });
    expect(screenSignatureOf(onOrders, app).id).not.toBe(screenSignatureOf(onAccount, app).id);
  });

  it('separates a dialog from the screen beneath it', () => {
    const plain = screen({ activity: '.CameraActivity', nodes: [view({ ref: 'a' })] });
    const withAlert = screen({ ...plain, alertText: 'Allow Acme to take pictures?' });
    expect(screenSignatureOf(plain, app).id).not.toBe(screenSignatureOf(withAlert, app).id);
    expect(screenSignatureOf(withAlert, app).markers.join(' ')).toContain('alert:');
  });

  it('treats a screen with its keyboard up as the same screen', () => {
    const closed = screen({ activity: '.LoginActivity', nodes: [view({ ref: 'a' })] });
    const open = screen({ ...closed, keyboardShown: true });
    expect(screenSignatureOf(closed, app).id).toBe(screenSignatureOf(open, app).id);
    expect(screenMarkersOf(open).keyboardShown).toBe(true);
  });

  it('falls back to a STRUCTURAL identity that ignores geometry but not controls', () => {
    const bare = (nodes: RawViewNode[]): RawScreen =>
      screen({ activity: null, title: null, nodes });
    const one = bare([view({ ref: 'a', text: 'Continue' })]);
    const moved = bare([
      view({ ref: 'a', text: 'Continue', bounds: { x: 9, y: 9, width: 9, height: 9 } }),
    ]);
    const different = bare([
      view({ ref: 'a', text: 'Continue' }),
      view({ ref: 'b', text: 'Skip' }),
    ]);
    expect(screenSignatureOf(one, app).basis).toBe('STRUCTURAL');
    expect(screenSignatureOf(one, app).id).toBe(screenSignatureOf(moved, app).id);
    // The honest caveat: a different control set is a different structural id.
    expect(screenSignatureOf(one, app).id).not.toBe(screenSignatureOf(different, app).id);
  });

  it('normalises volatile row text out of identity', () => {
    const atFirstRead = screen({
      activity: null,
      title: null,
      nodes: [view({ ref: 'a', text: 'ORD-1001 · 2 minutes ago' })],
    });
    const aMinuteLater = screen({
      activity: null,
      title: null,
      nodes: [view({ ref: 'a', text: 'ORD-1001 · 3 minutes ago' })],
    });
    expect(screenSignatureOf(atFirstRead, app).id).toBe(screenSignatureOf(aMinuteLater, app).id);
  });

  it('puts every screen under the reserved route prefix', () => {
    const signature = screenSignatureOf(screen({ activity: '.MainActivity' }), app);
    expect(signature.route.startsWith(MOBILE_ROUTE_PREFIX)).toBe(true);
    expect(isMobileScreenRoute(signature.route)).toBe(true);
    expect(isMobileScreenRoute('/orders/:id')).toBe(false);
    expect(signature.url.startsWith('mobile://')).toBe(true);
    expect(mobileScreenRoute(app, 'a b')).toContain('a-b');
  });

  it('ignores order and repetition in the digest, so a long list is one screen', () => {
    const rows = [view({ ref: 'a', text: 'Row' }), view({ ref: 'b', text: 'Row' })];
    expect(screenDigest({ nodes: rows, markers: [] })).toBe(
      screenDigest({ nodes: [rows[1]!, rows[0]!], markers: [] }),
    );
  });
});

describe('classifyScreen', () => {
  it('names the permission dialog by its PACKAGE, not by its words', () => {
    const dialog = screen({
      packageName: 'com.android.permissioncontroller',
      alertText: 'Zulassen?',
    });
    expect(classifyScreen(dialog, app).class).toBe('OS_PERMISSION');
  });

  it('names the system sheet and another app', () => {
    expect(classifyScreen(screen({ packageName: 'com.android.intentresolver' }), app).class).toBe(
      'OS_SHEET',
    );
    const other = classifyScreen(screen({ packageName: 'com.android.chrome' }), app);
    expect(other.class).toBe('OTHER_APP');
    expect(other.why).toContain('com.android.chrome');
  });

  it('says the boundary could not be checked rather than guessing', () => {
    const unknown = classifyScreen(screen({ packageName: null }), app);
    expect(unknown.class).toBe('APP');
    expect(unknown.why).toContain('could not be checked');
  });

  it('recognises the keyboard occluding everything', () => {
    const occluded = screen({ keyboardShown: true, nodes: [view({ ref: 'a', displayed: false })] });
    expect(classifyScreen(occluded, app).class).toBe('KEYBOARD');
  });
});

// ─── Controls ────────────────────────────────────────────────────────────────

describe('control classification', () => {
  it('maps both platforms class names to one role', () => {
    expect(canonicalRole('android.widget.Button')).toBe('button');
    expect(canonicalRole('XCUIElementTypeButton')).toBe('button');
    expect(canonicalRole('androidx.recyclerview.widget.RecyclerView')).toBe('list');
    expect(canonicalRole('XCUIElementTypeSwitch')).toBe('switch');
    // Unrecognised is `view`, which is what the hierarchy said. Not a guess.
    expect(canonicalRole('com.acme.FancyThing')).toBe('view');
  });

  it('CLASSIFIES a disabled control rather than erasing it', () => {
    /*
     * THE DEFECT, on the native axis. A pager whose "Previous" is disabled on
     * page 1 has TWO pagination controls; dropping the disabled one reports it
     * as having one, and nothing in the report says a control was left out.
     */
    const disabled = view({ ref: 'a', text: 'Previous', enabled: false });
    expect(classifyMobileControl(disabled)).toBe('WIZARD_STEP');
  });

  it('returns null only for a hidden control', () => {
    expect(classifyMobileControl(view({ ref: 'a', displayed: false }))).toBeNull();
    expect(
      classifyMobileControl(
        view({ ref: 'a', clickable: false, className: 'android.widget.TextView' }),
      ),
    ).toBeNull();
  });

  it('lets the container decide before the label does', () => {
    const base = { ref: 'a', text: 'Settings', clickable: true } as const;
    expect(classifyMobileControl(view({ ...base, container: 'tabbar' }))).toBe('TAB_BAR_ITEM');
    expect(classifyMobileControl(view({ ...base, container: 'navbar' }))).toBe('NAV_BAR_ITEM');
    expect(classifyMobileControl(view({ ...base, container: 'list' }))).toBe('LIST_ROW');
    expect(classifyMobileControl(view({ ...base, container: null }))).toBe('BUTTON');
  });

  it('knows a field from an affordance', () => {
    expect(isMobileFieldNode(view({ ref: 'a', className: 'android.widget.EditText' }))).toBe(true);
    expect(isMobileFieldNode(view({ ref: 'a', className: 'android.widget.Button' }))).toBe(false);
    expect(classifyMobileControl(view({ ref: 'a', className: 'android.widget.Switch' }))).toBe(
      'SWITCH',
    );
    expect(classifyMobileControl(view({ ref: 'a', className: 'android.widget.Spinner' }))).toBe(
      'PICKER',
    );
  });

  it('prefers the accessibility id as the locator and flags an xpath', () => {
    expect(mobileSelectorFor(view({ ref: 'x', accessibilityId: 'cta' }))).toEqual({
      selector: { using: 'accessibility id', value: 'cta' },
      confidence: 0.95,
    });
    expect(mobileSelectorFor(view({ ref: 'x', resourceId: 'id/cta' })).selector.using).toBe('id');
    const weak = mobileSelectorFor(view({ ref: '/hierarchy[1]/node[2]' }));
    expect(weak.selector.using).toBe('xpath');
    expect(weak.confidence).toBeLessThan(0.6);
  });

  it('names a control in the application own case', () => {
    expect(
      mobileAccessibleName(view({ ref: 'a', accessibilityId: 'Check Out', text: 'check out' })),
    ).toBe('Check Out');
    expect(mobileAccessibleName(view({ ref: 'a', text: '  spaced   out ' }))).toBe('spaced out');
  });

  it('ranks a tab bar item above a plain button and an inert one last', () => {
    const tab = view({ ref: 'a', container: 'tabbar', accessibilityId: 'tab' });
    const button = view({ ref: 'b', text: 'Thing' });
    expect(rankMobileCandidate(tab, 'TAB_BAR_ITEM', new Set(), 'i')).toBeGreaterThan(
      rankMobileCandidate(button, 'BUTTON', new Set(), 'j'),
    );
    expect(
      rankMobileCandidate({ ...tab, selected: true }, 'TAB_BAR_ITEM', new Set(), 'i'),
    ).toBeLessThan(rankMobileCandidate(tab, 'TAB_BAR_ITEM', new Set(), 'i'));
    expect(rankMobileCandidate(tab, 'TAB_BAR_ITEM', new Set(['i']), 'i')).toBeLessThan(
      rankMobileCandidate(tab, 'TAB_BAR_ITEM', new Set(), 'i'),
    );
  });

  it('keys identity on the route, so one Save is not five', () => {
    const left = screenSignatureOf(screen({ activity: '.A' }), app).route;
    const right = screenSignatureOf(screen({ activity: '.B' }), app).route;
    expect(left).not.toBe(right);
  });
});

describe('form factor', () => {
  it('measures it, and says UNKNOWN when it cannot', () => {
    expect(formFactorOf({ widthDp: 411, heightDp: 891 })).toBe('PHONE');
    expect(formFactorOf({ widthDp: 800, heightDp: 1280 })).toBe('TABLET');
    expect(formFactorOf({ widthDp: TABLET_SHORTEST_SIDE_DP, heightDp: 1024 })).toBe('TABLET');
    expect(formFactorOf({ widthDp: null, heightDp: 1280 })).toBe('UNKNOWN');
    expect(formFactorOf({ widthDp: 0, heightDp: 0 })).toBe('UNKNOWN');
    expect(MOBILE_FORM_FACTORS).toContain('UNKNOWN');
  });
});

// ─── UNAVAILABLE: the sentence this module must never get wrong ─────────────

describe('UNAVAILABLE', () => {
  const graph: FakeApp = { start: 's', screens: { s: screen({ nodes: [view({ ref: 'a' })] }) } };

  it('reports NO_DEVICE with a remedy and NO screens field', async () => {
    const result = await enumerateMobileScreens(fakeDevice(graph, { devices: [] }), {
      app,
      policy: policyWith(),
      primitives,
    });
    expect(result.status).toBe('UNAVAILABLE');
    if (result.status !== 'UNAVAILABLE') throw new Error('unreachable');
    expect(result.reason).toBe('NO_DEVICE');
    expect(result.outcome).toBe('FAILED');
    expect(result.remedy).toContain('emulator');
    /*
     * THE WHOLE POINT. An empty graph reads as "this app has no mobile
     * screens", which enters the denominator as a complete measurement of zero
     * surface — and a zero denominator reports as 100% covered. The union has
     * no `screens` member to misread.
     */
    expect('screens' in result).toBe(false);
    expect(mobileScreensOf(result)).toBeNull();
  });

  it('reports MISSING_CAPABILITY naming what the driver lacks', async () => {
    const result = await enumerateMobileScreens(
      fakeDevice(graph, { capabilities: ['TAP', 'LAUNCH'] }),
      { app, policy: policyWith(), primitives },
    );
    if (result.status !== 'UNAVAILABLE') throw new Error('expected UNAVAILABLE');
    expect(result.reason).toBe('MISSING_CAPABILITY');
    expect(result.detail).toContain('HIERARCHY');
    expect(result.unavailable.map((gap) => gap.capability)).toContain('HIERARCHY');
  });

  it('reports APP_NOT_LAUNCHED with the driver own reason', async () => {
    const result = await enumerateMobileScreens(fakeDevice(graph, { launchFails: true }), {
      app,
      policy: policyWith(),
      primitives,
    });
    if (result.status !== 'UNAVAILABLE') throw new Error('expected UNAVAILABLE');
    expect(result.reason).toBe('APP_NOT_LAUNCHED');
    expect(result.detail).toContain('app not installed');
  });

  it('reports HIERARCHY_UNREADABLE rather than a screen with no controls', async () => {
    const result = await enumerateMobileScreens(
      fakeDevice({ start: 's', screens: { s: screen({ nodes: [] }) } }),
      { app, policy: policyWith(), primitives },
    );
    if (result.status !== 'UNAVAILABLE') throw new Error('expected UNAVAILABLE');
    expect(result.reason).toBe('HIERARCHY_UNREADABLE');
  });

  it('contributes nothing to the inventory and a HOLE to the reconciliation', async () => {
    const result = await enumerateMobileScreens(fakeDevice(graph, { devices: [] }), {
      app,
      policy: policyWith(),
      primitives,
    });
    expect(mobileScreenSurfaceItems(result, { environmentId: 'env-1' })).toEqual([]);
    const source = mobileReconcileSource(result, 'env-1');
    /*
     * FAILED, NOT NOT_CONFIGURED. A caller who asked for mobile enumeration has
     * a mobile app: the surface exists, the observation was owed, and we do not
     * have it. NOT_CONFIGURED costs the comparison nothing by definition, so
     * filing "no emulator was attached" under it would erase the mobile hole
     * from the report entirely.
     */
    expect(source.participation).toBe('FAILED');
    expect(source.entries).toEqual([]);
    expect(source.detail).toContain('emulator');
    expect(participationIsHole({ participation: source.participation, counted: false })).toBe(true);
    expect(participationIsHole({ participation: 'NOT_CONFIGURED', counted: false })).toBe(false);
  });
});

// ─── The traversal ───────────────────────────────────────────────────────────

/** Orders → Account tab, Orders → an order detail, detail → back to Orders. */
function threeScreenApp(): FakeApp {
  const shell = (selected: 'orders' | 'account'): RawViewNode[] => [
    view({
      ref: 'tab-orders',
      accessibilityId: 'tab-orders',
      container: 'tabbar',
      selected: selected === 'orders',
    }),
    view({
      ref: 'tab-account',
      accessibilityId: 'tab-account',
      container: 'tabbar',
      selected: selected === 'account',
    }),
  ];
  return {
    start: 'orders',
    screens: {
      orders: screen({
        activity: '.ShellActivity',
        title: 'Orders',
        nodes: [
          ...shell('orders'),
          view({ ref: 'row-1', accessibilityId: 'order-ORD-1001', container: 'list' }),
        ],
      }),
      account: screen({
        activity: '.ShellActivity',
        title: 'Account',
        nodes: shell('account'),
      }),
      detail: screen({
        activity: '.OrderDetailActivity',
        title: 'Order ORD-1001',
        nodes: [view({ ref: 'reorder', accessibilityId: 'reorder' })],
      }),
    },
    taps: {
      'orders|a11y:tab-account': 'account',
      'orders|a11y:order-ORD-1001': 'detail',
      'account|a11y:tab-orders': 'orders',
    },
    back: { detail: 'orders', account: 'orders' },
  };
}

describe('enumerateMobileScreens', () => {
  it('builds a FlowMap-compatible graph and CONVERGES with a number', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    expect(result.outcome).toBe('CONVERGED');
    expect(result.why).toMatch(/\d+ screen\(s\) enumerated/);
    expect(result.screens.length).toBe(3);
    expect(result.screens.map((node) => node.title).sort()).toEqual([
      'Account',
      'Order ORD-1001',
      'Orders',
    ]);
    // Every node is a FlowNode: an id, a route, a url, a stateKey.
    for (const node of result.screens) {
      expect(node.id).toContain('mobile:');
      expect(isMobileScreenRoute(node.route)).toBe(true);
      expect(node.stateKey).toBeTruthy();
      expect(node.device.id).toBe(phone.id);
    }
    expect(frontierIsConsistent(result.frontier)).toBe(true);
    expect(result.frontier.atLeastMoreUrls).toBe(0);
    expect(mobileBudgetsFeedTheFrontier(result)).toBe(true);
  });

  it('records the tap edges and the per-screen controls', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    const tapEdges = result.edges.filter((edge) => edge.kind === 'TAP');
    expect(tapEdges.length).toBeGreaterThanOrEqual(2);
    for (const edge of tapEdges) {
      expect(edge.mobileSelector).not.toBeNull();
      expect(edge.controlIdentity).toBeTruthy();
      expect(describeMobileReplay(edge.replay)).toContain('launch com.acme.app');
    }
    const orders = result.screens.find((node) => node.title === 'Orders');
    expect(orders?.controls.map((control) => control.kind).sort()).toEqual([
      'LIST_ROW',
      'TAB_BAR_ITEM',
      'TAB_BAR_ITEM',
    ]);
    expect(result.stats.controlsSeen).toBe(result.controls.length);
    // A control's affordance kind stays in the vocabulary FlowNode already stores.
    for (const control of result.controls) {
      expect(['link', 'button', 'input']).toContain(control.affordanceKind);
    }
  });

  it('measures the BACK edge with the mechanism that produced it', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    const back = result.edges.filter((edge) => edge.kind === 'BACK');
    expect(back.length).toBeGreaterThan(0);
    expect(back[0]?.backMechanism).toBe('HARDWARE_BUTTON');
    expect(back[0]?.from).not.toBe(back[0]?.to);
    expect(result.stats.backEdges).toBe(back.length);
  });

  it('reports back edges as NULL, not 0, when it cannot press back', async () => {
    /*
     * OPPOSITE FACTS. "We could not press back" and "no screen has a way back"
     * read identically as a zero, and only one of them is the customer's
     * problem.
     */
    const capabilities = MOBILE_ENUMERATION_CAPABILITIES.filter(
      (capability) => capability !== 'BACK',
    );
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp(), { capabilities }), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    expect(result.stats.backEdges).toBeNull();
    expect(result.edges.some((edge) => edge.kind === 'BACK')).toBe(false);
    expect(result.unavailable.map((gap) => gap.capability)).toContain('BACK');
    expect(result.unavailable.find((gap) => gap.capability === 'BACK')?.cost).toContain('UNKNOWN');
  });

  it('does not mint a second node when the live tab is re-tapped', async () => {
    const graph = threeScreenApp();
    graph.taps = { ...graph.taps, 'orders|a11y:tab-orders': 'orders' };
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(graph), { app, policy: policyWith(), primitives }),
    );
    expect(result.screens.length).toBe(3);
    expect(result.stats.noOpTaps).toBeGreaterThan(0);
  });

  it('counts the screens whose identity was only STRUCTURAL', async () => {
    const result = enumerated(
      await enumerateMobileScreens(
        fakeDevice({
          start: 's',
          screens: {
            s: screen({ activity: null, title: null, nodes: [view({ ref: 'a', text: 'Go' })] }),
          },
        }),
        { app, policy: policyWith(), primitives },
      ),
    );
    expect(result.stats.screensIdentifiedStructurally).toBe(1);
    expect(result.screens[0]?.signature.basis).toBe('STRUCTURAL');
  });
});

describe('the budgets, disclosed as a count and a reason', () => {
  function manyScreens(count: number): FakeApp {
    const screens: Record<string, RawScreen> = {};
    const taps: Record<string, string> = {};
    for (let index = 0; index < count; index += 1) {
      screens[`s${index}`] = screen({
        activity: `.Screen${index}`,
        nodes: [view({ ref: 'next', accessibilityId: `next-${index}` })],
      });
      taps[`s${index}|a11y:next-${index}`] = `s${(index + 1) % count}`;
    }
    return { start: 's0', screens, taps };
  }

  it('STOPS rather than CONVERGING when the screen budget bites', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(manyScreens(8)), {
        app,
        policy: policyWith(),
        primitives,
        maxScreens: 3,
      }),
    );
    expect(result.outcome).toBe('STOPPED');
    const bite = result.caps.find((cap) => cap.cap === 'PAGE_BUDGET');
    expect(bite).toBeDefined();
    expect(bite?.bites).toBeGreaterThan(0);
    expect(bite?.discarded).toBeGreaterThan(0);
    expect(bite?.reason).toContain('undriven');
    expect(result.frontier.atLeastMoreUrls).toBeGreaterThan(0);
    expect(result.why).toContain('more in-scope URL(s) were known and not visited');
  });

  it('discloses the depth limit against the shared cap vocabulary', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(manyScreens(8)), {
        app,
        policy: policyWith(),
        primitives,
        maxDepth: 1,
      }),
    );
    const bite = result.caps.find((cap) => cap.cap === 'DEPTH');
    expect(bite).toBeDefined();
    expect(CRAWL_CAPS).toContain(bite!.cap);
    expect(result.frontier.beyondDepth).toBeGreaterThan(0);
    expect(result.outcome).toBe('STOPPED');
  });

  it('discloses the per-screen tap budget with the count it left undriven', async () => {
    const nodes = Array.from({ length: 6 }, (_, index) =>
      view({ ref: `b${index}`, accessibilityId: `btn-${index}` }),
    );
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice({ start: 's', screens: { s: screen({ nodes }) } }), {
        app,
        policy: policyWith(),
        primitives,
        perScreenTapBudget: 2,
      }),
    );
    const bite = mobileBudgetsThatBit(result.budgets).find(
      (candidate) => candidate.budget === 'PER_SCREEN_INTERACTION',
    );
    expect(bite?.discarded).toBe(4);
    expect(bite?.unknownRemainder).toBe(false);
    expect(bite?.reason).toContain('undriven');
    expect(discardedByMobileBudgets(result.budgets)).toBeGreaterThanOrEqual(4);
    expect(mobileBudgetsFeedTheFrontier(result)).toBe(true);
    expect(result.outcome).toBe('STOPPED');
  });

  it('discloses a per-screen control cap and keeps the discarded count', async () => {
    const nodes = Array.from({ length: 5 }, (_, index) =>
      view({ ref: `b${index}`, accessibilityId: `btn-${index}` }),
    );
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice({ start: 's', screens: { s: screen({ nodes }) } }), {
        app,
        policy: policyWith(),
        primitives,
        controlsPerScreen: 2,
      }),
    );
    const bite = result.caps.find((cap) => cap.cap === 'AFFORDANCES_PER_PAGE');
    expect(bite?.discarded).toBe(3);
    expect(bite?.reason).toContain('discarded');
  });

  it('reports the scroll limit as an UNKNOWN remainder, never as a zero cost', async () => {
    /*
     * THE HARD HONESTY CASE. A scroll container does not publish its length, so
     * when the budget bites while the last swipe was still revealing controls
     * we know MORE exists and not HOW MANY. `discarded: 0` alone would read as
     * "the budget cost nothing"; the pair with `unknownRemainder` says the true
     * thing, and the promotion to a cap is what keeps CONVERGED off the report.
     */
    const screens: Record<string, RawScreen> = {};
    const swipes: Record<string, string> = {};
    for (let index = 0; index < 20; index += 1) {
      screens[`p${index}`] = screen({
        activity: '.FeedActivity',
        nodes: [
          view({
            ref: 'feed',
            resourceId: 'id/feed',
            className: 'androidx.recyclerview.widget.RecyclerView',
            scrollable: true,
            clickable: false,
          }),
          view({ ref: `row${index}`, accessibilityId: `row-${index}`, container: 'list' }),
        ],
      });
      swipes[`p${index}`] = `p${index + 1}`;
    }
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice({ start: 'p0', screens, swipes }), {
        app,
        policy: policyWith(),
        primitives,
        scrollRevealBudget: 3,
        perScreenTapBudget: 0,
      }),
    );
    const bite = mobileBudgetsThatBit(result.budgets).find(
      (candidate) => candidate.budget === 'SCROLL_REVEAL',
    );
    expect(bite).toBeDefined();
    expect(bite?.discarded).toBe(0);
    expect(bite?.unknownRemainder).toBe(true);
    expect(bite?.reason).toContain('UNKNOWN');
    expect(result.stats.containersNotScrolledToEnd).toBe(1);
    expect(result.outcome).not.toBe('CONVERGED');
    expect(mobileBudgetsFeedTheFrontier(result)).toBe(true);
  });

  it('refuses to say CONVERGED when the ONLY thing that bit was the scroll limit', async () => {
    /*
     * THE CASE THE PROMOTION EXISTS FOR, and it is the one a report would get
     * wrong on its own. A `MobileBudgetBite` with an UNKNOWN remainder cannot
     * contribute a number to the frontier, so the frontier stays empty — and
     * `enumerationOutcome` reads an empty frontier with no cap as CONVERGED.
     * A feed whose container never reached its end would then be reported as
     * "every discovered screen was visited": convergence over a surface we
     * trimmed, which is the single sentence `enumerationOutcome` exists to
     * prevent. Promoting the bite to a cap is what stops it.
     *
     * Nothing else bites here on purpose: three rows, a per-screen budget of
     * twelve, and no tap that leads anywhere.
     */
    const screens: Record<string, RawScreen> = {};
    const swipes: Record<string, string> = {};
    for (let index = 0; index < 5; index += 1) {
      screens[`p${index}`] = screen({
        activity: '.FeedActivity',
        nodes: [
          view({
            ref: 'feed',
            resourceId: 'id/feed',
            className: 'androidx.recyclerview.widget.RecyclerView',
            scrollable: true,
            clickable: false,
          }),
          view({ ref: `row${index}`, accessibilityId: `row-${index}`, container: 'list' }),
        ],
      });
      swipes[`p${index}`] = `p${index + 1}`;
    }
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice({ start: 'p0', screens, swipes }), {
        app,
        policy: policyWith(),
        primitives,
        scrollRevealBudget: 2,
      }),
    );
    // The frontier has no number to offer, which is exactly the trap.
    expect(result.frontier.atLeastMoreUrls).toBe(0);
    expect(mobileBudgetsThatBit(result.budgets).map((bite) => bite.budget)).toEqual([
      'SCROLL_REVEAL',
    ]);
    expect(result.outcome).toBe('STOPPED');
    expect(result.caps.some((cap) => cap.reason.includes('UNKNOWN number of controls'))).toBe(true);
    expect(mobileBudgetsFeedTheFrontier(result)).toBe(true);
  });

  it('counts a container it could not scroll at all when SWIPE is missing', async () => {
    const capabilities = MOBILE_ENUMERATION_CAPABILITIES.filter(
      (capability) => capability !== 'SWIPE',
    );
    const result = enumerated(
      await enumerateMobileScreens(
        fakeDevice(
          {
            start: 's',
            screens: {
              s: screen({
                nodes: [
                  view({
                    ref: 'feed',
                    resourceId: 'id/feed',
                    className: 'android.widget.ScrollView',
                    scrollable: true,
                    clickable: false,
                  }),
                ],
              }),
            },
          },
          { capabilities },
        ),
        { app, policy: policyWith(), primitives },
      ),
    );
    expect(result.stats.containersNotScrolledToEnd).toBe(1);
    expect(result.unavailable.map((gap) => gap.capability)).toContain('SWIPE');
  });

  it('STOPS on the wall clock with the queue it discarded', async () => {
    let clock = 0;
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(manyScreens(8)), {
        app,
        policy: policyWith(),
        primitives,
        wallClockMillis: 5,
        now: () => {
          clock += 3;
          return clock;
        },
      }),
    );
    const bite = result.caps.find((cap) => cap.cap === 'WALL_CLOCK');
    expect(bite).toBeDefined();
    expect(bite?.reason).toContain('expired');
    expect(result.outcome).toBe('STOPPED');
  });
});

describe('the policy, reused and not forked', () => {
  function destructiveApp(): FakeApp {
    return {
      start: 's',
      screens: {
        s: screen({
          activity: '.SettingsActivity',
          nodes: [
            view({ ref: 'del', accessibilityId: 'Delete account' }),
            view({ ref: 'out', accessibilityId: 'Log out' }),
            view({ ref: 'pay', accessibilityId: 'Pay now' }),
            view({ ref: 'ok', accessibilityId: 'Edit profile' }),
          ],
        }),
      },
    };
  }

  it('REFUSES a destructive tap, names the rule, and keeps it in the inventory', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(destructiveApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    const refused = result.refusals.find((entry) => entry.label === 'Delete account');
    expect(refused?.exercise.state).toBe('REFUSED');
    expect(refused?.exercise.rule).toBe('allowDestructive: false');
    // Counted and named, so refusing it cannot raise the percentage.
    expect(exercisabilityCounts(refused?.exercise.state)).toBe(false);
    expect(parseSurfaceKey(refused!.surfaceItemKey)?.kind).toBe('COMPONENT_STATE');
    expect(result.controls.some((control) => control.label === 'Delete account')).toBe(true);
    // And it was never tapped.
    expect(result.edges.some((edge) => edge.action.includes('Delete account'))).toBe(false);
  });

  it('refuses a session-ending and a real-world tap with their own reasons', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(destructiveApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    const logout = result.refusals.find((entry) => entry.label === 'Log out');
    /*
     * UNEXERCISABLE / SESSION_ENDING, which is `refusalFor`'s verdict verbatim:
     * the mobile screen path is admitted by the default policy and
     * `allowDestructive` is off, so it falls to the harness-refusal branch.
     * The verdict is right and the SENTENCE that branch writes is wrong — it
     * says the control "has no path the crawl policy could be checked against"
     * when a path was given and checked. Recorded here as observed rather than
     * patched over, because rewriting another module's policy words is exactly
     * the fork that makes two policies disagree; the one-line fix is in this
     * module's report.
     */
    expect(logout?.exercise.state).toBe('UNEXERCISABLE');
    expect(logout?.exercise.reason).toBe('SESSION_ENDING');
    const pay = result.refusals.find((entry) => entry.label === 'Pay now');
    expect(pay?.exercise.state).toBe('UNEXERCISABLE');
    expect(pay?.exercise.reason).toBe('REAL_WORLD_SIDE_EFFECT');
  });

  it('offers the SCREEN PATH to the policy, so an excludeGlobs rule can name it', async () => {
    /*
     * WHAT THE PATH ARGUMENT IS FOR, and it is the only branch of `refusalFor`
     * that consults it. Without a path, a session-ending control can only ever
     * be the harness's own UNEXERCISABLE; with one, `policyDecision` runs and
     * the verdict becomes REFUSED with the customer's own rule beside it — a
     * line they wrote and can change, which is the whole difference between
     * "our harness would not" and "your policy said not to".
     *
     * This is also what makes the reserved route prefix load-bearing rather
     * than decorative: `/mobile/**` is a glob a human can write about a native
     * app, and it reaches the same policy engine the web crawl obeys.
     */
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(destructiveApp()), {
        app,
        policy: policyWith({ excludeGlobs: [`${MOBILE_ROUTE_PREFIX}/**`] }),
        primitives,
      }),
    );
    const logout = result.refusals.find((entry) => entry.label === 'Log out');
    expect(logout?.exercise.state).toBe('REFUSED');
    expect(logout?.exercise.rule).toBe(`excludeGlobs: ${MOBILE_ROUTE_PREFIX}/**`);
    expect(logout?.exercise.detail).toContain('crawl policy refuses it');
  });

  it('lets the customer opt in per screen path, which is what the prefix is for', async () => {
    const route = `${MOBILE_ROUTE_PREFIX}/android/com.acme.app/**`;
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(destructiveApp()), {
        app,
        policy: policyWith({ allowDestructive: true, destructiveAllowGlobs: [route] }),
        primitives,
      }),
    );
    expect(result.refusals.some((entry) => entry.label === 'Delete account')).toBe(false);
  });
});

describe('the states the crawl must handle rather than hang on', () => {
  it('records a permission dialog, never answers it, and says what is UNKNOWN', async () => {
    const graph: FakeApp = {
      start: 'camera',
      screens: {
        camera: screen({
          activity: '.CameraActivity',
          nodes: [view({ ref: 'shoot', accessibilityId: 'Take photo' })],
        }),
        permission: screen({
          activity: null,
          packageName: 'com.android.permissioncontroller',
          alertText: 'Allow Acme to take pictures?',
          nodes: [
            view({ ref: 'allow', accessibilityId: 'Allow' }),
            view({ ref: 'deny', accessibilityId: 'Deny' }),
          ],
        }),
      },
      taps: { 'camera|a11y:Take photo': 'permission' },
    };
    const device = fakeDevice(graph);
    const result = enumerated(
      await enumerateMobileScreens(device, { app, policy: policyWith(), primitives }),
    );
    const dialog = result.screens.find((node) => node.signature.class === 'OS_PERMISSION');
    expect(dialog).toBeDefined();
    expect(dialog?.expanded).toBe(false);
    expect(dialog?.expandedWhy).toContain('UNKNOWN rather than absent');
    expect(result.edges.some((edge) => edge.kind === 'OS_DIALOG')).toBe(true);
    expect(result.stats.osStatesMet).toBe(1);
    /*
     * NEITHER BUTTON IS TAPPED. "Allow" grants a permission nobody asked us to
     * grant and "Deny" changes the app's behaviour until somebody resets it;
     * both are side effects on the customer's device, and the crawl's job is to
     * report the dialog, not to answer it.
     */
    expect(device.calls.some((call) => call.includes('a11y:Allow'))).toBe(false);
    expect(device.calls.some((call) => call.includes('a11y:Deny'))).toBe(false);
  });

  it('treats another app as a boundary, records the id only, and relaunches', async () => {
    const graph: FakeApp = {
      start: 'share',
      screens: {
        share: screen({
          activity: '.ShareActivity',
          nodes: [view({ ref: 'open', accessibilityId: 'Open in browser' })],
        }),
        browser: screen({
          activity: null,
          packageName: 'com.android.chrome',
          nodes: [view({ ref: 'url', accessibilityId: 'address bar' })],
        }),
      },
      taps: { 'share|a11y:Open in browser': 'browser' },
    };
    const device = fakeDevice(graph);
    const result = enumerated(
      await enumerateMobileScreens(device, { app, policy: policyWith(), primitives }),
    );
    expect(result.externals).toEqual([
      {
        appId: 'com.android.chrome',
        fromRoute: expect.stringContaining(MOBILE_ROUTE_PREFIX),
        occurrences: 1,
      },
    ]);
    expect(result.stats.appExits).toBe(1);
    expect(result.edges.some((edge) => edge.kind === 'APP_EXIT')).toBe(true);
    // The other app never became a node in our graph.
    expect(result.screens.some((node) => node.signature.class === 'OTHER_APP')).toBe(false);
    expect(device.calls.filter((call) => call === 'launch').length).toBeGreaterThan(1);
  });

  it('dismisses the keyboard and reads the screen underneath', async () => {
    const graph: FakeApp = {
      start: 'typing',
      screens: {
        typing: screen({
          activity: '.LoginActivity',
          keyboardShown: true,
          nodes: [
            view({ ref: 'email', className: 'android.widget.EditText', accessibilityId: 'email' }),
          ],
        }),
        settled: screen({
          activity: '.LoginActivity',
          nodes: [
            view({ ref: 'email', className: 'android.widget.EditText', accessibilityId: 'email' }),
            view({ ref: 'go', accessibilityId: 'Sign in' }),
          ],
        }),
      },
      rotations: { 'keyboard:typing': 'settled' },
    };
    const device = fakeDevice(graph);
    const result = enumerated(
      await enumerateMobileScreens(device, { app, policy: policyWith(), primitives }),
    );
    expect(device.calls).toContain('hideKeyboard');
    const field = result.fieldGroups[0]?.fields.find((candidate) => candidate.label === 'email');
    expect(field?.semantic).toBe('email');
    expect(field?.exercise).toBeNull();
  });

  it('holds a field out as UNEXERCISABLE when it cannot dismiss the keyboard', async () => {
    const capabilities = MOBILE_ENUMERATION_CAPABILITIES.filter(
      (capability) => capability !== 'HIDE_KEYBOARD',
    );
    const result = enumerated(
      await enumerateMobileScreens(
        fakeDevice(
          {
            start: 's',
            screens: {
              s: screen({
                activity: '.LoginActivity',
                keyboardShown: true,
                nodes: [
                  view({
                    ref: 'email',
                    className: 'android.widget.EditText',
                    accessibilityId: 'email',
                  }),
                ],
              }),
            },
          },
          { capabilities },
        ),
        { app, policy: policyWith(), primitives },
      ),
    );
    const field = result.fieldGroups[0]?.fields[0];
    expect(field?.exercise?.state).toBe('UNEXERCISABLE');
    expect(field?.exercise?.reason).toBe('CAPABILITY_UNAVAILABLE');
    // The field is still INVENTORY: it exists, and we could not type into it.
    expect(exercisabilityCounts(field?.exercise?.state)).toBe(false);
  });
});

describe('the orientation probe', () => {
  it('proves identity survived a rotation', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    expect(result.orientationProbe.ran).toBe(true);
    expect(result.orientationProbe.stable).toBe(true);
  });

  it('reports stable as NULL, never true, when it cannot rotate', async () => {
    const capabilities = MOBILE_ENUMERATION_CAPABILITIES.filter(
      (capability) => capability !== 'ORIENTATION',
    );
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp(), { capabilities }), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    expect(result.orientationProbe.ran).toBe(false);
    expect(result.orientationProbe.stable).toBeNull();
    expect(result.orientationProbe.why).toContain('UNPROVEN');
  });

  it('reports a real divergence as a defect, with both signatures', async () => {
    const graph = threeScreenApp();
    graph.rotations = { orders: 'detail' };
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(graph), { app, policy: policyWith(), primitives }),
    );
    expect(result.orientationProbe.stable).toBe(false);
    expect(result.orientationProbe.before).not.toBe(result.orientationProbe.after);
    expect(result.orientationProbe.why).toContain('counted twice per orientation');
  });
});

// ─── The two doors into the reconciled denominator ──────────────────────────

describe('mobileScreenSurfaceItems', () => {
  it('emits one keyed item per screen, under the reserved prefix', async () => {
    const result = await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
      app,
      policy: policyWith(),
      primitives,
    });
    const items = mobileScreenSurfaceItems(result, { environmentId: 'env-1' });
    /*
     * TWO ROUTES FROM THREE SCREENS, and the collapse is the thing under test.
     * Orders and Account are two states of one Android activity, exactly as two
     * states of one URL are one route in the web FlowMap — so the ROUTE axis
     * holds one of them and `meta.stateCount` names how many there were. A
     * route counted once while holding two screens is a smaller denominator
     * than the application has, and the number has to be visible rather than
     * inferred.
     */
    expect(items.length).toBe(2);
    const shell = items.find((item) => item.meta?.stateCount === 2);
    expect(shell).toBeDefined();
    expect((shell?.meta?.states as string[]).length).toBe(2);
    for (const item of items) {
      expect(item.kind).toBe('ROUTE');
      expect(parseSurfaceKey(item.key)?.kind).toBe('ROUTE');
      expect(isMobileScreenRoute(parseSurfaceKey(item.key)!.identity)).toBe(true);
      expect(item.origin).toBe('CRAWL_ONLY');
      expect(item.sources).toEqual(['CRAWL']);
      expect(item.environmentId).toBe('env-1');
      expect(item.evidence).toBeTruthy();
      expect(item.detector).toBe('mobile-crawler');
      expect(item.meta?.mobile).toBe(true);
      expect(item.exercise?.state).toBe('EXERCISABLE');
    }
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it('keeps an unexpanded screen as inventory and out of the denominator', async () => {
    const graph: FakeApp = {
      start: 'camera',
      screens: {
        camera: screen({ nodes: [view({ ref: 'shoot', accessibilityId: 'Take photo' })] }),
        permission: screen({
          activity: null,
          packageName: 'com.android.permissioncontroller',
          alertText: 'Allow?',
          nodes: [view({ ref: 'allow', accessibilityId: 'Allow' })],
        }),
      },
      taps: { 'camera|a11y:Take photo': 'permission' },
    };
    const result = await enumerateMobileScreens(fakeDevice(graph), {
      app,
      policy: policyWith(),
      primitives,
    });
    const items = mobileScreenSurfaceItems(result, { environmentId: 'env-1' });
    const dialog = items.find((item) => item.meta?.screenClass === 'OS_PERMISSION');
    expect(dialog).toBeDefined();
    expect(dialog?.exercise?.state).toBe('UNEXERCISABLE');
    expect(exercisabilityCounts(dialog?.exercise?.state)).toBe(false);
    // And it can be left out on purpose, which is a different decision.
    const trimmed = mobileScreenSurfaceItems(result, {
      environmentId: 'env-1',
      includeUnexpanded: false,
    });
    expect(trimmed.some((item) => item.meta?.screenClass === 'OS_PERMISSION')).toBe(false);
    expect(trimmed.length).toBe(items.length - 1);
  });
});

describe('mobileReconcileSource', () => {
  it('reports LOADED with one entry per screen and every cap that bit', async () => {
    const result = await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
      app,
      policy: policyWith(),
      primitives,
      maxScreens: 2,
    });
    const source = mobileReconcileSource(result, 'env-1');
    expect(source.source).toBe('CRAWL');
    expect(source.participation).toBe('LOADED');
    expect(source.environmentId).toBe('env-1');
    expect(source.entries.length).toBeGreaterThan(0);
    for (const entry of source.entries) {
      expect(isMobileScreenRoute(entry.spelling)).toBe(true);
      // The ROUTE axis takes no verb, and guessing one would invent a fact.
      expect(entry.method).toBeNull();
    }
    expect(source.caps?.length).toBeGreaterThan(0);
    for (const cap of source.caps ?? []) {
      expect(cap.source).toBe('CRAWL');
      expect(cap.reason).toBeTruthy();
    }
  });

  it('carries the UNKNOWN remainder into the reconciliation sentence', async () => {
    const screens: Record<string, RawScreen> = {};
    const swipes: Record<string, string> = {};
    for (let index = 0; index < 10; index += 1) {
      screens[`p${index}`] = screen({
        activity: '.FeedActivity',
        nodes: [
          view({
            ref: 'feed',
            resourceId: 'id/feed',
            className: 'android.widget.ScrollView',
            scrollable: true,
            clickable: false,
          }),
          view({ ref: `row${index}`, accessibilityId: `row-${index}`, container: 'list' }),
        ],
      });
      swipes[`p${index}`] = `p${index + 1}`;
    }
    const result = await enumerateMobileScreens(fakeDevice({ start: 'p0', screens, swipes }), {
      app,
      policy: policyWith(),
      primitives,
      scrollRevealBudget: 2,
      perScreenTapBudget: 0,
    });
    const source = mobileReconcileSource(result, 'env-1');
    const cap = source.caps?.find((candidate) => candidate.cap === 'SCROLL_REVEAL');
    expect(cap?.discarded).toBe(0);
    expect(cap?.reason).toContain('UNKNOWN, not zero');
  });
});

// ─── The consequences this module states rather than hides ──────────────────

describe('the integration facts a reader needs', () => {
  it('is REFUSED generation by the shared predicate, which is why there is a local one', async () => {
    /*
     * A native screen has NO HTTP STATUS, `NODE_STATUS_CLASSES` has no
     * not-applicable member, and `shouldGenerateAgainst` returns false for a
     * null status. So the shared predicate refuses every mobile screen. That is
     * asserted here rather than left to be discovered, because the alternative
     * — writing a synthetic 200 — would be a status we invented.
     */
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    for (const node of result.screens) {
      expect(node.status).toBeNull();
      expect(shouldGenerateAgainst(node)).toBe(false);
      expect(mobileScreenIsGeneratable(node)).toBe(true);
    }
  });

  it('never claims behindAuth or a11y as a measurement', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp()), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    for (const node of result.screens) {
      // The required boolean carries the only writable value…
      expect(node.behindAuth).toBe(false);
      // …and the honest field says the question was not asked.
      expect(node.behindAuthMeasured).toBeNull();
      expect(node.requiresRoles).toEqual([]);
    }
  });

  it('refuses generation against a screen whose replay did not reproduce it', () => {
    const base = enumeratedStub();
    expect(
      mobileScreenIsGeneratable({ ...base, replay: { ...base.replay, verified: false } }),
    ).toBe(false);
    expect(mobileScreenIsGeneratable({ ...base, expanded: false })).toBe(false);
    expect(
      mobileScreenIsGeneratable({
        ...base,
        signature: { ...base.signature, class: 'OS_PERMISSION' },
      }),
    ).toBe(false);
  });

  it('attributes a screen to the device it was read on', async () => {
    const result = enumerated(
      await enumerateMobileScreens(fakeDevice(threeScreenApp(), { devices: [tablet, phone] }), {
        app,
        policy: policyWith(),
        primitives,
      }),
    );
    expect(result.device.id).toBe(tablet.id);
    for (const node of result.screens) expect(node.device.formFactor).toBe('TABLET');
    const items = mobileScreenSurfaceItems(result, { environmentId: 'env-1' });
    expect(items[0]?.meta?.formFactor).toBe('TABLET');
  });
});

function enumeratedStub() {
  const signature = screenSignatureOf(screen({ activity: '.MainActivity' }), app);
  return {
    id: 'mobile:x',
    route: signature.route,
    url: signature.url,
    title: 'Main',
    stateKey: signature.digest,
    requiresRoles: [] as string[],
    behindAuth: false,
    forms: [],
    affordances: [],
    screenshotKey: null,
    a11yViolationCount: 0,
    status: null,
    signature,
    replay: {
      steps: [{ kind: 'LAUNCH' as const, target: app.appId, label: 'launch', selector: null }],
      verified: true,
      divergedTo: null,
      strategy: 'RESET' as const,
    },
    interactionDepth: 0,
    parentScreenId: null,
    device: phone,
    controls: [],
    fields: null,
    expanded: true,
    expandedWhy: null,
    behindAuthMeasured: null,
  };
}

// ─── The one thin adapter ────────────────────────────────────────────────────

describe('appiumMobileDevice', () => {
  function transportFor(responses: Record<string, { status: number; body: unknown }>): {
    transport: MobileHttpTransport;
    calls: string[];
  } {
    const calls: string[] = [];
    const transport: MobileHttpTransport = async (request) => {
      calls.push(`${request.method} ${request.path}`);
      return responses[request.path] ?? { status: 200, body: { value: null } };
    };
    return { transport, calls };
  }

  it('reads a screen out of the protocol and the recorded hierarchy', async () => {
    const { transport, calls } = transportFor({
      '/source': { status: 200, body: { value: ANDROID_DUMP } },
      '/appium/device/current_activity': { status: 200, body: { value: '.OrdersActivity' } },
      '/appium/device/current_package': { status: 200, body: { value: 'com.acme.app' } },
      '/appium/device/is_keyboard_shown': { status: 200, body: { value: false } },
      '/orientation': { status: 200, body: { value: 'PORTRAIT' } },
    });
    const device = appiumMobileDevice({ transport, app, devices: [phone] });
    const raw = await device.screen();
    expect(raw.activity).toBe('.OrdersActivity');
    expect(raw.packageName).toBe('com.acme.app');
    expect(raw.orientation).toBe('PORTRAIT');
    expect(raw.nodes.length).toBe(12);
    expect(raw.title).toBe('Orders & returns');
    expect(calls).toContain('GET /source');
    expect(device.capabilities()).toEqual(APPIUM_CAPABILITIES);
  });

  it('reports no package rather than substituting our own', async () => {
    /*
     * iOS has no `current_package` and the call 404s. Substituting the app's own
     * bundle id would make the OTHER_APP check always pass, so the app boundary
     * — the thing that keeps somebody else's screens out of our denominator —
     * would be unmeasurable and silently so.
     */
    const { transport } = transportFor({
      '/source': { status: 200, body: { value: IOS_DUMP } },
      '/appium/device/current_package': {
        status: 404,
        body: { value: { message: 'not implemented' } },
      },
    });
    const device = appiumMobileDevice({
      transport,
      app: { platform: 'IOS', appId: 'com.acme.Acme' },
      devices: [phone],
    });
    const raw = await device.screen();
    expect(raw.packageName).toBeNull();
    expect(classifyScreen(raw, { platform: 'IOS', appId: 'com.acme.Acme' }).why).toContain(
      'could not be checked',
    );
  });

  it('resolves a ref before tapping, and reports a stale one as a failure', async () => {
    const { transport, calls } = transportFor({
      '/element': {
        status: 200,
        body: { value: { 'element-6066-11e4-a52e-4f735466cecf': 'el-1' } },
      },
    });
    const device = appiumMobileDevice({ transport, app, devices: [phone] });
    expect(await device.tap('/hierarchy[1]/node[1]')).toEqual({ ok: true, error: null });
    expect(calls).toContain('POST /element');
    expect(calls).toContain('POST /element/el-1/click');

    const stale = appiumMobileDevice({
      transport: transportFor({ '/element': { status: 404, body: { value: null } } }).transport,
      app,
      devices: [phone],
    });
    const failed = await stale.tap('/nope');
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('not found');
  });

  it('never puts a typed value in a path, and clears before typing', async () => {
    const { transport, calls } = transportFor({
      '/element': {
        status: 200,
        body: { value: { 'element-6066-11e4-a52e-4f735466cecf': 'el-9' } },
      },
    });
    const device = appiumMobileDevice({ transport, app, devices: [phone] });
    await device.type('/hierarchy[1]', 'qaai-probe');
    expect(calls).toContain('POST /element/el-9/clear');
    expect(calls).toContain('POST /element/el-9/value');
    expect(calls.join(' ')).not.toContain('qaai-probe');
  });

  it('turns a protocol error into an outcome with the server message', async () => {
    const { transport } = transportFor({
      '/appium/device/activate_app': {
        status: 500,
        body: { value: { message: 'An unknown server-side error occurred' } },
      },
    });
    const device = appiumMobileDevice({ transport, app, devices: [phone] });
    const launched = await device.launch();
    expect(launched.ok).toBe(false);
    expect(launched.error).toContain('HTTP 500');
    expect(launched.error).toContain('unknown server-side error');
  });

  it('derives the back mechanism from the platform, per platform', async () => {
    const { transport } = transportFor({});
    expect((await appiumMobileDevice({ transport, app, devices: [phone] }).back()).mechanism).toBe(
      'HARDWARE_BUTTON',
    );
    const ios = appiumMobileDevice({
      transport,
      app: { platform: 'IOS', appId: 'com.acme.Acme' },
      devices: [phone],
    });
    expect((await ios.back()).mechanism).toBe('EDGE_GESTURE');
    for (const platform of MOBILE_PLATFORMS) expect(['ANDROID', 'IOS']).toContain(platform);
  });

  it('reports an empty device list honestly, which becomes UNAVAILABLE', async () => {
    const { transport } = transportFor({});
    const device = appiumMobileDevice({ transport, app, devices: [] });
    expect(await device.devices()).toEqual([]);
    const result = await enumerateMobileScreens(device, { app, policy: policyWith(), primitives });
    expect(result.status).toBe('UNAVAILABLE');
  });
});
