import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GLASS_IMAGE_HOSTS } from '../../../services/wharf/src/glass-page.js';

/**
 * The hosted glass's Content-Security-Policy refuses every remote image
 * outside GLASS_IMAGE_HOSTS, where the local glass loads any https image.
 * PR evidence lives on raw.githubusercontent.com; with that host missing, a
 * decision card's screenshots and a PR description's images showed on the
 * local glass and not on the hosted one.
 */
describe('the hosted glass’s image hosts', () => {
  it('include the host that PR evidence is published to', () => {
    const script = fs.readFileSync(new URL('../../../scripts/pr-assets.sh', import.meta.url), 'utf8');
    const published = /url="(https:\/\/[^/$"]+)\//.exec(script)?.[1];
    expect(published).toBe('https://raw.githubusercontent.com');
    expect(GLASS_IMAGE_HOSTS).toContain(published);
  });

  it('are exact https GitHub hosts, with no wildcard or path', () => {
    for (const host of GLASS_IMAGE_HOSTS) {
      const url = new URL(host);
      expect(url.protocol, host).toBe('https:');
      expect(url.origin, host).toBe(host);
      expect(url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'), host).toBe(true);
    }
  });
});
