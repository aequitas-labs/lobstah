import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lobstahVersion } from '@lobstah/core';
import {
  installPet,
  petBinaryHome,
  petRow,
  petSourceDir,
  petStaleReason,
  petStampFile,
  readPetStamp,
  refreshStalePet,
  UNKNOWN_PET_VERSION,
  type PetBuild,
  type PetStamp,
} from '../src/pet.js';
import { removeTempDir } from '../../../test/temp-dir.js';

let home: string;
let plist: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-pet-install-'));
  process.env.LOBSTAH_HOME = home;
  plist = path.join(home, 'LaunchAgents', 'lobstah.pet.plist');
});
afterEach(() => {
  removeTempDir(home);
  delete process.env.LOBSTAH_HOME;
});

/** A build that writes a fake binary with the given contents, as SwiftPM would. */
function buildWriting(contents: string): (sources: string) => PetBuild {
  return () => {
    const binary = path.join(home, 'pet', 'build', 'release', 'LobstahPet');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, contents);
    return { ok: true, binary, out: 'Build complete!' };
  };
}

const failingBuild = (): PetBuild => ({ ok: false, out: "Compiling LobstahPet\nerror: unable to invoke subcommand: swift-build\n" });

function installedBinary(contents: string, stamp?: PetStamp): void {
  fs.mkdirSync(path.dirname(petBinaryHome()), { recursive: true });
  fs.writeFileSync(petBinaryHome(), contents);
  if (stamp) fs.writeFileSync(petStampFile(), JSON.stringify(stamp));
}

const install = (opts: Parameters<typeof installPet>[0]) => installPet({ load: false, plist, platform: 'darwin', ...opts });

describe('pet install', () => {
  it('builds the pet from its sources and stamps it with this lobstah version', () => {
    installedBinary('old pet', { version: '0.7.9', from: 'source', path: '/old', at: '2026-10-09T00:00:00Z' });
    const res = install({ sources: '/pkg/pet', build: buildWriting('fresh pet') });
    expect(fs.readFileSync(petBinaryHome(), 'utf8')).toBe('fresh pet');
    expect(readPetStamp()).toMatchObject({ version: lobstahVersion(), from: 'source', path: '/pkg/pet' });
    expect(res).toMatchObject({ source: 'built from /pkg/pet', version: lobstahVersion() });
    expect(res.warning).toBeUndefined();
    expect(fs.readFileSync(plist, 'utf8')).toContain(petBinaryHome());
  });

  it('says it reused the installed pet, and which build it is, when the build fails', () => {
    installedBinary('old pet', { version: '0.7.9', from: 'source', path: '/old', at: '2026-10-09T00:00:00Z' });
    const res = install({ sources: '/pkg/pet', build: failingBuild });
    expect(fs.readFileSync(petBinaryHome(), 'utf8')).toBe('old pet');
    expect(res.source).toBe('reused the installed binary');
    expect(res.version).toBe('0.7.9');
    expect(res.warning).toBe(
      `could not build the pet from /pkg/pet: error: unable to invoke subcommand: swift-build; reused the installed binary (built from v0.7.9), not a pet for v${lobstahVersion()}`,
    );
    expect(readPetStamp()?.version).toBe('0.7.9');
  });

  it('says the CLI ships no sources when there are none to build', () => {
    installedBinary('old pet');
    const res = install({ sources: null });
    expect(res.warning).toContain('this lobstah ships no pet sources');
    expect(res.warning).toContain('build unknown, older than version stamps');
  });

  it('refuses when it can neither build nor reuse a pet', () => {
    expect(() => install({ sources: '/pkg/pet', build: failingBuild })).toThrow(/could not build the pet .*\(xcode-select --install\)/);
  });

  it('stamps a --binary pet with an unknown version that is never called stale', () => {
    const own = path.join(home, 'my-build', 'LobstahPet');
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, 'my pet');
    const res = install({ binary: own, build: () => { throw new Error('--binary must not build'); } });
    expect(res.source).toBe(`copied ${own}`);
    expect(readPetStamp()).toMatchObject({ version: UNKNOWN_PET_VERSION, from: 'binary', path: own });
    expect(petStaleReason(readPetStamp(), '9.9.9')).toBeUndefined();
  });

  it('finds the pet sources in this checkout', () => {
    expect(petSourceDir()).toBe(path.resolve(fileDir(), '../../pet'));
  });
});

function fileDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

describe('doctor pet row: the installed build against the CLI', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const stamp = (version: string): PetStamp => ({ version, from: 'source', path: '/pkg/pet', at: '2026-10-09T00:00:00Z' });
  const row = (s: PetStamp | null, version = '0.8.6') => {
    installedBinary('pet');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '');
    return petRow({ now, plist, alive: () => false, stamp: s, version, platform: 'darwin' });
  };

  it('warns when the pet was built from an older lobstah', () => {
    expect(row(stamp('0.8.0'))).toMatchObject({ status: 'warn', detail: expect.stringContaining('out of date: it was built from v0.8.0, the CLI is v0.8.6 (run lobstah pet install)') });
  });

  it('warns when the pet predates version stamps', () => {
    expect(row(null).detail).toContain('out of date: its build is older than version stamps');
  });

  it('adds nothing when the pet matches the CLI', () => {
    expect(row(stamp('0.8.6')).detail).not.toContain('out of date');
  });

  it('does not judge a pet that is not installed', () => {
    expect(petRow({ now, plist, binary: path.join(home, 'nope'), stamp: null, platform: 'darwin' })).toMatchObject({ status: 'skip' });
  });
});

describe('daemon start: refresh a stale pet', () => {
  const agent = () => {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '');
  };

  it('rebuilds a stale installed pet once per CLI version', () => {
    agent();
    installedBinary('pet', { version: '0.8.0', from: 'source', path: '/old', at: '2026-10-09T00:00:00Z' });
    const logs: string[] = [];
    const opts = { platform: 'darwin' as const, sources: '/pkg/pet', plist, spawnInstall: (log: string) => logs.push(log) };
    expect(refreshStalePet(opts)).toEqual({ from: '0.8.0', to: lobstahVersion() });
    expect(logs).toEqual([path.join(home, 'logs', 'pet-install.log')]);
    // A failed rebuild leaves the stamp stale; the next restart doesn't try again.
    expect(refreshStalePet(opts)).toBeUndefined();
    expect(logs).toHaveLength(1);
  });

  it('leaves a current pet, a pet with no login agent, and a CLI with no sources alone', () => {
    const spawnInstall = () => { throw new Error('should not rebuild'); };
    installedBinary('pet', { version: lobstahVersion(), from: 'source', path: '/pkg/pet', at: '2026-11-09T00:00:00Z' });
    agent();
    expect(refreshStalePet({ platform: 'darwin', sources: '/pkg/pet', plist, spawnInstall })).toBeUndefined();
    fs.writeFileSync(petStampFile(), JSON.stringify({ version: '0.8.0', from: 'source', path: '/old', at: '2026-10-09T00:00:00Z' }));
    expect(refreshStalePet({ platform: 'darwin', sources: null, plist, spawnInstall })).toBeUndefined();
    expect(refreshStalePet({ platform: 'darwin', sources: '/pkg/pet', plist: path.join(home, 'none.plist'), spawnInstall })).toBeUndefined();
    expect(refreshStalePet({ platform: 'linux', sources: '/pkg/pet', plist, spawnInstall })).toBeUndefined();
  });
});
