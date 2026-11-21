import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Fields used from Claude Code's append-only transcript; all other content stays opaque. */
interface ClaudeTranscriptRecord {
  type?: string;
  sessionId?: string;
  operation?: string;
  content?: string;
  message?: { content?: unknown };
}

/** A Bash call recorded before its task-notification is queued. */
interface ClaudeBashCall {
  type?: string;
  id?: string;
  name?: string;
  input?: { command?: string };
}

/** The listener itself must never wake a park when it exits. */
function isParkCommand(command: string): boolean {
  return /\blobstah\s+(?:soak\b[^\n]*--wait\b|hook\s+stop\b|man\s+wait\b)/.test(command);
}

/**
 * Read only this Stop hook's transcript, once at entry and incrementally on
 * the park's normal poll. Claude queues task notifications before delivering
 * them, even while Stop is blocked. Historical completions seed the dedup set
 * but never wake; attachments and queue removals never count as completions.
 * No session files are changed and no descriptor is held between polls.
 */
export class ClaudeTaskCompletions {
  private offset = 0;
  private pending = '';
  private decoder = new StringDecoder('utf8');
  private identity?: string;
  private readonly completed = new Set<string>();
  private readonly parkCalls = new Set<string>();

  constructor(private readonly transcriptPath: string, private readonly sessionId: string) {
    this.readNewRecords(true);
  }

  /** Consume new terminal task enqueues, returning true once for each batch. */
  poll(): boolean {
    return this.readNewRecords(false);
  }

  private consume(line: string, baseline: boolean): boolean {
    // Most transcript records are unrelated (and can contain large prompts).
    if (!line.includes('queue-operation') && !line.includes('tool_use')) return false;
    let record: ClaudeTranscriptRecord;
    try { record = JSON.parse(line) as ClaudeTranscriptRecord; } catch { return false; }
    if (!record || record.sessionId !== this.sessionId) return false;
    if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
      for (const value of record.message.content) {
        if (!value || typeof value !== 'object') continue;
        const call = value as ClaudeBashCall;
        if (call.type === 'tool_use' && call.name === 'Bash' && typeof call.id === 'string' &&
            typeof call.input?.command === 'string' && isParkCommand(call.input.command)) this.parkCalls.add(call.id);
      }
    }
    if (record.type !== 'queue-operation' || record.operation !== 'enqueue' || typeof record.content !== 'string') return false;
    const notification = /^<task-notification>\s*([\s\S]*?)\s*<\/task-notification>\s*$/.exec(record.content)?.[1];
    if (!notification || !/<status>(?:completed|failed|killed)<\/status>/.test(notification)) return false;
    const taskId = /<task-id>([^<]+)<\/task-id>/.exec(notification)?.[1];
    const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notification)?.[1];
    if (!taskId || this.completed.has(taskId)) return false;
    this.completed.add(taskId);
    return !baseline && (!toolUseId || !this.parkCalls.has(toolUseId));
  }

  private readNewRecords(baseline: boolean): boolean {
    let fd: number | undefined;
    let woke = false;
    try {
      fd = fs.openSync(this.transcriptPath, 'r');
      const stat = fs.fstatSync(fd);
      const identity = `${stat.dev}:${stat.ino}`;
      if ((this.identity !== undefined && this.identity !== identity) || stat.size < this.offset) {
        // A replaced/truncated transcript is history again, never a new task.
        this.offset = 0;
        this.pending = '';
        this.decoder = new StringDecoder('utf8');
        baseline = true;
      }
      this.identity = identity;
      if (this.offset === stat.size) return false;
      const buffer = Buffer.alloc(64 * 1024);
      while (this.offset < stat.size) {
        const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - this.offset), this.offset);
        if (!count) break;
        this.offset += count;
        const lines = (this.pending + this.decoder.write(buffer.subarray(0, count))).split('\n');
        this.pending = lines.pop()!;
        for (const line of lines) woke = this.consume(line, baseline) || woke;
      }
    } catch {
      // Missing/unreadable transcripts leave inbox and turn waits working.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    return woke;
  }
}
