import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/contract.js';

describe('runner attachment contract', () => {
  it('tells a follow-up the existing PR head branch and that the runner will not push', () => {
    const prompt = buildPrompt('Repair the conflict.', {
      id: 'repair',
      existingPr: { url: 'https://github.com/example/repo/pull/17', headRefName: 'feature/pr' },
    });
    expect(prompt).toContain('Head branch: feature/pr');
    expect(prompt).toContain('The runner will not push this follow-up.');
    expect(prompt).not.toContain('opens or adopts one draft PR');
    expect(prompt).toContain('Push only to the existing branch feature/pr, with `lobstah push repair`.');
    expect(prompt).toContain('Never open a new PR.');
  });

  it('lists file metadata after the brief without inlining bytes', () => {
    const prompt = buildPrompt('Do the task.', {
      id: 'd1',
      attachments: [{ name: 'pixel.png', path: '/tmp/owned/pixel.png', bytes: 12, type: 'image/png' }],
    });
    expect(prompt).toContain('--- BRIEF ---\n\nDo the task.\n\n--- ATTACHMENTS ---');
    expect(prompt).toContain('pixel.png (image/png, 12 bytes) at /tmp/owned/pixel.png');
    expect(prompt).toContain('Images and PDFs can be read directly with your file tools.');
    expect(prompt).not.toContain('data:image');
  });
});
