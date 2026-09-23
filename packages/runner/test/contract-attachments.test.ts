import { describe, expect, it } from 'vitest';
import { buildPrompt } from '../src/contract.js';

describe('runner attachment contract', () => {
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
