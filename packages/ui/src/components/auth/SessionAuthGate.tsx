import React from 'react';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { invokeDesktop, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { syncDesktopSettings, initializeAppearancePreferences } from '@/lib/persistence';
import { applyPersistedDirectoryPreferences } from '@/lib/directoryPersistence';
import { ensureHomeDirectoryResolved, useDirectoryStore } from '@/stores/useDirectoryStore';
import { DesktopHostSwitcherInline } from '@/components/desktop/DesktopHostSwitcher';
import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { installAuthSessionFocusWatch, useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { AuthExpiredBanner } from './AuthExpiredBanner';
import { getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { desktopHostsGet, desktopHostsSet, getDesktopHostApiUrl, normalizeHostUrl } from '@/lib/desktopHosts';
import { runtimeIdentityMatches, type GateState, type RuntimeIdentity } from './sessionAuthGateState';
import {
  authenticateWithPasskey,
  cancelPasskeyCeremony,
  defaultPasskeyStatus,
  fetchPasskeyStatus,
  isPasskeyCeremonyAbort,
  type PasskeyStatus,
  registerCurrentDevicePasskey,
} from '@/lib/passkeys';

const STATUS_CHECK_ENDPOINT = '/auth/session';
// How long the app stays hidden after login while the home directory resolves.
const HOME_RESOLUTION_WAIT_MS = 10_000;
// Transient-failure auto-retry for the initial session check. Over the relay the
// very first /auth/session can race the tunnel's initial WebSocket attempt (a
// failed attempt rejects requests queued on the channel even though the tunnel
// immediately reconnects), and on a lossy link the first request can simply drop.
// A single-shot check pins the gate on the error screen for a self-healing
// condition, so network errors and non-auth server errors (5xx during startup)
// retry a bounded number of times before surfacing the error UI. Definitive auth
// answers (200/401/429) are never retried.
const TRANSIENT_RETRY_MAX_ATTEMPTS = 4;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1_500;
const TRUST_DEVICE_STORAGE_KEY = 'openchamber.uiAuth.trustDevice';
const LOCAL_DESKTOP_CLIENT_KIND = 'desktop-local';
const LOCAL_DESKTOP_CLIENT_DEDUPE_KEY = 'desktop-local';

const readLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_LOCAL_ORIGIN__?: string }).__OPENCHAMBER_LOCAL_ORIGIN__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const sameOrigin = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeHostUrl(left);
  const normalizedRight = normalizeHostUrl(right);
  if (!normalizedLeft || !normalizedRight) return false;
  try {
    return new URL(normalizedLeft).origin === new URL(normalizedRight).origin;
  } catch {
    return false;
  }
};

const shouldIssueDesktopClientToken = (): boolean => {
  return isDesktopShell();
};

const isLoopbackHostname = (hostname: string): boolean => {
  const clean = hostname.replace(/^\[|\]$/g, '');
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
};

const isLocalDesktopRuntime = (): boolean => {
  if (!isDesktopShell()) return false;
  const localOrigin = readLocalOrigin();
  if (!localOrigin) return false;
  // An empty api base means same-origin requests against the page itself —
  // which on desktop IS the embedded local server. Requiring an exact origin
  // match here used to leave local client tokens untagged (no desktop-local
  // clientKind), and the server's client-create gate then 403'd them.
  const apiBaseUrl = getRuntimeApiBaseUrl();
  const effectiveTarget = apiBaseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
  if (sameOrigin(localOrigin, effectiveTarget)) return true;
  // Loopback aliases (localhost vs 127.0.0.1) still address this machine's
  // own server.
  try {
    const normalized = normalizeHostUrl(effectiveTarget);
    return Boolean(normalized && isLoopbackHostname(new URL(normalized).hostname));
  } catch {
    return false;
  }
};

const desktopClientAuthMetadata = (): { clientKind?: string; dedupeKey?: string } => {
  if (!isLocalDesktopRuntime()) return {};
  return {
    clientKind: LOCAL_DESKTOP_CLIENT_KIND,
    dedupeKey: LOCAL_DESKTOP_CLIENT_DEDUPE_KEY,
  };
};

const fetchSessionStatus = async (): Promise<Response> => {
  const response = await runtimeFetch(STATUS_CHECK_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  return response;
};

const readStoredTrustDevice = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }
  return window.localStorage.getItem(TRUST_DEVICE_STORAGE_KEY) === 'true';
};

const DESKTOP_AUTH_TIMEOUT_MS = 15_000;
const GOOGLE_POLL_INTERVAL_MS = 2_000;
const GOOGLE_POLL_MAX_ATTEMPTS = 150;

type SignInView = 'signin' | 'password' | 'register' | 'code';

type DesktopLoginResult = {
  authenticated?: unknown;
  clientToken?: unknown;
  retryAfter?: unknown;
  error?: unknown;
};

const postDesktopAuth = async (path: string, body: Record<string, unknown>): Promise<{ status: number; payload: DesktopLoginResult | null }> => {
  const response = await runtimeFetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as DesktopLoginResult | null;
  return { status: response.status, payload };
};

const issueDesktopClientToken = async (): Promise<string> => {
  if (!isDesktopShell()) {
    return '';
  }

  const response = await runtimeFetch('/api/client-auth/clients', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ label: 'OpenChamber Desktop', ...desktopClientAuthMetadata() }),
  }).catch(() => null);
  if (!response?.ok) {
    return '';
  }

  const payload = await response.json().catch(() => null) as { token?: unknown } | null;
  return typeof payload?.token === 'string' ? payload.token.trim() : '';
};

const startGoogleLoginViaShell = async (): Promise<string> => {
  if (!isDesktopShell() || typeof window === 'undefined') {
    return '';
  }
  const started = await invokeDesktop('desktop_start_google_login', {}).catch(() => null);
  if (!started || typeof started !== 'object') {
    return '';
  }
  const requestId = (started as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' ? requestId.trim() : '';
};

const captureRuntimeIdentity = (): RuntimeIdentity => ({
  apiBaseUrl: getRuntimeApiBaseUrl(),
  runtimeKey: getRuntimeKey(),
});

const isRuntimeIdentityActive = (identity: RuntimeIdentity): boolean => {
  return runtimeIdentityMatches(identity, captureRuntimeIdentity());
};

const persistDesktopClientToken = async (runtime: RuntimeIdentity, clientToken: string): Promise<boolean> => {
  if (!isDesktopShell() || !clientToken || !isRuntimeIdentityActive(runtime)) return false;
  const cfg = await desktopHostsGet().catch(() => null);
  if (!cfg || !isRuntimeIdentityActive(runtime)) return false;
  if (cfg.localOrigin && sameOrigin(cfg.localOrigin, runtime.apiBaseUrl)) {
    await desktopHostsSet({
      hosts: cfg.hosts,
      defaultHostId: cfg.defaultHostId,
      initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
      localClientToken: clientToken,
    }).catch(() => undefined);
    return isRuntimeIdentityActive(runtime);
  }
  let changed = false;
  const hosts = cfg.hosts.map((host) => {
    if (!sameOrigin(getDesktopHostApiUrl(host), runtime.apiBaseUrl)) {
      return host;
    }
    if (host.clientToken === clientToken) {
      return host;
    }
    changed = true;
    return { ...host, clientToken };
  });
  if (!changed) return true;
  if (!isRuntimeIdentityActive(runtime)) return false;
  await desktopHostsSet({
    hosts,
    defaultHostId: cfg.defaultHostId,
    initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
  }).catch(() => undefined);
  return isRuntimeIdentityActive(runtime);
};

const applyDesktopClientToken = async (
  clientToken: string,
  runtime: RuntimeIdentity,
  requestHeaders: Record<string, string>,
): Promise<boolean> => {
  if (!clientToken || !isRuntimeIdentityActive(runtime)) return false;
  if (!await persistDesktopClientToken(runtime, clientToken)) return false;
  if (!isRuntimeIdentityActive(runtime)) return false;
  switchRuntimeEndpoint({
    apiBaseUrl: runtime.apiBaseUrl,
    clientToken,
    requestHeaders: Object.keys(requestHeaders).length > 0 ? requestHeaders : null,
    runtimeKey: runtime.runtimeKey,
  });
  return true;
};

const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const titlebarDragStyle = React.useMemo<React.CSSProperties>(() => {
    return {
      height: 'var(--oc-wco-titlebar-height, 0px)',
      right: 'var(--oc-wco-right-inset, 0px)',
    };
  }, []);

  return (
    <div
      className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background text-foreground"
      style={{ fontFamily: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif' }}
    >
      <div className="app-region-drag fixed left-0 top-0 z-20" style={titlebarDragStyle} aria-hidden />
      <div
        className="pointer-events-none absolute inset-0 opacity-55"
        style={{
          background: 'radial-gradient(120% 140% at 50% -20%, var(--surface-overlay) 0%, transparent 68%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundColor: 'var(--surface-subtle)',
          opacity: 0.22,
        }}
      />
      <div className="app-region-no-drag relative z-10 flex w-full justify-center px-4 py-12 sm:px-6">
        {children}
      </div>
    </div>
  );
};

const LoadingScreen: React.FC = () => (
  <div className="flex min-h-dvh items-center justify-center bg-[var(--splash-background,var(--surface-background))] text-foreground">
    <OpenChamberLogo width={120} height={120} variant="splash" />
  </div>
);

const ErrorScreen: React.FC<ErrorScreenProps> = ({ onRetry, errorType = 'network', retryAfter, children }) => {
  const { t } = useI18n();
  const isRateLimit = errorType === 'rate-limit';
  const minutes = retryAfter ? Math.ceil(retryAfter / 60) : 1;

  return (
    <AuthShell>
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="typography-ui-header font-semibold text-destructive">
            {isRateLimit ? t('sessionAuth.error.rateLimitTitle') : t('sessionAuth.error.networkTitle')}
          </h1>
          <p className="typography-meta text-muted-foreground max-w-xs">
            {isRateLimit
              ? (minutes > 1
                ? t('sessionAuth.error.rateLimitDescriptionPlural', { minutes })
                : t('sessionAuth.error.rateLimitDescriptionSingle', { minutes }))
              : t('sessionAuth.error.networkDescription')}
          </p>
        </div>
        <Button type="button" onClick={onRetry} className="w-full max-w-xs">
          {t('sessionAuth.error.retry')}
        </Button>
        {children}
      </div>
    </AuthShell>
  );
};

interface SessionAuthGateProps {
  children: React.ReactNode;
}

interface ErrorScreenProps {
  onRetry: () => void;
  errorType?: 'network' | 'rate-limit';
  retryAfter?: number;
  children?: React.ReactNode;
}

export const SessionAuthGate: React.FC<SessionAuthGateProps> = ({
  children,
}) => {
  const { t } = useI18n();
  const vscodeRuntime = React.useMemo(() => isVSCodeRuntime(), []);
  const skipAuth = vscodeRuntime;
  const showHostSwitcher = React.useMemo(() => isDesktopShell() && !vscodeRuntime, [vscodeRuntime]);
  const [state, setState] = React.useState<GateState>(() => (skipAuth ? 'authenticated' : 'pending'));
  const [signInView, setSignInView] = React.useState<SignInView>('signin');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [otpCode, setOtpCode] = React.useState('');
  const [googleConfigured, setGoogleConfigured] = React.useState(false);
  const [isGoogleBusy, setIsGoogleBusy] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [retryAfter, setRetryAfter] = React.useState<number | undefined>(undefined);
  const [isTunnelLocked, setIsTunnelLocked] = React.useState(false);
  const [passkeyStatus, setPasskeyStatus] = React.useState<PasskeyStatus>(defaultPasskeyStatus);
  const [supportsPasskeys, setSupportsPasskeys] = React.useState(false);
  const [isPasskeyBusy, setIsPasskeyBusy] = React.useState(false);
  const [trustDevice, setTrustDevice] = React.useState<boolean>(() => readStoredTrustDevice());
  const [activePasskeyAction, setActivePasskeyAction] = React.useState<'auth' | 'register' | null>(null);
  const emailInputRef = React.useRef<HTMLInputElement | null>(null);
  const googlePollTimerRef = React.useRef<number | null>(null);
  const hasResyncedRef = React.useRef(skipAuth);
  const hasBootstrapResyncedRef = React.useRef(skipAuth);
  // Whether the home directory was resolved after authentication. Until then
  // the app stays unmounted when the home is unknown: on a first visit to a
  // auth-protected server the page-load attempt could only fall back to
  // "/", and the app would start working there.
  const [homeChecked, setHomeChecked] = React.useState(skipAuth);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(TRUST_DEVICE_STORAGE_KEY, trustDevice ? 'true' : 'false');
  }, [trustDevice]);

  const refreshPasskeyStatus = React.useCallback(async (runtime = captureRuntimeIdentity()) => {
    if (skipAuth) {
      return defaultPasskeyStatus;
    }

    try {
      const nextStatus = await fetchPasskeyStatus();
      if (isRuntimeIdentityActive(runtime)) {
        setPasskeyStatus(nextStatus);
      }
      return nextStatus;
    } catch {
      if (isRuntimeIdentityActive(runtime)) {
        setPasskeyStatus(defaultPasskeyStatus);
      }
      return defaultPasskeyStatus;
    }
  }, [skipAuth]);

  React.useEffect(() => {
    let cancelled = false;

    if (skipAuth) {
      return;
    }

    void (async () => {
      try {
        if (!window.isSecureContext || !browserSupportsWebAuthn()) {
          if (!cancelled) {
            setSupportsPasskeys(false);
          }
          return;
        }
        if (!cancelled) {
          setSupportsPasskeys(true);
        }
      } catch {
        if (!cancelled) {
          setSupportsPasskeys(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [skipAuth]);

  // Bounded retry scheduling for transient session-check failures. Lives in refs
  // so retries survive re-renders; the timer is cleared on unmount, endpoint
  // switch, and any definitive server answer.
  const transientRetryAttemptRef = React.useRef(0);
  const transientRetryTimerRef = React.useRef<number | null>(null);
  const checkStatusRef = React.useRef<(() => Promise<void>) | null>(null);

  const clearTransientRetry = React.useCallback(() => {
    if (transientRetryTimerRef.current !== null) {
      window.clearTimeout(transientRetryTimerRef.current);
      transientRetryTimerRef.current = null;
    }
  }, []);

  const resetTransientRetry = React.useCallback(() => {
    transientRetryAttemptRef.current = 0;
    clearTransientRetry();
  }, [clearTransientRetry]);

  // Returns true when another attempt was scheduled (caller keeps the pending
  // UI); false when the retry budget is exhausted (caller shows the error UI).
  const scheduleTransientRetry = React.useCallback((): boolean => {
    if (transientRetryAttemptRef.current >= TRANSIENT_RETRY_MAX_ATTEMPTS) return false;
    transientRetryAttemptRef.current += 1;
    clearTransientRetry();
    transientRetryTimerRef.current = window.setTimeout(() => {
      transientRetryTimerRef.current = null;
      void checkStatusRef.current?.();
    }, TRANSIENT_RETRY_BASE_DELAY_MS * transientRetryAttemptRef.current);
    return true;
  }, [clearTransientRetry]);

  React.useEffect(() => clearTransientRetry, [clearTransientRetry]);

  const checkStatus = React.useCallback(async () => {
    if (skipAuth) {
      setState('authenticated');
      return;
    }

    const runtime = captureRuntimeIdentity();
    setState((prev) => (prev === 'authenticated' ? prev : 'pending'));
    try {
      const [response, latestPasskeyStatus] = await Promise.all([
        fetchSessionStatus(),
        refreshPasskeyStatus(runtime),
      ]);
      const responseText = await response.text();

        if (!isRuntimeIdentityActive(runtime)) {
          return;
        }

        if (response.ok) {
          resetTransientRetry();
          // The gate may already be 'authenticated' (the user logged in from
          // another tab before pressing "Log in" here), so the state effect
          // below would not fire; this answer itself proves the session alive.
          if (useAuthSessionStore.getState().state !== 'ok') {
            useAuthSessionStore.getState().markAuthenticated();
          }
          setState('authenticated');
          setIsTunnelLocked(false);
          setErrorMessage('');
          setRetryAfter(undefined);
          return;
        }
        if (response.status === 401) {
          let data: { tunnelLocked?: boolean; debug?: { hasRefreshToken: boolean; message: string } } = {};
          try {
            data = JSON.parse(responseText);
          } catch {
            data = {};
          }
          resetTransientRetry();
          setIsTunnelLocked(data.tunnelLocked === true);
          setPasskeyStatus(latestPasskeyStatus);
          setState('locked');
          setRetryAfter(undefined);
          return;
        }
      if (response.status === 429) {
        let data: { retryAfter?: number } = {};
        try {
          data = JSON.parse(responseText);
        } catch {
          data = {};
        }
        resetTransientRetry();
        setRetryAfter(data.retryAfter);
        setIsTunnelLocked(false);
        setState('rate-limited');
        return;
      }
      // Non-auth server error (e.g. 502/503 while the backend is still coming
      // up) — transient; keep the pending UI and retry before surfacing.
      if (scheduleTransientRetry()) return;
      setState('error');
      setIsTunnelLocked(false);
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) {
        return;
      }
      console.warn('Failed to check session status:', error);
      // Network-level failure — over the relay this is typically the initial
      // tunnel attempt racing this request; it self-heals within seconds.
      // No server answer exists here (the request never reached the wire),
      // so this is never evidence of a lock; only a 401 above is.
      if (scheduleTransientRetry()) return;
      setState('error');
      setIsTunnelLocked(false);
    }
  }, [refreshPasskeyStatus, resetTransientRetry, scheduleTransientRetry, skipAuth]);

  React.useEffect(() => {
    checkStatusRef.current = checkStatus;
  }, [checkStatus]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }
    void checkStatus();
  }, [checkStatus, skipAuth]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }

    return subscribeRuntimeEndpointChanged(() => {
      cancelPasskeyCeremony();
      stopGooglePoll();
      setEmail('');
      setPassword('');
      setOtpCode('');
      setSignInView('signin');
      setErrorMessage('');
      setRetryAfter(undefined);
      setIsTunnelLocked(false);
      setIsSubmitting(false);
      setActivePasskeyAction(null);
      setIsPasskeyBusy(false);
      resetTransientRetry();
      setHomeChecked(false);
      setState('pending');
      void checkStatus();
    });
  }, [checkStatus, resetTransientRetry, skipAuth]);

  React.useEffect(() => {
    if (homeChecked || state !== 'authenticated') return;
    let cancelled = false;
    const settle = () => {
      if (!cancelled) setHomeChecked(true);
    };
    // The home read has no timeout of its own; a stalled one must not keep the
    // app hidden. Past the bound the app starts as it did before this wait.
    const timer = window.setTimeout(settle, HOME_RESOLUTION_WAIT_MS);
    void ensureHomeDirectoryResolved().finally(settle);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [homeChecked, state]);

  React.useEffect(() => {
    if (!skipAuth && state === 'locked') {
      hasResyncedRef.current = false;
    }
  }, [skipAuth, state]);

  // Mid-session expiry: the banner asks for a re-login by flipping the shared
  // auth store to 'reauthenticating'; the gate answers with its own status
  // check, which lands in the full 'locked' flow on a genuine 401. A
  // successful login resolves the store back to 'ok'.
  const authSessionState = useAuthSessionStore((store) => store.state);
  React.useEffect(() => {
    if (!skipAuth) installAuthSessionFocusWatch();
  }, [skipAuth]);
  React.useEffect(() => {
    if (skipAuth) return;
    if (authSessionState === 'reauthenticating') {
      void checkStatusRef.current?.();
    }
  }, [authSessionState, skipAuth]);
  React.useEffect(() => {
    if (skipAuth) return;
    if (state === 'authenticated' && useAuthSessionStore.getState().state !== 'ok') {
      useAuthSessionStore.getState().markAuthenticated();
    }
  }, [skipAuth, state]);

  React.useEffect(() => {
    if (state === 'locked' && signInView === 'signin' && emailInputRef.current) {
      emailInputRef.current.focus();
    }
  }, [state, signInView]);

  React.useEffect(() => {
    if (skipAuth) {
      return;
    }
    if (state === 'authenticated' && !hasResyncedRef.current) {
      hasResyncedRef.current = true;
      // First authentication of this page load is bootstrap: adopt the
      // persisted workspace pointers. A re-login after mid-session expiry is
      // not — this window already has its own workspace, and the shared
      // settings document may carry another window's pointers.
      const isBootstrapResync = !hasBootstrapResyncedRef.current;
      hasBootstrapResyncedRef.current = true;
      void (async () => {
        await initializeAppearancePreferences();
        await syncDesktopSettings({ bootstrap: isBootstrapResync });
        if (isBootstrapResync) {
          await applyPersistedDirectoryPreferences();
        }
      })();
    }
  }, [skipAuth, state]);

  const registerPasskeyForCurrentSession = React.useCallback(async () => {
    const runtime = captureRuntimeIdentity();
    setActivePasskeyAction('register');
    setIsPasskeyBusy(true);
    try {
      await registerCurrentDevicePasskey();
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setActivePasskeyAction(null);
        setIsPasskeyBusy(false);
      }
    }
    if (!isRuntimeIdentityActive(runtime)) return;
    await refreshPasskeyStatus(runtime);
  }, [refreshPasskeyStatus]);

  const cancelActivePasskey = React.useCallback(() => {
    cancelPasskeyCeremony();
    setActivePasskeyAction(null);
    setIsPasskeyBusy(false);
  }, []);

  const clearSignInSecrets = React.useCallback(() => {
    setPassword('');
    setOtpCode('');
  }, []);

  const enrollPasskeyAfterLoginRef = React.useRef(false);

  const stopGooglePoll = React.useCallback(() => {
    if (googlePollTimerRef.current !== null) {
      window.clearTimeout(googlePollTimerRef.current);
      googlePollTimerRef.current = null;
    }
    setIsGoogleBusy(false);
  }, []);

  React.useEffect(() => () => {
    if (googlePollTimerRef.current !== null) {
      window.clearTimeout(googlePollTimerRef.current);
      googlePollTimerRef.current = null;
    }
  }, []);

  const applyDesktopLoginResult = React.useCallback(async (
    payload: DesktopLoginResult | null,
    runtime: RuntimeIdentity,
    requestHeaders: Record<string, string>,
  ): Promise<boolean> => {
    if (!isRuntimeIdentityActive(runtime)) return false;
    let clientToken = shouldIssueDesktopClientToken()
      && typeof payload?.clientToken === 'string' && payload.clientToken.trim()
      ? payload.clientToken.trim()
      : '';
    if (shouldIssueDesktopClientToken() && !clientToken) {
      clientToken = await issueDesktopClientToken();
      if (!isRuntimeIdentityActive(runtime)) return false;
    }
    if (clientToken) {
      if (!await applyDesktopClientToken(clientToken, runtime, requestHeaders)) return false;
    }
    if (!isRuntimeIdentityActive(runtime)) return false;
    setIsTunnelLocked(false);
    clearSignInSecrets();
    enrollPasskeyAfterLoginRef.current = false;
    setState('authenticated');
    return true;
  }, [clearSignInSecrets]);

  const maybeEnrollPasskeyAfterLogin = React.useCallback(async (
    runtime: RuntimeIdentity,
  ): Promise<void> => {
    if (!enrollPasskeyAfterLoginRef.current || !supportsPasskeys) return;
    if (!isRuntimeIdentityActive(runtime)) return;
    try {
      await registerPasskeyForCurrentSession();
      if (!isRuntimeIdentityActive(runtime)) return;
      toast.success(t('sessionAuth.toast.passkeyAdded'));
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(t('sessionAuth.toast.passkeySetupCanceled'));
      } else {
        const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySetupFailed');
        toast.error(message);
      }
    }
  }, [registerPasskeyForCurrentSession, supportsPasskeys, t]);

  const sessionRequestFields = () => ({
    trustDevice,
    issueClientToken: shouldIssueDesktopClientToken(),
    clientLabel: 'OpenChamber Desktop',
    ...desktopClientAuthMetadata(),
  });

  const handleEmailLogin = React.useCallback(async () => {
    if (isTunnelLocked || isSubmitting) {
      return;
    }
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
    }

    const runtime = captureRuntimeIdentity();
    const requestHeaders = getRuntimeExtraHeadersSync();
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const { status, payload } = await postDesktopAuth('/api/auth/desktop/email/login', {
        email: cleanEmail,
        password,
        ...sessionRequestFields(),
      });
      if (!isRuntimeIdentityActive(runtime)) return;
      if (status === 200 && payload?.authenticated !== false) {
        if (!await applyDesktopLoginResult(payload, runtime, requestHeaders)) return;
        await maybeEnrollPasskeyAfterLogin(runtime);
        return;
      }
      if (status === 401) {
        setErrorMessage(t('sessionAuth.signin.error.invalidCredentials'));
        setState('locked');
        return;
      }
      if (status === 403) {
        setSignInView('code');
        setErrorMessage(t('sessionAuth.signin.error.emailNotVerified'));
        setState('locked');
        return;
      }
      if (status === 429) {
        const retryAfter = typeof payload?.retryAfter === 'number' ? payload.retryAfter : undefined;
        setRetryAfter(retryAfter);
        setState('rate-limited');
        return;
      }
      if (status === 503) {
        setErrorMessage(t('sessionAuth.signin.error.unavailable'));
        setState('locked');
        return;
      }
      setErrorMessage(t('sessionAuth.error.unexpectedResponse'));
      setState('locked');
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) return;
      console.warn('Failed to sign in with email:', error);
      setErrorMessage(t('sessionAuth.error.networkRetry'));
      setState('error');
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setIsSubmitting(false);
      }
    }
  }, [applyDesktopLoginResult, cancelActivePasskey, email, isPasskeyBusy, isSubmitting, isTunnelLocked, maybeEnrollPasskeyAfterLogin, password, t, trustDevice]);

  const handleEmailRegister = React.useCallback(async () => {
    if (isTunnelLocked || isSubmitting) {
      return;
    }
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      return;
    }

    const runtime = captureRuntimeIdentity();
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const { status } = await postDesktopAuth('/api/auth/desktop/email/register', {
        email: cleanEmail,
        password,
      });
      if (!isRuntimeIdentityActive(runtime)) return;
      if (status === 202) {
        setSignInView('code');
        setErrorMessage('');
        setState('locked');
        return;
      }
      if (status === 409) {
        setErrorMessage(t('sessionAuth.signin.error.accountExists'));
        setState('locked');
        return;
      }
      if (status === 429) {
        setRetryAfter(undefined);
        setState('rate-limited');
        return;
      }
      setErrorMessage(t('sessionAuth.error.unexpectedResponse'));
      setState('locked');
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) return;
      console.warn('Failed to create account:', error);
      setErrorMessage(t('sessionAuth.error.networkRetry'));
      setState('error');
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setIsSubmitting(false);
      }
    }
  }, [email, isSubmitting, isTunnelLocked, password, t]);

  const handleVerifyOtp = React.useCallback(async () => {
    if (isTunnelLocked || isSubmitting) {
      return;
    }
    const cleanEmail = email.trim();
    const cleanCode = otpCode.trim();
    if (!cleanEmail || !cleanCode) {
      return;
    }

    const runtime = captureRuntimeIdentity();
    const requestHeaders = getRuntimeExtraHeadersSync();
    setIsSubmitting(true);
    setErrorMessage('');

    try {
      const { status, payload } = await postDesktopAuth('/api/auth/desktop/email/verify-otp', {
        email: cleanEmail,
        code: cleanCode,
        ...sessionRequestFields(),
      });
      if (!isRuntimeIdentityActive(runtime)) return;
      if (status === 200 && payload?.authenticated !== false) {
        if (!await applyDesktopLoginResult(payload, runtime, requestHeaders)) return;
        await maybeEnrollPasskeyAfterLogin(runtime);
        return;
      }
      if (status === 400) {
        setErrorMessage(t('sessionAuth.signin.error.invalidCode'));
        setState('locked');
        return;
      }
      if (status === 429) {
        const retryAfter = typeof payload?.retryAfter === 'number' ? payload.retryAfter : undefined;
        setRetryAfter(retryAfter);
        setState('rate-limited');
        return;
      }
      if (status === 503) {
        setErrorMessage(t('sessionAuth.signin.error.unavailable'));
        setState('locked');
        return;
      }
      setErrorMessage(t('sessionAuth.error.unexpectedResponse'));
      setState('locked');
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) return;
      console.warn('Failed to verify code:', error);
      setErrorMessage(t('sessionAuth.error.networkRetry'));
      setState('error');
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setIsSubmitting(false);
      }
    }
  }, [applyDesktopLoginResult, email, isSubmitting, isTunnelLocked, maybeEnrollPasskeyAfterLogin, otpCode, t, trustDevice]);

  const handleResendOtp = React.useCallback(async () => {
    if (isTunnelLocked || isSubmitting) {
      return;
    }
    const cleanEmail = email.trim();
    if (!cleanEmail) {
      return;
    }
    setIsSubmitting(true);
    try {
      await postDesktopAuth('/api/auth/desktop/email/otp-resend', { email: cleanEmail });
      toast.message(t('sessionAuth.signin.info.codeSent'));
    } catch (error) {
      console.warn('Failed to resend code:', error);
      setErrorMessage(t('sessionAuth.error.networkRetry'));
    } finally {
      setIsSubmitting(false);
    }
  }, [email, isSubmitting, isTunnelLocked, t]);

  const handleGoogleLogin = React.useCallback(async () => {
    if (isTunnelLocked || isSubmitting || isGoogleBusy) {
      return;
    }
    if (!isDesktopShell()) {
      setErrorMessage(t('sessionAuth.signin.error.googleUnavailable'));
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
    }

    const runtime = captureRuntimeIdentity();
    const requestHeaders = getRuntimeExtraHeadersSync();
    setIsGoogleBusy(true);
    setErrorMessage('');

    const requestId = await startGoogleLoginViaShell();
    if (!isRuntimeIdentityActive(runtime)) return;
    if (!requestId) {
      setIsGoogleBusy(false);
      setErrorMessage(t('sessionAuth.signin.error.googleFailed'));
      return;
    }

    let attempts = 0;
    const poll = async (): Promise<void> => {
      if (!isRuntimeIdentityActive(runtime)) return;
      attempts += 1;
      try {
        const { status, payload } = await postDesktopAuth('/api/auth/desktop/google-complete', {
          requestId,
          ...sessionRequestFields(),
        });
        if (!isRuntimeIdentityActive(runtime)) return;
        if (status === 200 && payload?.authenticated !== false) {
          stopGooglePoll();
          if (!await applyDesktopLoginResult(payload, runtime, requestHeaders)) return;
          await maybeEnrollPasskeyAfterLogin(runtime);
          return;
        }
        if (status === 404) {
          if (attempts < GOOGLE_POLL_MAX_ATTEMPTS && isRuntimeIdentityActive(runtime)) {
            googlePollTimerRef.current = window.setTimeout(() => { void poll(); }, GOOGLE_POLL_INTERVAL_MS);
            return;
          }
          stopGooglePoll();
          if (!isRuntimeIdentityActive(runtime)) return;
          setErrorMessage(t('sessionAuth.signin.error.googleExpired'));
          return;
        }
        stopGooglePoll();
        if (!isRuntimeIdentityActive(runtime)) return;
        if (status === 401 || status === 409) {
          setErrorMessage(t('sessionAuth.signin.error.googleFailed'));
        } else if (status === 429) {
          const retryAfter = typeof payload?.retryAfter === 'number' ? payload.retryAfter : undefined;
          setRetryAfter(retryAfter);
          setState('rate-limited');
        } else {
          setErrorMessage(t('sessionAuth.signin.error.unavailable'));
        }
      } catch (error) {
        if (!isRuntimeIdentityActive(runtime)) return;
        if (attempts < GOOGLE_POLL_MAX_ATTEMPTS && isRuntimeIdentityActive(runtime)) {
          googlePollTimerRef.current = window.setTimeout(() => { void poll(); }, GOOGLE_POLL_INTERVAL_MS);
          return;
        }
        console.warn('Google login did not complete:', error);
        stopGooglePoll();
        if (!isRuntimeIdentityActive(runtime)) return;
        setErrorMessage(t('sessionAuth.error.networkRetry'));
      }
    };
    googlePollTimerRef.current = window.setTimeout(() => { void poll(); }, GOOGLE_POLL_INTERVAL_MS);
  }, [applyDesktopLoginResult, cancelActivePasskey, isGoogleBusy, isPasskeyBusy, isSubmitting, isTunnelLocked, maybeEnrollPasskeyAfterLogin, stopGooglePoll, t, trustDevice]);

  const handleGoogleCancel = React.useCallback(() => {
    stopGooglePoll();
  }, [stopGooglePoll]);

  React.useEffect(() => {
    if (skipAuth || state !== 'locked') {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/auth/desktop/config', {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        const payload = await response.json().catch(() => null) as { googleConfigured?: unknown } | null;
        if (!cancelled) {
          setGoogleConfigured(payload?.googleConfigured === true);
        }
      } catch {
        if (!cancelled) {
          setGoogleConfigured(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skipAuth, state]);

  const handlePasskeySignIn = React.useCallback(async () => {
    if (isSubmitting || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    setIsPasskeyBusy(true);
    setActivePasskeyAction('auth');
    setErrorMessage('');
    const runtime = captureRuntimeIdentity();
    const requestHeaders = getRuntimeExtraHeadersSync();

    try {
      const payload = await authenticateWithPasskey(trustDevice, {
        issueClientToken: shouldIssueDesktopClientToken(),
        clientLabel: 'OpenChamber Desktop',
        ...desktopClientAuthMetadata(),
      }) as { clientToken?: unknown } | null;
      const clientToken = shouldIssueDesktopClientToken() && typeof payload?.clientToken === 'string' && payload.clientToken.trim()
        ? payload.clientToken.trim()
        : '';
      if (!isRuntimeIdentityActive(runtime)) return;
      if (clientToken) {
        if (!await applyDesktopClientToken(clientToken, runtime, requestHeaders)) return;
      }

      setState('authenticated');
    } catch (error) {
      if (!isRuntimeIdentityActive(runtime)) return;
      if (isPasskeyCeremonyAbort(error)) {
        setErrorMessage('');
      } else {
        const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySignInCanceled');
        setErrorMessage(message);
      }
    } finally {
      if (isRuntimeIdentityActive(runtime)) {
        setActivePasskeyAction(null);
        setIsPasskeyBusy(false);
      }
    }
  }, [cancelActivePasskey, isPasskeyBusy, isSubmitting, supportsPasskeys, t, trustDevice]);

  const handlePasskeySetupOnly = React.useCallback(async () => {
    if (isSubmitting || isTunnelLocked || !supportsPasskeys) {
      return;
    }

    if (isPasskeyBusy) {
      cancelActivePasskey();
      return;
    }

    if (state !== 'authenticated') {
      enrollPasskeyAfterLoginRef.current = true;
      setSignInView('signin');
      setErrorMessage(t('sessionAuth.signin.info.signInFirstForPasskey'));
      return;
    }

    setErrorMessage('');
    try {
      await registerPasskeyForCurrentSession();
      toast.success(t('sessionAuth.toast.passkeyAdded'));
    } catch (error) {
      if (isPasskeyCeremonyAbort(error)) {
        toast.message(t('sessionAuth.toast.passkeySetupCanceled'));
        return;
      }
      const message = error instanceof Error ? error.message : t('sessionAuth.error.passkeySetupFailed');
      toast.error(message);
    }
  }, [cancelActivePasskey, isPasskeyBusy, isSubmitting, isTunnelLocked, registerPasskeyForCurrentSession, state, supportsPasskeys, t]);

  const canOfferPasskeySetup = supportsPasskeys && passkeyStatus.enabled;
  const canUsePasskey = canOfferPasskeySetup && passkeyStatus.hasPasskeys;

  if (state === 'pending') {
    return <LoadingScreen />;
  }

  if (state === 'error') {
    return (
      <ErrorScreen onRetry={() => { resetTransientRetry(); void checkStatus(); }} errorType="network">
        {showHostSwitcher && (
          <div className="w-full max-w-xs">
            <DesktopHostSwitcherInline />
            <p className="mt-1 text-center typography-micro text-muted-foreground">
              {t('sessionAuth.locked.hostSwitcherHint')}
            </p>
          </div>
        )}
      </ErrorScreen>
    );
  }

  if (state === 'rate-limited') {
    return <ErrorScreen onRetry={() => void checkStatus()} errorType="rate-limit" retryAfter={retryAfter} />;
  }

  if (state === 'locked') {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-6 w-full max-w-xs">
          <div className="flex flex-col items-center gap-1 text-center">
            <h1 className="text-xl font-semibold text-foreground">
              {isTunnelLocked ? t('sessionAuth.locked.tunnelTitle') : t('sessionAuth.signin.title')}
            </h1>
            <p className="typography-meta text-muted-foreground">
              {isTunnelLocked
                ? t('sessionAuth.locked.tunnelDescription')
                : t('sessionAuth.signin.description')}
            </p>
          </div>

          {!isTunnelLocked && signInView === 'signin' && (
            <div className="w-full space-y-2">
              {canUsePasskey && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void handlePasskeySignIn()}
                  disabled={isSubmitting || isGoogleBusy || (isPasskeyBusy && activePasskeyAction !== 'auth')}
                >
                  {isPasskeyBusy ? (
                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                  ) : (
                    <Icon name="lock-unlock" className="h-4 w-4" />
                  )}
                  <span>{isPasskeyBusy && activePasskeyAction === 'auth'
                    ? t('sessionAuth.actions.cancelPasskey')
                    : t('sessionAuth.actions.usePasskey')}</span>
                </Button>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (email.trim()) {
                    setSignInView('password');
                    setErrorMessage('');
                  }
                }}
                className="w-full space-y-2"
              >
                <Input
                  id="openchamber-signin-email"
                  ref={emailInputRef}
                  type="email"
                  autoComplete="email"
                  placeholder={t('sessionAuth.signin.emailPlaceholder')}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (errorMessage) {
                      setErrorMessage('');
                    }
                  }}
                  disabled={isSubmitting || isGoogleBusy}
                  aria-invalid={Boolean(errorMessage) || undefined}
                  aria-describedby={errorMessage ? 'oc-ui-auth-error' : undefined}
                />
                <Button
                  type="submit"
                  className="w-full"
                  disabled={!email.trim() || isSubmitting || isGoogleBusy}
                >
                  {t('sessionAuth.signin.continue')}
                </Button>
              </form>
              {googleConfigured && showHostSwitcher && (
                <>
                  <div className="flex items-center gap-3 py-1" aria-hidden>
                    <span className="h-px flex-1 bg-border" />
                    <span className="typography-micro text-muted-foreground">{t('sessionAuth.signin.or')}</span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => void handleGoogleLogin()}
                    disabled={isSubmitting || isGoogleBusy}
                  >
                    {isGoogleBusy ? (
                      <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                    ) : (
                      <Icon name="google-fill" className="h-4 w-4" />
                    )}
                    <span>{isGoogleBusy
                      ? t('sessionAuth.signin.googleWaiting')
                      : t('sessionAuth.signin.googleButton')}</span>
                  </Button>
                  {isGoogleBusy && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full text-muted-foreground hover:text-foreground"
                      onClick={handleGoogleCancel}
                    >
                      {t('sessionAuth.signin.cancel')}
                    </Button>
                  )}
                </>
              )}
              <label className="flex items-center justify-center gap-2 pt-1 text-center typography-micro text-muted-foreground">
                <Checkbox
                  checked={trustDevice}
                  onChange={setTrustDevice}
                  disabled={isSubmitting || isGoogleBusy}
                  ariaLabel={t('sessionAuth.actions.trustDeviceAria')}
                  className="size-4"
                  iconClassName="size-4"
                />
                <span>{t('sessionAuth.actions.trustDevice')}</span>
              </label>
              {canOfferPasskeySetup ? (
                <div className="flex items-center justify-center pt-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => void handlePasskeySetupOnly()}
                    disabled={isSubmitting || isGoogleBusy}
                  >
                    {isPasskeyBusy && activePasskeyAction === 'register'
                      ? t('sessionAuth.actions.cancelPasskeySetup')
                      : t('sessionAuth.actions.addPasskey')}
                  </Button>
                </div>
              ) : null}
              {errorMessage && (
                <p id="oc-ui-auth-error" className="typography-meta text-destructive">
                  {errorMessage}
                </p>
              )}
            </div>
          )}

          {!isTunnelLocked && signInView === 'password' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleEmailLogin();
              }}
              className="w-full space-y-2"
            >
              <p className="typography-meta text-muted-foreground truncate text-center">{email.trim()}</p>
              <Input
                id="openchamber-signin-password"
                type="password"
                autoComplete="current-password"
                placeholder={t('sessionAuth.signin.passwordPlaceholder')}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (errorMessage) {
                    setErrorMessage('');
                  }
                }}
                disabled={isSubmitting}
                aria-invalid={Boolean(errorMessage) || undefined}
                aria-describedby={errorMessage ? 'oc-ui-auth-error' : undefined}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={!password || isSubmitting}
              >
                {t('sessionAuth.signin.signIn')}
              </Button>
              <div className="flex items-center justify-between pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setSignInView('signin');
                    setErrorMessage('');
                  }}
                  disabled={isSubmitting}
                >
                  {t('sessionAuth.signin.back')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setSignInView('register');
                    setErrorMessage('');
                  }}
                  disabled={isSubmitting}
                >
                  {t('sessionAuth.signin.createAccount')}
                </Button>
              </div>
              {errorMessage && (
                <p id="oc-ui-auth-error" className="typography-meta text-destructive">
                  {errorMessage}
                </p>
              )}
            </form>
          )}

          {!isTunnelLocked && signInView === 'register' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleEmailRegister();
              }}
              className="w-full space-y-2"
            >
              <p className="typography-meta text-muted-foreground truncate text-center">{email.trim()}</p>
              <Input
                id="openchamber-signin-new-password"
                type="password"
                autoComplete="new-password"
                placeholder={t('sessionAuth.signin.passwordPlaceholder')}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  if (errorMessage) {
                    setErrorMessage('');
                  }
                }}
                disabled={isSubmitting}
                aria-invalid={Boolean(errorMessage) || undefined}
                aria-describedby={errorMessage ? 'oc-ui-auth-error' : undefined}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={!password || isSubmitting}
              >
                {t('sessionAuth.signin.createAccountButton')}
              </Button>
              <div className="flex items-center justify-between pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setSignInView('signin');
                    setErrorMessage('');
                  }}
                  disabled={isSubmitting}
                >
                  {t('sessionAuth.signin.back')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setSignInView('password');
                    setErrorMessage('');
                  }}
                  disabled={isSubmitting}
                >
                  {t('sessionAuth.signin.haveAccount')}
                </Button>
              </div>
              {errorMessage && (
                <p id="oc-ui-auth-error" className="typography-meta text-destructive">
                  {errorMessage}
                </p>
              )}
            </form>
          )}

          {!isTunnelLocked && signInView === 'code' && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void handleVerifyOtp();
              }}
              className="w-full space-y-2"
            >
              <p className="typography-meta text-muted-foreground text-center">
                {t('sessionAuth.signin.codeDescription', { email: email.trim() })}
              </p>
              <Input
                id="openchamber-signin-code"
                type="text"
                autoComplete="one-time-code"
                inputMode="numeric"
                placeholder={t('sessionAuth.signin.codePlaceholder')}
                value={otpCode}
                onChange={(event) => {
                  setOtpCode(event.target.value);
                  if (errorMessage) {
                    setErrorMessage('');
                  }
                }}
                disabled={isSubmitting}
                aria-invalid={Boolean(errorMessage) || undefined}
                aria-describedby={errorMessage ? 'oc-ui-auth-error' : undefined}
              />
              <Button
                type="submit"
                className="w-full"
                disabled={!otpCode.trim() || isSubmitting}
              >
                {t('sessionAuth.signin.verify')}
              </Button>
              <div className="flex items-center justify-between pt-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setSignInView('signin');
                    setErrorMessage('');
                  }}
                  disabled={isSubmitting}
                >
                  {t('sessionAuth.signin.back')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void handleResendOtp()}
                  disabled={isSubmitting}
                >
                  {t('sessionAuth.signin.resend')}
                </Button>
              </div>
              {errorMessage && (
                <p id="oc-ui-auth-error" className="typography-meta text-destructive">
                  {errorMessage}
                </p>
              )}
            </form>
          )}

          {showHostSwitcher && (
            <div className="w-full">
              <DesktopHostSwitcherInline />
              <p className="mt-1 text-center typography-micro text-muted-foreground">
                {t('sessionAuth.locked.hostSwitcherHint')}
              </p>
            </div>
          )}
        </div>
      </AuthShell>
    );
  }

  if (!homeChecked && !useDirectoryStore.getState().isHomeReady) {
    return <LoadingScreen />;
  }

  return (
    <>
      {skipAuth ? null : <AuthExpiredBanner />}
      {children}
    </>
  );
};
