import { spawn } from 'node:child_process';
// A fixed, credential-free lifetime wrapper. The broker watches this PID,
// not a short-lived shell tool invocation or the whole terminal application.
const [harness, ...args] = process.argv.slice(2);
if (harness !== 'claude' && harness !== 'codex') throw new Error('hosted trap runner accepts only Claude or Codex');
const child = spawn(harness, args, { stdio: 'inherit', env: { ...process.env, LOBSTAH_WHARF_SESSION_PID: String(process.pid) } });
child.on('error', () => { process.stderr.write('Could not launch the configured trap harness.\n'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
