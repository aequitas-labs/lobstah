// TEMPORARY diagnostic (removed before merge): where does a cold Windows
// process snapshot spend its time? Order comes from argv: "addtype-first" or
// "emit-first".
import { execFileSync } from 'node:child_process';
import { WINDOWS_PROCESS_SNAPSHOT } from '../packages/runner/dist/windows-processes.js';

const EMIT = String.raw`
$ErrorActionPreference = 'Stop'
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object System.Reflection.AssemblyName 'LobstahProcessSnapshot'), [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
$type = $assembly.DefineDynamicModule('LobstahProcessSnapshot').DefineType('LobstahToolHelp', [System.Reflection.TypeAttributes]'Public, Class')
function Import([string]$name, [Type]$returns, [Type[]]$takes) {
  [void]$type.DefinePInvokeMethod($name, 'kernel32.dll', [System.Reflection.MethodAttributes]'Public, Static, PinvokeImpl',
    [System.Reflection.CallingConventions]::Standard, $returns, $takes,
    [System.Runtime.InteropServices.CallingConvention]::Winapi, [System.Runtime.InteropServices.CharSet]::Unicode)
}
Import 'CreateToolhelp32Snapshot' ([IntPtr]) @([UInt32], [UInt32])
Import 'Process32FirstW' ([bool]) @([IntPtr], [IntPtr])
Import 'Process32NextW' ([bool]) @([IntPtr], [IntPtr])
Import 'CloseHandle' ([bool]) @([IntPtr])
$k = $type.CreateType()
$snapshot = $k::CreateToolhelp32Snapshot(2, 0)
if ($snapshot.ToInt64() -eq -1) { throw 'CreateToolhelp32Snapshot failed' }
$wide = [IntPtr]::Size -eq 8
$size = if ($wide) { 568 } else { 556 }
$parentAt = if ($wide) { 32 } else { 24 }
$entry = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($size)
try {
  [System.Runtime.InteropServices.Marshal]::WriteInt32($entry, 0, $size)
  $lines = New-Object System.Text.StringBuilder
  $more = $k::Process32FirstW($snapshot, $entry)
  while ($more) {
    [void]$lines.AppendLine(('{0} {1}' -f [System.Runtime.InteropServices.Marshal]::ReadInt32($entry, 8), [System.Runtime.InteropServices.Marshal]::ReadInt32($entry, $parentAt)))
    $more = $k::Process32NextW($snapshot, $entry)
  }
  [Console]::Out.Write($lines.ToString())
} finally {
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($entry)
  [void]$k::CloseHandle($snapshot)
}
`;

const ps = (script) => {
  const t = Date.now();
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { ms: Date.now() - t, out };
};
const rows = (out) => out.split(/\r?\n/).map((l) => l.trim().split(/\s+/).map(Number)).filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b));
const check = (label, out) => {
  const r = rows(out);
  const me = r.find(([pid]) => pid === process.pid);
  return `${label}: ${r.length} rows, own row ${me ? `${me[0]} parent ${me[1]} (node says ${process.ppid})` : 'MISSING'}`;
};

const order = process.argv[2] === 'emit-first' ? ['emit', 'addtype'] : ['addtype', 'emit'];
const first = ps('1');
console.log(`powershell "1" (cold): ${first.ms} ms`);
console.log(`powershell "1" (warm): ${ps('1').ms} ms`);
for (const which of order) {
  for (let i = 1; i <= 3; i++) {
    const r = ps(which === 'emit' ? EMIT : WINDOWS_PROCESS_SNAPSHOT);
    console.log(`${which} #${i}: ${r.ms} ms; ${check(which, r.out)}`);
  }
}
