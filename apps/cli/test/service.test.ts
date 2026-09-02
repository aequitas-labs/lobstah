import { describe, expect, it } from 'vitest';
import { renderLaunchdPlist, renderSystemdUnit, servicePathEnv } from '../src/service.js';
import type { ServiceSpec } from '../src/service.js';

const spec: ServiceSpec = {
  kind: 'daemon',
  nodePath: '/opt/node/bin/node',
  entry: '/opt/node/lib/node_modules/lobstah/dist/main.js',
  pathEnv: '/opt/node/bin:/usr/bin:/bin',
  home: '/home/u/.lobstah',
  logDir: '/home/u/.lobstah/logs',
};

describe('service unit rendering', () => {
  it('launchd plist carries absolute node/entry, PATH, and keep-alive', () => {
    const plist = renderLaunchdPlist(spec);
    expect(plist).toContain('<string>lobstah.daemon</string>');
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
    expect(plist).toContain('<string>/opt/node/lib/node_modules/lobstah/dist/main.js</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<key>PATH</key><string>/opt/node/bin:/usr/bin:/bin</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('/home/u/.lobstah/logs/daemon.log');
  });

  it('systemd unit restarts always and pins PATH + LOBSTAH_HOME', () => {
    const unit = renderSystemdUnit({ ...spec, kind: 'pick' });
    expect(unit).toContain('ExecStart=/opt/node/bin/node /opt/node/lib/node_modules/lobstah/dist/main.js pick');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment=PATH=/opt/node/bin:/usr/bin:/bin');
    expect(unit).toContain('Environment=LOBSTAH_HOME=/home/u/.lobstah');
  });

  it('servicePathEnv leads with the node directory and dedupes', () => {
    const p = servicePathEnv('/usr/bin/node', '/home/u');
    const parts = p.split(':');
    expect(parts[0]).toBe('/usr/bin');
    expect(new Set(parts).size).toBe(parts.length);
    expect(parts).toContain('/home/u/.local/bin');
  });
});
