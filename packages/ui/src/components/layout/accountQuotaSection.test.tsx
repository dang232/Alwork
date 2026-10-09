import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import type { AccountQuota } from './accountQuota';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event, MouseEvent: dom.MouseEvent });
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { act } = await import('react');
const { AccountQuotaSection } = await import('./accountQuotaSection');
const { I18nProvider } = await import('@/lib/i18n');

const live: AccountQuota = {
  state: 'live',
  balance: { amountMicros: 2_000_000, reservedMicros: 750_000, availableMicros: 1_250_000, currency: 'USD' },
  usage: { totalRequests: 42, totalTokens: 1200, totalCostMicros: 300_000, totalPriceMicros: 500_000, currency: 'USD' },
};

const stale: AccountQuota = { ...live, state: 'stale-cached' };

const zeroAmount: AccountQuota = {
  state: 'live',
  balance: { amountMicros: 0, reservedMicros: 0, availableMicros: 0, currency: 'USD' },
  usage: { totalRequests: 0, totalTokens: 0, totalCostMicros: 0, totalPriceMicros: 0, currency: 'USD' },
};

const containers: HTMLElement[] = [];
const render = (quota: AccountQuota | null, onRefresh: () => void = () => {}) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  flushSync(() => createRoot(container).render(<I18nProvider><AccountQuotaSection quota={quota} onRefresh={onRefresh} /></I18nProvider>));
  return container;
};

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

test('live quota renders labeled bar rows with real values', () => {
  const container = render(live);

  expect(container.querySelector('[data-quota-state]')?.getAttribute('data-quota-state')).toBe('live');
  expect(container.textContent).toContain('Quota');
  expect(container.textContent).toContain('Available balance');
  expect(container.textContent).toContain('Tokens');
  expect(container.textContent).toContain('Requests');
  expect(container.textContent).toContain('Cost');
  // 1_250_000 of 2_000_000 available -> 63% bar (the only percent the API supports).
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('63');
  expect(container.textContent).not.toContain('Stale');
});

test('stale quota keeps its bars and names the staleness', () => {
  const container = render(stale);

  expect(container.querySelector('[data-quota-state]')?.getAttribute('data-quota-state')).toBe('stale-cached');
  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('63');
  expect(container.textContent).toContain('Stale');
});

test('unavailable renders the notice with no numbers and no bars', () => {
  const container = render({ state: 'unavailable' });

  expect(container.querySelector('[data-quota-state]')?.getAttribute('data-quota-state')).toBe('unavailable');
  expect(container.textContent).toContain('Quota unavailable');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});

test('loading renders the loading notice with no refresh control', () => {
  const container = render(null);

  expect(container.querySelector('[data-quota-state]')?.getAttribute('data-quota-state')).toBe('loading');
  expect(container.textContent).toContain('Quota…');
  expect(container.querySelector('[data-testid="account-quota-refresh"]')).toBeNull();
});

test('a zero-amount balance shows values without a bar', () => {
  const container = render(zeroAmount);

  expect(container.textContent).toContain('Available balance');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
});

test('the refresh control asks for a fresh read', () => {
  let calls = 0;
  const container = render(live, () => {
    calls += 1;
  });
  const button = container.querySelector('[data-testid="account-quota-refresh"]');
  expect(button).not.toBeNull();
  act(() => {
    button?.dispatchEvent(new Event('click', { bubbles: true }));
  });
  expect(calls).toBe(1);
});
