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
    expect(profile?.textContent).toContain('Desktop app');
    expect(profile?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Claude');
    expect(profile?.textContent).toContain('0/1');
    expect(profile?.textContent).toContain('needs-app-start');
    expect(profile?.textContent).not.toMatch(/worktree|branch|revision|PR/);
  } finally { await glass.close(); }
});

it('shows the desktop start link beside its queued catch and keeps phone viewers on a Mac-only instruction', async () => {
  const snapshot = acceptanceFleet();
  const start = { profile: 'desk', url: 'claude://code/new?q=Run+soak&folder=%2Ftmp%2Fdesk' };
  snapshot.configuredTraps = [{ profile: 'desk', grounds: 'studio', harness: 'claude', surface: 'claude-desktop', state: 'needs-app-start', capacity: '1/1', instances: [], start, pending: ['inspection'] }];
  snapshot.viewer = { onMachine: true, windowFocus: true, machine: 'Mac', device: 'desktop' };
  const desktop = await loadGlass(GLASS_PAGE, snapshot, { now: NOW, hash: '#traps' });
  try {
    expect(desktop.$('#traps')?.textContent).toContain('Queued: inspection');
    expect(desktop.$('#traps a[href^="claude:"]')?.getAttribute('href')).toBe(start.url);
  } finally { await desktop.close(); }
  snapshot.viewer.device = 'phone';
  const phone = await loadGlass(GLASS_PAGE, snapshot, { now: NOW, hash: '#traps' });
  try {
    expect(phone.$('#traps a[href^="claude:"]')).toBeNull();
    expect(phone.$('#traps .desktop-start')?.textContent).toContain('Code on the Mac');
    expect(phone.$('#traps .desktop-start [role="img"]')?.getAttribute('aria-label')).toBe('Claude');
  } finally { await phone.close(); }
});

it('renders an app-start action on the decision deep link without an approval answer form', async () => {
  const snapshot = acceptanceFleet();
  snapshot.viewer = { onMachine: true, windowFocus: true, machine: 'Mac', device: 'desktop' };
  const key = 'decision:desk-start';
  snapshot.attention = [{ kind: 'decision', key, id: key, lane: 'work', verb: 'decision', note: 'Start desk in Claude Code', ageSecs: 0, at: new Date(NOW).toISOString(), stateHash: 'start' }];
  snapshot.decisions = [{ key, title: 'Start desk in Claude Code', detail: 'Send the prefilled sign-on instruction', options: [], attachments: [], askedBy: 'helm', askedAt: new Date(NOW).toISOString(), stateHash: 'start', appStart: { profile: 'desk', url: 'claude://code/new?q=Run+soak&folder=%2Ftmp%2Fdesk' } }];
  const glass = await loadGlass(GLASS_PAGE, snapshot, { now: NOW, hash: `#decision/${encodeURIComponent(key)}` });
  try {
    expect(glass.$('.dmodal a[href^="claude:"]')?.getAttribute('aria-label')).toBe('Open Claude Code');
    expect(glass.$('.dmodal textarea')).toBeNull();
    expect(glass.$('.dmodal')?.textContent).toContain('clears after');
  } finally { await glass.close(); }
});
