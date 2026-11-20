import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordToolProjects, shellCommandText, toolProjectEnv, toolProjectsInCommand } from '../src/index.js';
import { removeTempDir } from '../../../test/temp-dir.js';

const SESSION = '423bfb38-4469-4c2b-b1bb-4cafa3928878';
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lobstah-tool-project-')); process.env.LOBSTAH_HOME = home; });
afterEach(() => { delete process.env.LOBSTAH_HOME; removeTempDir(home); });

describe('toolProjectsInCommand', () => {
  it("reads a tool's project set inline before that tool, as Claude Code's shell wraps it too", () => {
    expect(toolProjectsInCommand('UME_PROJECT=vr95mce908 ume await --watch dbbd03aa-434')).toEqual([{ tool: 'ume', variable: 'UME_PROJECT', value: 'vr95mce908' }]);
    expect(toolProjectsInCommand("eval 'UME_PROJECT=vr95mce908 UME_LAX_FLAGS=1 ume-next feedback a1' < /dev/null")).toEqual([{ tool: 'ume', variable: 'UME_PROJECT', value: 'vr95mce908' }]);
  });

  it('ignores a project set for another command, an exported one, and a value with shell syntax', () => {
    expect(toolProjectsInCommand('GOOGLE_CLOUD_PROJECT=p gcloud run deploy')).toEqual([]);
    expect(toolProjectsInCommand('UME_PROJECT=x node script.js')).toEqual([]);
    expect(toolProjectsInCommand('export UME_PROJECT=x; ume await a1')).toEqual([]);
    expect(toolProjectsInCommand('UME_PROJECT=$(cat p) ume await a1')).toEqual([]);
  });
});

describe('recordToolProjects and toolProjectEnv', () => {
  it("gives a session's wait from a tool the project its last inline call named", () => {
    expect(toolProjectEnv(SESSION, 'ume')).toEqual({});
    recordToolProjects(SESSION, 'UME_PROJECT=ourrwyi8p5 ume sets');
    recordToolProjects(SESSION, 'git status');
    recordToolProjects(SESSION, 'UME_PROJECT=vr95mce908 ume await --watch dbbd03aa-434');
    expect(toolProjectEnv(SESSION, 'ume')).toEqual({ UME_PROJECT: 'vr95mce908' });
    expect(toolProjectEnv('another-session', 'ume')).toEqual({});
    expect(toolProjectEnv(SESSION, 'review-tool')).toEqual({});
  });

  it("reads Claude Code's and Codex's shell tool inputs", () => {
    expect(shellCommandText({ command: 'ume sets' })).toBe('ume sets');
    expect(shellCommandText({ command: ['bash', '-lc', 'UME_PROJECT=p ume sets'] })).toBe('bash -lc UME_PROJECT=p ume sets');
    expect(shellCommandText({ file_path: '/x' })).toBeUndefined();
  });
});
