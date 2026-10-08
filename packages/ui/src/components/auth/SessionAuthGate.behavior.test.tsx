import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { AuthSessionState } from '@/lib/runtime-auth-expiry';

type ComponentFn<P extends Record<string, unknown> = Record<string, unknown>> = (props: P) => unknown;

type HookRecord = {
  values: unknown[];
  deps: Array<unknown[] | undefined>;
};

type HookEffect = () => void | (() => void);
type HookCallback = (...args: unknown[]) => unknown;
type JSXProps = Record<string, unknown> & { children?: unknown };
type JSXElementType<P extends Record<string, unknown> = Record<string, unknown>> = ComponentFn<P> | string | symbol;

const hookRecords = new Map<unknown, HookRecord>();
let currentRecord: HookRecord | null = null;
let hookIndex = 0;
let pendingEffects: Array<() => void> = [];
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, 'window');
  }
});

const resetHarness = () => {
  hookRecords.clear();
  currentRecord = null;
  hookIndex = 0;
  pendingEffects = [];
  runtimeApiBaseUrl = '';
  runtimeKey = 'local';
  runtimeEndpointChangedListener = null;
  desktopInvoke = async () => null;
  desktopInvokeCalls = 0;
  desktopConfigGoogle = false;
  desktopEmailLoginOk = false;
  desktopEmailLoginHold = false;
  desktopHostsGetCalls = 0;
  desktopHostsSetCalls = 0;
  runtimeSwitchCalls = 0;
  sessionStatusOk = false;
  homeReady = true;
  ensureHomeCalls = 0;
  homeResolutionHangs = false;
  finishHomeResolution = () => undefined;
  authSessionState = 'ok';
  markAuthenticatedCalls = 0;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      isSecureContext: false,
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
      setTimeout: (callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      },
      clearTimeout: () => undefined,
    },
  });
};

/** Timers the gate starts never fire, as when the test outruns them. */
const holdTimers = () => {
  Object.assign(window, { setTimeout: () => 0 });
};

const shallowEqualDeps = (left?: unknown[], right?: unknown[]): boolean => {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => Object.is(value, right[index]));
};

const getRecord = (component: unknown): HookRecord => {
  const existing = hookRecords.get(component);
  if (existing) return existing;
  const record: HookRecord = { values: [], deps: [] };
  hookRecords.set(component, record);
  return record;
};

const getHookRecord = (): HookRecord => {
  if (!currentRecord) {
    throw new Error('Hooks can only run during a render pass');
  }
  return currentRecord;
};

const renderComponent = <P extends Record<string, unknown>>(component: ComponentFn<P>, props: P): unknown => {
  const previousRecord = currentRecord;
  const previousHookIndex = hookIndex;
  currentRecord = getRecord(component);
  hookIndex = 0;

  try {
    return component(props);
  } finally {
    currentRecord = previousRecord;
    hookIndex = previousHookIndex;
  }
};

function useCallback<T extends HookCallback>(callback: T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = callback;
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useEffect(effect: HookEffect, deps?: unknown[]): void {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.deps[index] = deps;
    pendingEffects.push(() => {
      effect();
    });
  }
}

function useMemo<T>(factory: () => T, deps?: unknown[]): T {
  const record = getHookRecord();
  const index = hookIndex++;
  const previousDeps = record.deps[index];
  if (!shallowEqualDeps(previousDeps, deps)) {
    record.values[index] = factory();
    record.deps[index] = deps;
  }
  return record.values[index] as T;
}

function useRef<T>(initialValue: T): { current: T } {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = { current: initialValue };
  }
  return record.values[index] as { current: T };
}

function useState<T>(initialValue: T | (() => T)): readonly [T, (next: T | ((prev: T) => T)) => void] {
  const record = getHookRecord();
  const index = hookIndex++;
  if (record.values[index] === undefined) {
    record.values[index] = typeof initialValue === 'function'
      ? (initialValue as () => T)()
      : initialValue;
  }

  const setState = (next: T | ((prev: T) => T)) => {
    record.values[index] = typeof next === 'function'
      ? (next as (prev: T) => T)(record.values[index] as T)
      : next;
  };

  return [record.values[index] as T, setState] as const;
}

function jsx<P extends Record<string, unknown>>(type: JSXElementType<P>, props: JSXProps & P): unknown {
  if (type === reactJsxRuntime.Fragment) {
    return props.children ?? null;
  }

  if (typeof type === 'function') {
    return renderComponent(type, props as P);
  }

  return { type, props };
}

const ReactMock = {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
};

const reactJsxRuntime = {
  Fragment: Symbol('Fragment'),
  jsx,
  jsxs: jsx,
  jsxDEV: jsx,
};

let desktopShell = false;
let runtimeFetchRejects = true;
let sessionStatusOk = false;
let desktopConfigGoogle = false;
let desktopEmailLoginOk = false;
let desktopEmailLoginHold = false;
let finishEmailLogin: () => void = () => undefined;
let homeReady = true;
let ensureHomeCalls = 0;
let homeResolutionHangs = false;
let finishHomeResolution: () => void = () => undefined;
let runtimeApiBaseUrl = '';
let runtimeKey = 'local';
let runtimeEndpointChangedListener: (() => void) | null = null;
let desktopInvoke: () => Promise<unknown> = async () => null;
let desktopInvokeCalls = 0;
let desktopHostsGetCalls = 0;
let desktopHostsSetCalls = 0;
let runtimeSwitchCalls = 0;

mock.module('react/jsx-runtime', () => reactJsxRuntime);
mock.module('react/jsx-dev-runtime', () => reactJsxRuntime);

mock.module('react', () => ({
  __esModule: true,
  default: ReactMock,
  ...ReactMock,
}));

mock.module('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthn: mock(() => false),
}));

mock.module('@/components/ui/button', () => ({
  Button: (props: JSXProps) => ({ type: 'button-mock', props }),
}));

mock.module('@/components/ui/checkbox', () => ({
  Checkbox: () => null,
}));

mock.module('@/components/ui/input', () => ({
  Input: (props: JSXProps) => ({ type: 'input', props }),
}));

mock.module('@/components/ui', () => ({
  toast: {
    success: mock(() => undefined),
    error: mock(() => undefined),
    message: mock(() => undefined),
  },
}));

mock.module('@/components/ui/OpenChamberLogo', () => ({
  OpenChamberLogo: () => 'logo',
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: () => null,
}));

mock.module('@/components/desktop/DesktopHostSwitcher', () => ({
  DesktopHostSwitcherInline: () => 'host-switcher',
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/lib/desktop', () => ({
  invokeDesktop: () => {
    desktopInvokeCalls += 1;
    return desktopInvoke();
  },
  isDesktopShell: mock(() => desktopShell),
  isVSCodeRuntime: mock(() => false),
}));

mock.module('@/lib/persistence', () => ({
  initializeAppearancePreferences: mock(() => Promise.resolve()),
  syncDesktopSettings: mock(() => Promise.resolve()),
}));

mock.module('@/lib/directoryPersistence', () => ({
  applyPersistedDirectoryPreferences: mock(() => Promise.resolve()),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (url: string) => {
    if (runtimeFetchRejects) {
      throw new Error('offline');
    }
    if (url.includes('/api/auth/desktop/config')) {
      return new Response(JSON.stringify({ googleConfigured: desktopConfigGoogle }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/auth/desktop/email/login')) {
      if (desktopEmailLoginHold) {
        return new Promise<Response>((resolve) => {
          finishEmailLogin = () => resolve(new Response(
            JSON.stringify({ authenticated: true, clientToken: 'client-t' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ));
        });
      }
      return new Response(
        JSON.stringify(desktopEmailLoginOk ? { authenticated: true, clientToken: 'client-t' } : { error: 'invalid' }),
        { status: desktopEmailLoginOk ? 200 : 401, headers: { 'content-type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ authenticated: sessionStatusOk }), {
      status: sessionStatusOk ? 200 : 401,
      headers: { 'content-type': 'application/json' },
    });
  }),
}));

mock.module('@/stores/useDirectoryStore', () => ({
  ensureHomeDirectoryResolved: () => {
    ensureHomeCalls += 1;
    if (homeReady && !homeResolutionHangs) return Promise.resolve();
    return new Promise<void>((resolve) => {
      finishHomeResolution = () => {
        homeReady = true;
        resolve();
      };
    });
  },
  useDirectoryStore: { getState: () => ({ isHomeReady: homeReady }) },
}));

mock.module('@/lib/runtime-auth', () => ({
  getRuntimeExtraHeadersSync: mock(() => ({})),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => runtimeApiBaseUrl,
  getRuntimeKey: () => runtimeKey,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    runtimeEndpointChangedListener = listener;
    return () => {
      if (runtimeEndpointChangedListener === listener) runtimeEndpointChangedListener = null;
    };
  },
  switchRuntimeEndpoint: () => { runtimeSwitchCalls += 1; },
}));

mock.module('@/lib/desktopHosts', () => ({
  desktopHostsGet: () => {
    desktopHostsGetCalls += 1;
    return Promise.resolve(null);
  },
  desktopHostsSet: () => {
    desktopHostsSetCalls += 1;
    return Promise.resolve();
  },
  getDesktopHostApiUrl: mock(() => ''),
  normalizeHostUrl: mock(() => ''),
}));

mock.module('@/lib/passkeys', () => ({
  authenticateWithPasskey: mock(() => Promise.resolve(null)),
  cancelPasskeyCeremony: mock(() => undefined),
  defaultPasskeyStatus: { enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null },
  fetchPasskeyStatus: mock(() => Promise.resolve({ enabled: false, hasPasskeys: false, passkeyCount: 0, rpID: null })),
  isPasskeyCeremonyAbort: mock(() => false),
  registerCurrentDevicePasskey: mock(() => Promise.resolve(null)),
}));

let authSessionState: AuthSessionState = 'ok';
let markAuthenticatedCalls = 0;
const authSessionStore = {
  get state() {
    return authSessionState;
  },
  markAuthenticated: () => {
    markAuthenticatedCalls += 1;
    authSessionState = 'ok';
  },
};

mock.module('@/lib/runtime-auth-expiry', () => ({
  installAuthSessionFocusWatch: mock(() => undefined),
  useAuthSessionStore: Object.assign(
    (selector: (store: typeof authSessionStore) => unknown) => selector(authSessionStore),
    { getState: () => authSessionStore },
  ),
}));

const { SessionAuthGate } = await import('./SessionAuthGate');

const flushEffects = async () => {
  while (pendingEffects.length > 0) {
    const effects = pendingEffects;
    pendingEffects = [];
    for (const effect of effects) {
      effect();
    }
    await Promise.resolve();
  }
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
};

const renderGate = async () => {
  const firstPass = renderComponent(SessionAuthGate, { children: 'child' });
  await flushEffects();
  const secondPass = renderComponent(SessionAuthGate, { children: 'child' });
  await flushEffects();
  return secondPass ?? firstPass;
};

const collectText = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map((child) => collectText(child)).join(' ');
  if (typeof node === 'object') {
    const element = node as { props?: { children?: unknown } };
    return collectText(element.props?.children);
  }
  return '';
};

const findAllElements = (node: unknown, type: string, found: Array<{ type: string; props: JSXProps }> = []): Array<{ type: string; props: JSXProps }> => {
  if (Array.isArray(node)) {
    for (const child of node) findAllElements(child, type, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  const element = node as { type?: unknown; props?: JSXProps };
  if (element.type === type && element.props) found.push({ type, props: element.props });
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) findAllElements(child, type, found);
  } else {
    findAllElements(children, type, found);
  }
  return found;
};

const findElement = (node: unknown, type: string): { type: string; props: JSXProps } | null => {
  if (!node || typeof node !== 'object') return null;
  const element = node as { type?: unknown; props?: JSXProps };
  if (element.type === type && element.props) return { type, props: element.props };
  const children = element.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const match = findElement(child, type);
      if (match) return match;
    }
    return null;
  }
  return findElement(children, type);
};

describe('SessionAuthGate status-check failure behavior', () => {
  test('keeps non-desktop status-check rejection on the error screen', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.signin.title');
  });

  test('keeps desktop-shell status-check rejection on the error screen, never a guessed sign-in form', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = true;

    const tree = await renderGate();
    const text = collectText(tree);

    expect(text).toContain('sessionAuth.error.networkTitle');
    expect(text).not.toContain('sessionAuth.signin.title');
    // A network failure says nothing about the server, so the desktop error
    // screen keeps its real escape hatches: retry and the host switcher.
    expect(text).toContain('host-switcher');
  });

  test('a login that finds the session alive releases the expired state', async () => {
    // The user logged in from another tab, then pressed "Log in" on this tab's banner.
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;

    expect(collectText(await renderGate())).toContain('child');
    expect(markAuthenticatedCalls).toBe(0);

    authSessionState = 'reauthenticating';
    expect(collectText(await renderGate())).toContain('child');

    expect(markAuthenticatedCalls).toBe(1);
    expect(authSessionState).toBe('ok');
  });

  test('keeps the app unmounted until the home directory is known after login', async () => {
    // First visit to an auth-protected server: the page-load attempt could
    // not read the home directory, so it is still unknown at login.
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    homeReady = false;
    holdTimers();

    expect(collectText(await renderGate())).not.toContain('child');
    expect(ensureHomeCalls).toBe(1);

    finishHomeResolution();
    await flushEffects();
    expect(collectText(await renderGate())).toContain('child');
    expect(ensureHomeCalls).toBe(1);
  });

  test('a home resolution that never settles holds the app back only until the wait runs out', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    homeReady = false;
    homeResolutionHangs = true;

    await renderGate();
    // The harness fires timers at once, so the wait has already run out.
    await flushEffects();
    expect(collectText(renderComponent(SessionAuthGate, { children: 'child' }))).toContain('child');
    expect(ensureHomeCalls).toBe(1);
  });

  test('shows the app at once when the home directory is already known', async () => {
    resetHarness();
    desktopShell = false;
    runtimeFetchRejects = false;
    sessionStatusOk = true;
    // Even a resolution that never settles must not hold back a known home.
    homeResolutionHangs = true;

    expect(collectText(await renderGate())).toContain('child');
  });

  test('shows the email sign-in form with no token field', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    desktopConfigGoogle = false;
    sessionStatusOk = false;

    const text = collectText(await renderGate());
    expect(text).toContain('sessionAuth.signin.title');
    expect(text).toContain('sessionAuth.signin.continue');
    expect(text).not.toContain('sessionAuth.alcoreToken.placeholder');
  });

  test('shows the Google button when the server reports it, hidden otherwise', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    sessionStatusOk = false;

    desktopConfigGoogle = false;
    await renderGate();
    expect(collectText(await renderGate())).not.toContain('sessionAuth.signin.googleButton');

    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    sessionStatusOk = false;
    desktopConfigGoogle = true;
    await renderGate();
    expect(collectText(await renderGate())).toContain('sessionAuth.signin.googleButton');
  });

  test('starts the system-browser Google flow from the desktop button', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    sessionStatusOk = false;
    desktopConfigGoogle = true;
    desktopInvoke = async () => ({ requestId: 'r'.repeat(32) });

    await renderGate();
    const tree = await renderGate();
    const buttons = findAllElements(tree, 'button-mock');
    const google = buttons.find((button) => typeof button.props.onClick === 'function');
    expect(google).toBeTruthy();
    await (google?.props.onClick as () => Promise<void>)();
    await flushEffects();
    await flushEffects();
    expect(desktopInvokeCalls).toBe(1);
  });

  test('discards an email-login completion after switching to another host', async () => {
    resetHarness();
    desktopShell = true;
    runtimeFetchRejects = false;
    runtimeApiBaseUrl = 'https://host-a.example';
    runtimeKey = 'host:a';
    desktopEmailLoginHold = true;

    const lockedTree = await renderGate();
    const emailInput = findElement(lockedTree, 'input');
    expect(emailInput).not.toBeNull();
    (emailInput?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'a@example.test' } });

    const emailTree = await renderGate();
    const emailForm = findElement(emailTree, 'form');
    expect(emailForm).not.toBeNull();
    (emailForm?.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });

    const passwordTree = await renderGate();
    const passwordInput = findElement(passwordTree, 'input');
    expect(passwordInput).not.toBeNull();
    (passwordInput?.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 's3cret' } });

    const passwordView = await renderGate();
    const passwordForm = findElement(passwordView, 'form');
    expect(passwordForm).not.toBeNull();
    (passwordForm?.props.onSubmit as (event: { preventDefault: () => void }) => void)({ preventDefault: () => undefined });
    await Promise.resolve();

    runtimeApiBaseUrl = 'https://host-b.example';
    runtimeKey = 'host:b';
    runtimeEndpointChangedListener?.();
    finishEmailLogin();
    await flushEffects();
    await flushEffects();

    expect(desktopHostsGetCalls).toBe(0);
    expect(desktopHostsSetCalls).toBe(0);
    expect(runtimeSwitchCalls).toBe(0);
  });
});
