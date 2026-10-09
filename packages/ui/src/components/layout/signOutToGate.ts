import { isDesktopShell } from '@/lib/desktop';
import {
  desktopHostsGet,
  desktopHostsSet,
  getDesktopHostApiUrl,
} from '@/lib/desktopHosts';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';

// Shared sign-out to the gate (project-ide task 39). Two call sites, one
// sequence: the header sign-out button (AccountProfile) and the automatic
// TokenPanel-session-expiry path (useAccountQuota). The route is the
// existing global sign-out (POST /api/auth/reset, which clears the session
// cookie) plus the existing desktop host storage drop for this device's
// client credential, then a reload into the gate's Sign-in screen. No auth
// semantics change: this only walks the established sign-out path.
//
// The automatic path fires at most once per browser session
// (module flag + sessionStorage marker): if the reset POST fails while the
// cookie stays valid, a reload must land on `unavailable`, never on a
// reload loop. A later successful quota read clears the mark (the session
// is healthy again, e.g. after a fresh login captured a new pair).

const AUTO_SIGNOUT_MARKER_KEY = 'oc_quota_signout_v1';

let autoSignOutFired = false;

const originOf = (raw: string | null | undefined): string => {
  if (!raw) return '';
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return '';
  }
};

// Drop the credential the current endpoint authenticates with, so the
// reload after sign-out cannot silently re-authenticate: the local
// desktop token for a local endpoint, or the matching remote host token.
const clearCurrentDesktopCredential = async (): Promise<void> => {
  const cfg = await desktopHostsGet().catch(() => null);
  if (!cfg) return;
  const apiBase = getRuntimeApiBaseUrl();
  if (cfg.localOrigin && originOf(cfg.localOrigin) !== '' && originOf(cfg.localOrigin) === originOf(apiBase)) {
    await desktopHostsSet({
      hosts: cfg.hosts,
      defaultHostId: cfg.defaultHostId,
      initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
      localClientToken: '',
    }).catch(() => undefined);
    return;
  }
  const target = originOf(apiBase);
  if (!target) return;
  let changed = false;
  const hosts = cfg.hosts.map((host) => {
    if (!host.clientToken || originOf(getDesktopHostApiUrl(host)) !== target) return host;
    changed = true;
    const next = { ...host };
    delete next.clientToken;
    return next;
  });
  if (!changed) return;
  await desktopHostsSet({
    hosts,
    defaultHostId: cfg.defaultHostId,
    initialHostChoiceCompleted: cfg.initialHostChoiceCompleted,
  }).catch(() => undefined);
};

const readAutoSignOutMark = (): boolean => {
  if (autoSignOutFired) return true;
  try {
    return window.sessionStorage.getItem(AUTO_SIGNOUT_MARKER_KEY) === '1';
  } catch {
    return false;
  }
};

const writeAutoSignOutMark = (): void => {
  autoSignOutFired = true;
  try {
    window.sessionStorage.setItem(AUTO_SIGNOUT_MARKER_KEY, '1');
  } catch {
    // Best-effort: the module flag above still guards this page.
  }
};

/** A successful authorized read proves the session healthy: re-arm. */
export const clearAutoSignOutMark = (): void => {
  autoSignOutFired = false;
  try {
    window.sessionStorage.removeItem(AUTO_SIGNOUT_MARKER_KEY);
  } catch {
    // Best-effort.
  }
};

/** The full sign-out sequence. Best-effort throughout: never throws. */
export const signOutToGate = async (): Promise<void> => {
  try {
    await runtimeFetch('/api/auth/reset', {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    }).catch(() => null);
  } catch {
    // The credential clear below still signs this device out of bearer
    // sessions; the reload lands on whatever the server answers with.
  }
  try {
    if (isDesktopShell()) await clearCurrentDesktopCredential();
  } catch {
    // Best-effort storage clear; the cookie reset above already ended the
    // cookie session, so the reload still lands on the Sign-in screen.
  }
  window.location.reload();
};

/** Automatic sign-out for an expired TokenPanel session. Fires once. */
export const signOutToGateOnce = async (): Promise<void> => {
  if (readAutoSignOutMark()) return;
  writeAutoSignOutMark();
  await signOutToGate();
};
