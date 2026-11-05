import { expect, it } from 'vitest';
import { GLASS_PAGE } from '../src/glass-page.generated.js';
import { loadGlass } from './glass-dom.js';
import { acceptanceFleet, NOW } from './fixtures/glass-snapshots.js';

it('shows configured profile capacity and grounds without inventing a repo or revision', async () => {
  const snapshot = acceptanceFleet();
  snapshot.configuredTraps = [{ profile: 'desk', grounds: 'studio', harness: 'claude', surface: 'claude-desktop', state: 'needs-app-start', capacity: '0/1', instances: [] }];
  const glass = await loadGlass(GLASS_PAGE, snapshot, { now: NOW, hash: '#traps' });
  try {
    const profile = glass.$$('#traps .card').find((card) => card.textContent?.includes('trap:desk'));
    expect(profile?.textContent).toContain('studio');
    expect(profile?.textContent).toContain('claude-desktop');
    expect(profile?.textContent).toContain('0/1');
    expect(profile?.textContent).toContain('needs-app-start');
    expect(profile?.textContent).not.toMatch(/worktree|branch|revision|PR/);
  } finally { await glass.close(); }
});
