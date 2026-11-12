import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTerminal, terminalText } from '../src/terminal-render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** An interactive wharf deploy's output.log, with its ids and paths replaced. */
const wharfDeploy = fs.readFileSync(path.join(here, 'fixtures', 'wharf-deploy-run.log'), 'utf8');

describe('terminalText on a real wharf deploy', () => {
  const text = terminalText(wharfDeploy);
  const lines = text.split('\n');

  it('leaves no escape sequence, carriage return or control character', () => {
    expect(wharfDeploy).toContain('\x1b[');
    expect(wharfDeploy).toContain('\r');
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(text).not.toMatch(/\[[0-9;?]+[A-Za-z]/);
  });

  it('collapses answered prompts to their answer, and the spinner to the line that replaced it', () => {
    expect(text).not.toContain('(Y/n)');
    expect(text).not.toContain('(y/N)');
    expect(lines).toContain('Your database may not be available to serve requests during the migration, continue? … yes');
    expect(lines).toContain('✔ Would you like Wrangler to stop asking about skills updates? … no');
    expect(lines).not.toContain('? Would you like Wrangler to stop asking about skills updates? › (y/N)');
    expect(text).not.toContain('⠙');
    expect(lines).toContain('== Deploying');
    expect(lines).toContain('== Health');
  });

  it('keeps the text, boxes and emoji as written', () => {
    expect(lines).toContain('✘ [ERROR] More than one account available but unable to select one in non-interactive mode.');
    expect(lines).toContain('│ 0003_slack_grounds.sql │ ✅     │');
    expect(text).toContain('🪵  Logs were written to');
    expect(lines.at(-1)).toBe('Deployed and healthy.');
  });

  it('keeps the colors as spans', () => {
    const screen = renderTerminal(wharfDeploy);
    const error = screen.find((l) => l.map((s) => s.text).join('').startsWith('✘ [ERROR]'))!;
    expect(error[0]).toEqual({ text: '✘ ', fg: '1' });
    expect(error.find((s) => s.text === 'ERROR')).toEqual({ text: 'ERROR', fg: '15', bg: '1' });
    expect(error.at(-1)).toMatchObject({ bold: true });
    const npm = screen.find((l) => l[0]?.text === 'npm')!;
    expect(npm.slice(0, 3)).toEqual([{ text: 'npm', bold: true }, { text: ' ' }, { text: 'warn', fg: '3' }]);
  });
});

describe('renderTerminal', () => {
  const text = terminalText;

  it('applies carriage returns, erase-line, cursor column and cursor up', () => {
    expect(text('50%\r100%')).toBe('100%');
    expect(text('long line\rshort\x1b[K')).toBe('short');
    expect(text('abc\x1b[2Kx')).toBe('   x');
    expect(text('abc\x1b[2K\x1b[1Gx')).toBe('x');
    expect(text('hello\x1b[3Gy')).toBe('heylo');
    expect(text('one\ntwo\x1b[1A\x1b[2K\x1b[1Gdone')).toBe('done\ntwo');
    // Nothing is above the first line: the cursor stays where it was.
    expect(text('a\x1b[1A\x1b[1Ab')).toBe('ab');
    expect(text('ab\bc')).toBe('ac');
    expect(text('a\tb')).toBe('a       b');
    // vite and vercel redraw their status line this way.
    expect(text('building…\n\x1b[2K\x1b[1A\x1b[2K\x1b[Gbuilt in 3s\n')).toBe('built in 3s');
  });

  it('treats a pipe newline as a new line, and trims trailing blanks', () => {
    expect(text('one\ntwo\r\nthree   \n\n')).toBe('one\ntwo\nthree');
  });

  it('starts a new screen on clear-screen, keeping what came before', () => {
    expect(text('before\x1b[2J\x1b[Hafter')).toBe('before\nafter');
  });

  it('drops OSC strings, keeping a hyperlink’s text, and modes it cannot show', () => {
    expect(text('\x1b]8;;https://example.com\x07link\x1b]8;;\x07 \x1b]0;title\x1b\\x')).toBe('link x');
    expect(text('\x1b[?25l\x1b[?2004hok\x1b[?25h\x1b(B\x1b=')).toBe('ok');
  });

  it('drops an escape sequence cut off at the end, as a live tail ends mid-sequence', () => {
    expect(text('done\x1b[3')).toBe('done');
    expect(text('done\x1b')).toBe('done');
    expect(text('done\x1b]8;;http')).toBe('done');
  });

  it('keeps combined emoji in one cell, so a later column move lands right', () => {
    expect(text('👩‍💻 x\x1b[3Gy')).toBe('👩‍💻 y');
    expect(text('🕒️ z')).toBe('🕒️ z');
  });

  it('maps colors: the 16, 256 and truecolor, bright, inverse and reset', () => {
    expect(renderTerminal('\x1b[31mred\x1b[0m plain')[0]).toEqual([{ text: 'red', fg: '1' }, { text: ' plain' }]);
    expect(renderTerminal('\x1b[1;94mhi\x1b[22;39m')[0]).toEqual([{ text: 'hi', fg: '12', bold: true }]);
    expect(renderTerminal('\x1b[38;5;196ma\x1b[38;5;244mb\x1b[38;5;3mc')[0]).toEqual([
      { text: 'a', fg: '#ff0000' },
      { text: 'b', fg: '#808080' },
      { text: 'c', fg: '3' },
    ]);
    expect(renderTerminal('\x1b[38;2;1;2;3;48:2:255:128:0mx')[0]).toEqual([{ text: 'x', fg: '#010203', bg: '#ff8000' }]);
    expect(renderTerminal('\x1b[7mx\x1b[27my')[0]).toEqual([{ text: 'x', inverse: true }, { text: 'y' }]);
    expect(renderTerminal('\x1b[3;4;2mx\x1b[mY')[0]).toEqual([{ text: 'x', italic: true, underline: true, dim: true }, { text: 'Y' }]);
  });
});
