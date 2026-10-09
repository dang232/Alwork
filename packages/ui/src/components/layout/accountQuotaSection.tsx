import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { formatQuotaMoney, quotaBalanceShares, type AccountQuota } from './accountQuota';

// TokenPanel quota as labeled progress-bar rows in the account panel,
// speaking the usage panel's row vocabulary: a labeled bar for the one
// share the read API can support (available-vs-total balance) and plain
// value rows for the usage totals, which have no server-side limit to
// percent against. A zero-amount balance shows its value without a bar,
// like the usage panel's balance-only windows. Unavailable never renders
// numbers — only the muted notice, never a fabricated quota.

export const AccountQuotaSection: React.FC<{
  quota: AccountQuota | null;
  onRefresh: () => void;
}> = ({ quota, onRefresh }) => {
  const { t } = useI18n();
  const quotaState = quota === null ? 'loading' : quota.state;
  const detail = quota !== null && quota.state !== 'unavailable' ? quota : null;
  const shares = detail !== null ? quotaBalanceShares(detail.balance) : null;
  const availableText =
    detail !== null ? formatQuotaMoney(detail.balance.availableMicros, detail.balance.currency) : '';
  const totalText =
    detail !== null ? formatQuotaMoney(detail.balance.amountMicros, detail.balance.currency) : '';
  const tokensText = detail !== null ? new Intl.NumberFormat(undefined).format(detail.usage.totalTokens) : '';
  const requestsText =
    detail !== null ? new Intl.NumberFormat(undefined).format(detail.usage.totalRequests) : '';
  const costText =
    detail !== null ? formatQuotaMoney(detail.usage.totalCostMicros, detail.usage.currency) : '';

  return (
    <div data-testid="account-quota" data-quota-state={quotaState} className="px-4 py-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="typography-ui-label min-w-0 flex-1 truncate font-medium text-foreground">
          {t('header.account.quota.sectionTitle')}
        </span>
        {quota !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="account-quota-refresh"
            className="size-6 shrink-0 text-muted-foreground"
            onClick={() => onRefresh()}
            aria-label={t('settings.usage.sidebar.actions.refreshAria')}
            title={t('settings.usage.sidebar.actions.refreshTitle')}
          >
            <Icon name="refresh" className="size-3.5" />
          </Button>
        ) : null}
      </div>
      {detail === null ? (
        <div className="typography-micro text-muted-foreground">
          {quota === null ? t('header.account.quotaLoading') : t('header.account.quotaUnavailable')}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div>
            <div className="flex items-baseline justify-between gap-2">
              <span className="typography-micro min-w-0 truncate text-muted-foreground">
                {t('header.account.quota.balance')}
              </span>
              <span className="typography-micro shrink-0 tabular-nums text-foreground">
                {t('header.account.quota.balanceValue', { available: availableText, total: totalText })}
              </span>
            </div>
            {shares !== null && shares.availablePercent !== null ? (
              <div className="mt-1.5">
                <UsageProgressBar
                  percent={shares.availablePercent}
                  tonePercent={shares.usedPercent}
                  className="h-1.5"
                />
              </div>
            ) : null}
            {detail.state === 'stale-cached' ? (
              <div className="mt-1 typography-micro text-muted-foreground">{t('header.account.quota.stale')}</div>
            ) : null}
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="typography-micro min-w-0 truncate text-muted-foreground">
              {t('header.account.quota.tokens')}
            </span>
            <span className="typography-micro shrink-0 tabular-nums text-foreground">{tokensText}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="typography-micro min-w-0 truncate text-muted-foreground">
              {t('header.account.quota.requests')}
            </span>
            <span className="typography-micro shrink-0 tabular-nums text-foreground">{requestsText}</span>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="typography-micro min-w-0 truncate text-muted-foreground">
              {t('header.account.quota.cost')}
            </span>
            <span className="typography-micro shrink-0 tabular-nums text-foreground">{costText}</span>
          </div>
        </div>
      )}
    </div>
  );
};
