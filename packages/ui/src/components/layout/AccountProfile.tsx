import React from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { signOutToGate } from './signOutToGate';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { toast } from '@/components/ui';
import { parseAccountSession, type AccountSession } from './accountSession';
import { quotaAvailableMajor, useAccountQuota } from './accountQuota';

// Header account surface (all runtimes except VS Code, where auth is
// skipped). Reads the existing desktop-auth session shape only:
// GET /auth/session decides signed-in vs signed-out, and a corrupt or
// expired answer renders the signed-out state — never a stuck loader.
// Sign out runs the shared signOutToGate sequence (the existing global
// sign-out route POST /api/auth/reset, which clears the session cookie,
// plus the existing desktop host storage drop for this device's client
// credential, then a reload into the gate's Sign-in screen). No auth
// semantics or token shapes change here.
//
// Surfaces: web and Electron desktop show the profile; hosted and
// Capacitor mobile inherit the same shared-UI behavior; VS Code hides it.

const AccountAvatar: React.FC<{ displayName: string; avatarUrl: string; initials: string; size: 'sm' | 'lg' }> = ({
  displayName,
  avatarUrl,
  initials,
  size,
}) => {
  const sizeClass = size === 'lg' ? 'size-10 typography-ui-label' : 'size-6 typography-micro';
  const iconClass = size === 'lg' ? 'size-5' : 'size-4';
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        aria-hidden
        className={`${sizeClass} shrink-0 rounded-full border border-border object-cover`}
      />
    );
  }
  const glyph = initials || displayName.slice(0, 1);
  return (
    <span
      aria-hidden
      className={`${sizeClass} flex shrink-0 items-center justify-center rounded-full border border-border bg-[var(--surface-elevated)] font-semibold text-foreground`}
    >
      {glyph ? glyph : <Icon name="user" className={iconClass} />}
    </span>
  );
};

export const AccountProfile: React.FC = () => {
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const [session, setSession] = React.useState<AccountSession | null>(null);
  const [signingOut, setSigningOut] = React.useState(false);
  const authState = useAuthSessionStore((store) => store.state);

  const refresh = React.useCallback(async () => {
    try {
      const response = await runtimeFetch('/auth/session', {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        setSession({ status: 'signed-out' });
        return;
      }
      const payload = await response.json().catch(() => null);
      setSession(parseAccountSession(payload));
    } catch {
      setSession({ status: 'signed-out' });
    }
  }, []);

  React.useEffect(() => {
    if (!isVSCode) void refresh();
  }, [isVSCode, refresh]);

  React.useEffect(() => {
    if (isVSCode) return;
    return subscribeRuntimeEndpointChanged(() => {
      setSession(null);
      void refresh();
    });
  }, [isVSCode, refresh]);

  React.useEffect(() => {
    if (!isVSCode && authState === 'ok') void refresh();
  }, [authState, isVSCode, refresh]);

  const handleSignIn = React.useCallback(() => {
    window.location.reload();
  }, []);

  const quotaSubject = session !== null && session.status === 'signed-in' ? session.subject : null;
  const quota = useAccountQuota(isVSCode ? null : quotaSubject);

  const handleSignOut = React.useCallback(async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await signOutToGate();
    } catch {
      toast.error(t('sessionAuth.error.networkRetry'));
    }
  }, [signingOut, t]);

  if (isVSCode) return null;

  if (session === null) {
    return (
      <div
        aria-hidden
        className="app-region-no-drag size-8 shrink-0 rounded-full bg-[var(--surface-elevated)] opacity-60"
      />
    );
  }

  if (session.status === 'signed-out') {
    return (
      <div className="app-region-no-drag flex shrink-0 items-center">
        <Button
          type="button"
          variant="default"
          size="sm"
          data-testid="account-sign-in"
          onClick={handleSignIn}
          aria-label={t('header.account.signIn')}
        >
          <Icon name="user" className="size-4" />
          <span>{t('header.account.signIn')}</span>
        </Button>
      </div>
    );
  }

  const label = session.displayName || t('header.account.profileLabel');
  const quotaText =
    quota === null
        ? t('header.account.quotaLoading')
        : quota.state === 'unavailable'
          ? t('header.account.quotaUnavailable')
          : (() => {
              const available = new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: quota.balance.currency,
              }).format(quotaAvailableMajor(quota.balance));
              const tokens = new Intl.NumberFormat(undefined).format(quota.usage.totalTokens);
              return quota.state === 'live'
                ? t('header.account.quotaLive', { available, tokens })
                : t('header.account.quotaStale', { available, tokens });
            })();
  const quotaState = quota === null ? 'loading' : quota.state;

  return (
    <div className="app-region-no-drag flex shrink-0 items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="account-profile"
            aria-label={t('header.account.profileLabel')}
            className="inline-flex h-8 max-w-[12rem] items-center gap-2 rounded-md px-1.5 typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-interactive-hover"
          >
            <AccountAvatar
              displayName={session.displayName}
              avatarUrl={session.avatarUrl}
              initials={session.initials}
              size="sm"
            />
            <span className="truncate">{label}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 p-0">
          <div className="flex items-center gap-3 px-4 py-3">
            <AccountAvatar
              displayName={session.displayName}
              avatarUrl={session.avatarUrl}
              initials={session.initials}
              size="lg"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate typography-ui-label font-medium text-foreground">{label}</div>
              {session.email ? (
                <div className="truncate typography-micro text-muted-foreground">{session.email}</div>
              ) : null}
              {session.tier ? (
                <span
                  data-testid="account-tier"
                  className="mt-1 inline-block rounded-full border border-border px-2 py-px typography-micro text-muted-foreground"
                >
                  {session.tier}
                </span>
              ) : null}
              <span
                data-testid="account-quota"
                data-quota-state={quotaState}
                className="mt-1 inline-block rounded-full border border-border px-2 py-px typography-micro text-muted-foreground"
              >
                {quotaText}
              </span>
            </div>
          </div>
          <DropdownMenuSeparator />
          <div className="p-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="account-sign-out"
              className="w-full"
              disabled={signingOut}
              onClick={() => void handleSignOut().catch(() => toast.error(t('sessionAuth.error.networkRetry')))}
            >
              <span>{t('header.account.signOut')}</span>
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
