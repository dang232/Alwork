import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listInstalledGuests, toPublicGuest } from './catalog.js';
import { enterpriseBlockedCapabilities } from './enterprise.js';
import { guestGrantScope } from './grant-scope.js';
import { installGuestFromPath } from './install.js';
import { readExtensionStore, setCapabilityGrants, writeExtensionStore } from './persist.js';

const enterprise = (allowedExtensions = []) => ({ enterpriseMode: true, allowedExtensions });
const withOrigins = { origins: ['https://api.acme.test'] };

describe('enterpriseBlockedCapabilities', () => {
  test('refuses nothing outside enterprise mode', () => {
    expect(enterpriseBlockedCapabilities({ origins: withOrigins.origins }, { source: 'zip' }, { enterpriseMode: false, allowedExtensions: [] })).toEqual([]);
  });

  test('refuses what could send data out, from any source but an allowed repository', () => {
    const guest = { origins: ['https://api.acme.test'] };
    expect(enterpriseBlockedCapabilities(guest, { source: 'zip' }, enterprise())).toEqual(['origins']);
    expect(enterpriseBlockedCapabilities(guest, { source: 'path' }, enterprise(['https://github.com/acme/ext']))).toEqual(['origins']);
    expect(enterpriseBlockedCapabilities(guest, { source: 'git', gitUrl: 'https://github.com/other/ext' }, enterprise(['https://github.com/acme/ext']))).toEqual(['origins']);
  });

  test('allows a listed repository however its URL is spelled', () => {
    const guest = { origins: ['https://api.acme.test'] };
    const policy = enterprise(['https://github.com/acme/ext']);
    for (const gitUrl of ['https://github.com/acme/ext.git', 'https://GitHub.com/acme/ext/', 'git@github.com:acme/ext.git']) {
      expect(enterpriseBlockedCapabilities(guest, { source: 'git', gitUrl }, policy)).toEqual([]);
    }
  });

  test('an entry ending in a slash allows every repository under it, and nothing beside it', () => {
    const guest = { origins: ['https://api.acme.test'] };
    const policy = enterprise(['https://github.com/acme/']);
    expect(enterpriseBlockedCapabilities(guest, { source: 'git', gitUrl: 'https://github.com/acme/new-ext#my-branch' }, policy)).toEqual([]);
    expect(enterpriseBlockedCapabilities(guest, { source: 'git', gitUrl: 'git@github.com:acme/team/tool.git' }, policy)).toEqual([]);
    expect(enterpriseBlockedCapabilities(guest, { source: 'git', gitUrl: 'https://github.com/acme-other/ext' }, policy)).toEqual(['origins']);
    expect(enterpriseBlockedCapabilities(guest, { source: 'git', gitUrl: 'https://github.com/acme' }, policy)).toEqual(['origins']);
  });

  test('allowLocalExtensions opens a local folder for developers, never a ZIP', () => {
    const guest = { origins: ['https://api.acme.test'] };
    const policy = { enterpriseMode: true, allowedExtensions: [], allowLocalExtensions: true };
    expect(enterpriseBlockedCapabilities(guest, { source: 'path' }, policy)).toEqual([]);
    expect(enterpriseBlockedCapabilities(guest, { source: 'zip' }, policy)).toEqual(['origins']);
  });

  test('leaves packages that cannot send data out alone', () => {
    expect(enterpriseBlockedCapabilities({}, { source: 'zip' }, enterprise())).toEqual([]);
  });
});

const writeGuest = async (root, id, contributes = {}) => {
  await fs.mkdir(path.join(root, 'panel'), { recursive: true });
  await fs.writeFile(path.join(root, 'panel', 'index.html'), '<html></html>');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: `@openchamber/${id}`,
    version: '1.0.0',
    openchamber: {
      apiVersion: 1,
      contributes: { panel: { id, name: id, icon: 'window', entry: 'panel/index.html' }, ...contributes },
    },
  }));
};

describe('extensions in enterprise mode', () => {
  afterEach(() => {
    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
  });

  test('refuses to install a package that could send data out, and installs one that cannot', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-enterprise-'));
    const persistPath = path.join(dir, 'extensions.json');
    await writeGuest(path.join(dir, 'reach'), 'reach-out', withOrigins);
    await writeGuest(path.join(dir, 'quiet'), 'stay-home');
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';

    const refused = await installGuestFromPath(path.join(dir, 'reach'), persistPath);
    expect(refused).toEqual({ ok: false, code: 'enterprise-mode', capabilities: ['origins'] });
    expect((await installGuestFromPath(path.join(dir, 'quiet'), persistPath)).ok).toBe(true);
    expect((await listInstalledGuests({ persistPath })).map((guest) => guest.id)).toEqual(['stay-home']);
  });

  test('drops an installed package\'s approved grants once enterprise mode turns on', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-ext-enterprise-'));
    const persistPath = path.join(dir, 'extensions.json');
    await writeGuest(path.join(dir, 'reach'), 'reach-later', withOrigins);
    expect((await installGuestFromPath(path.join(dir, 'reach'), persistPath)).ok).toBe(true);
    const [installed] = await listInstalledGuests({ persistPath });
    await setCapabilityGrants(installed.id, persistPath, ['origins'], guestGrantScope(installed));
    const [approved] = await listInstalledGuests({ persistPath });
    expect(approved.capabilityGrants).toEqual(['origins']);
    expect(toPublicGuest(approved).storageId).toEqual(expect.any(String));

    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const [guest] = await listInstalledGuests({ persistPath });
    expect(guest.enterpriseBlocked).toEqual(['origins']);
    expect(guest.capabilityGrants).not.toContain('origins');
    expect(toPublicGuest(guest)).not.toHaveProperty('storageId');

    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    const [restored] = await listInstalledGuests({ persistPath });
    expect(restored.enterpriseBlocked).toBeUndefined();
    expect(restored.capabilityGrants).toEqual(['origins']);
    expect(toPublicGuest(restored).storageId).toEqual(expect.any(String));
  });
});

describe('slot allowlist enforcement at load', () => {
  const seedGitGuest = async (dir, id, url) => {
    const pkgDir = path.join(dir, id);
    await writeGuest(pkgDir, id);
    const root = await fs.realpath(pkgDir);
    const persistPath = path.join(dir, 'extensions.json');
    await writeExtensionStore(persistPath, {
      paths: [root],
      sources: { [root]: 'git' },
      gitOrigins: { [root]: { url } },
    });
    return persistPath;
  };
  const warnings = () => {
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.join(' ')); };
    return { lines, restore: () => { console.warn = original; } };
  };

  afterEach(() => {
    delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
    delete process.env.OPENCHAMBER_ALLOWED_EXTENSIONS;
  });

  test('an allowlisted git package loads', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-slot-'));
    const url = 'https://github.com/acme/ext';
    const persistPath = await seedGitGuest(dir, 'slot-ok', url);
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    process.env.OPENCHAMBER_ALLOWED_EXTENSIONS = url;
    const guests = await listInstalledGuests({ persistPath });
    expect(guests.map((guest) => guest.id)).toEqual(['slot-ok']);
  });

  test('a non-allowlisted git package is refused at load even when installed, with a logged reason', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-slot-'));
    const persistPath = await seedGitGuest(dir, 'slot-out', 'https://github.com/evil/ext');
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    const watch = warnings();
    try {
      expect(await listInstalledGuests({ persistPath })).toEqual([]);
    } finally {
      watch.restore();
    }
    expect(watch.lines.some((line) => line.includes('slot-out') && line.includes('allowedExtensions'))).toBe(true);
    // The refusal is at load: the install itself is kept, and listing the
    // repository later loads it without reinstalling.
    expect((await readExtensionStore(persistPath)).paths).toHaveLength(1);
    process.env.OPENCHAMBER_ALLOWED_EXTENSIONS = 'https://github.com/evil/ext';
    expect((await listInstalledGuests({ persistPath })).map((guest) => guest.id)).toEqual(['slot-out']);
  });

  test('a git package with an unreadable origin is refused', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-slot-'));
    const persistPath = await seedGitGuest(dir, 'slot-bad', 'not a repository url');
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    process.env.OPENCHAMBER_ALLOWED_EXTENSIONS = 'https://github.com/acme/ext';
    expect(await listInstalledGuests({ persistPath })).toEqual([]);
  });

  test('git packages load untouched outside enterprise mode', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-slot-'));
    const persistPath = await seedGitGuest(dir, 'slot-free', 'https://github.com/evil/ext');
    expect((await listInstalledGuests({ persistPath })).map((guest) => guest.id)).toEqual(['slot-free']);
  });
});
