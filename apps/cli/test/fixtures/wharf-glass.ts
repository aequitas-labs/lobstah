import type { Snapshot, DispatchView, Detail } from '../../../../services/wharf/glass/src/model.js';
export const snapshot: Snapshot = {
  helmLive: true,
  boats: [{ id: 'boat', name: 'chris-macbook', revoked: 0, permissions: ['work', 'helm'], repos: ['github.com/aequitas-labs/lobstah'], lastCheckIn: '2026-10-10T17:00:00Z' }],
  workers: [{ id: 'kind-crab', boat: 'boat', boatName: 'chris-macbook', repoRemote: 'github.com/aequitas-labs/lobstah', harness: 'codex', session: 'test-session', current: 'job', lastCheckIn: '2026-10-10T17:00:00Z' }],
  documents: [
    { id: 'card', kind: 'decision', title: 'Choose the next catch', options: ['Keep it small', 'Split the work'], at: '2026-10-10T16:50:00Z', author: 'helm', published: true, markdown: { id: 'md', name: 'detail.md', size: 40 }, attachments: [{ id: 'image', name: 'lob.png', size: 100 }] },
    { id: 'report', kind: 'report', title: 'Wharf progress', at: '2026-10-10T16:45:00Z', author: 'kind-crab', published: true, markdown: { id: 'report-md', name: 'report.md', size: 40 }, attachments: [] },
  ],
  requests: [{ id: 'request', kind: 'message', dispatch: 'job', text: 'Keep the local default unchanged', at: '2026-10-10T16:59:00Z', expiresAt: '2026-10-10T17:09:00Z', state: 'queued', waitingForHelm: true, by: 'person' }],
};
export const jobs: DispatchView[] = [{ id: 'job', repo: 'lobstah', repoRemote: 'github.com/aequitas-labs/lobstah', brief: 'Build the hosted spyglass\nLocal files stay the default.', state: 'active', workerId: 'kind-crab', claimedBoat: 'boat', status: { verb: 'working', note: 'Browser controls and cookie boundary tests in progress.', at: '2026-10-10T17:00:00Z' } }];
export const detail: Detail = { ...jobs[0], reports: [jobs[0].status!, { verb: 'paused', note: 'Waiting for review', waitingOn: 'review', at: '2026-10-10T16:40:00Z', evidence: { prUrls: ['https://github.com/aequitas-labs/lobstah/pull/205'], files: ['worker-md', 'worker-image'] } }], messages: [{ id: '1', text: 'Please preserve local behavior.', received: true }], files: [{ id: 'worker-md', name: 'report.md', size: 100 }, { id: 'worker-image', name: 'lob.png', size: 100 }] };
export const markdown = '# Small, safe changes\n\nUse **the existing glass look**.\n\n<script>alert(1)</script>\n\n![lobster with star](lob.png) ![remote](https://evil.test/a.png) ![other](other.png)\n\n[bad](javascript:alert(1)) [PR](https://github.com/aequitas-labs/lobstah/pull/205)';
