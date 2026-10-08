import { describe, expect, test } from 'bun:test';
import { initialsOf, parseAccountSession } from './accountSession';

// Focused coverage for the header account surface's session-shape parser.
// The parser only READS the desktop-auth shape (GET /auth/session): an
// expired or corrupt answer must render the signed-out state, never a
// stuck loader, and tier/capability data renders only when present.

describe('parseAccountSession', () => {
  test('treats unauthenticated answers as signed-out', () => {
    expect(parseAccountSession({ authenticated: false, locked: true })).toEqual({ status: 'signed-out' });
  });

  test('treats corrupt payloads as signed-out, never stuck', () => {
    for (const corrupt of [null, undefined, '', 'oops', 42, [], { locked: true }, { authenticated: 'yes' }]) {
      expect(parseAccountSession(corrupt)).toEqual({ status: 'signed-out' });
    }
  });

  test('signs in cookie sessions with a generic identity', () => {
    const session = parseAccountSession({ authenticated: true });
    expect(session.status).toBe('signed-in');
    if (session.status === 'signed-in') {
      expect(session.displayName).toBe('');
      expect(session.email).toBe('');
      expect(session.tier).toBe('');
      expect(session.avatarUrl).toBe('');
    }
  });

  test('derives identity from the Alcore sub when nothing richer is present', () => {
    const session = parseAccountSession({ authenticated: true, alcore: { sub: 'user-1', sid: 'sess-1' } });
    expect(session).toMatchObject({ status: 'signed-in', displayName: 'user-1', email: '', tier: '' });
  });

  test('prefers email and name over the raw sub', () => {
    const session = parseAccountSession({
      authenticated: true,
      scope: 'alcore',
      sub: 'user-7',
      alcore: { sub: 'user-7', sid: 'sess-9', email: 'a@example.test', name: 'Ada' },
    });
    expect(session).toMatchObject({ status: 'signed-in', displayName: 'Ada', email: 'a@example.test' });
  });

  test('uses an email-like sub as the email', () => {
    const session = parseAccountSession({ authenticated: true, alcore: { sub: 'a@example.test', sid: 's' } });
    expect(session).toMatchObject({ status: 'signed-in', displayName: 'a@example.test', email: 'a@example.test' });
  });

  test('shows the tier badge only when capability data carries one', () => {
    expect(parseAccountSession({ authenticated: true, alcore: { sub: 'u', tier: 'pro' } })).toMatchObject({
      status: 'signed-in',
      tier: 'pro',
    });
    expect(
      parseAccountSession({ authenticated: true, alcore: { sub: 'u', capabilities: { tier: 'team' } } }),
    ).toMatchObject({ status: 'signed-in', tier: 'team' });
    expect(parseAccountSession({ authenticated: true, matrix: { plan: 'scale' } })).toMatchObject({
      status: 'signed-in',
      tier: 'scale',
    });
  });

  test('carries the avatar URL through when the service provides one', () => {
    const session = parseAccountSession({
      authenticated: true,
      alcore: { sub: 'u', picture: 'https://example.test/avatar.png' },
    });
    expect(session).toMatchObject({ status: 'signed-in', avatarUrl: 'https://example.test/avatar.png' });
  });

  test('reads the product profile shape (name plus snake_case avatar_url)', () => {
    const session = parseAccountSession({
      authenticated: true,
      alcore: {
        sub: 'auth_user_1',
        name: 'Ada',
        avatar_url: 'https://example.test/ada.png',
        updated_at: '2026-10-08T19:30:00Z',
      },
    });
    expect(session).toMatchObject({
      status: 'signed-in',
      displayName: 'Ada',
      avatarUrl: 'https://example.test/ada.png',
      initials: 'A',
    });
  });

  test('reads snake_case avatar_url at the top level too', () => {
    const session = parseAccountSession({
      authenticated: true,
      sub: 'u',
      avatar_url: 'https://example.test/top.png',
    });
    expect(session).toMatchObject({ status: 'signed-in', avatarUrl: 'https://example.test/top.png' });
  });

  test('omits malformed avatar URLs but stays signed in', () => {
    // The panel stays lenient about URL schemes (product validates https
    // at its own boundary); only non-text or blank values are dropped.
    for (const avatar_url of ['', '   ', 42, { url: 'x' }]) {
      const session = parseAccountSession({ authenticated: true, alcore: { sub: 'u', name: 'Bo', avatar_url } });
      expect(session).toMatchObject({ status: 'signed-in', displayName: 'Bo', avatarUrl: '', initials: 'B' });
    }
  });

  test('degrades a missing avatar URL to the name initial', () => {
    const session = parseAccountSession({
      authenticated: true,
      alcore: { sub: 'u', name: 'Ada', email: 'a@example.test' },
    });
    expect(session).toMatchObject({
      status: 'signed-in',
      displayName: 'Ada',
      email: 'a@example.test',
      avatarUrl: '',
      initials: 'A',
    });
  });

  test('shows tier-matrix tier names from capability and matrix shapes', () => {
    expect(
      parseAccountSession({ authenticated: true, alcore: { sub: 'u', capabilities: { tier: 'paid' } } }),
    ).toMatchObject({ status: 'signed-in', tier: 'paid' });
    expect(
      parseAccountSession({ authenticated: true, matrix: { tier: 'free-tier' } }),
    ).toMatchObject({ status: 'signed-in', tier: 'free-tier' });
    expect(
      parseAccountSession({ authenticated: true, alcore: { sub: 'u', plan: 'pending-payment' } }),
    ).toMatchObject({ status: 'signed-in', tier: 'pending-payment' });
  });

  test('ignores unfamiliar extras instead of signing out a live session', () => {
    const session = parseAccountSession({
      authenticated: true,
      alcore: { sub: 'u', sid: 's', unknownFutureField: { nested: [1, 2, 3] } },
      anotherFutureField: 7,
    });
    expect(session).toMatchObject({ status: 'signed-in', displayName: 'u' });
  });
});

describe('initialsOf', () => {
  test('takes the first letter or digit, uppercased', () => {
    expect(initialsOf('ada')).toBe('A');
    expect(initialsOf('a@example.test')).toBe('A');
    expect(initialsOf('  jo ')).toBe('J');
  });

  test('falls back to empty for blank names', () => {
    expect(initialsOf('')).toBe('');
    expect(initialsOf('   ')).toBe('');
  });
});
