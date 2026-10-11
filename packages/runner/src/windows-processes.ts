/** PID/parent snapshot without WMI/CIM: that provider has stalled past 30s
 * on Windows CI. PowerShell is only the existing host for these native APIs.
 * https://learn.microsoft.com/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32w
 */
export const WINDOWS_PROCESS_SNAPSHOT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class LobstahProcessSnapshot {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Entry {
    public uint size, usage, pid;
    public UIntPtr heap;
    public uint module, threads, parent;
    public int priority;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string exe;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", ExactSpelling = true, SetLastError = true)]
  static extern bool First(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", EntryPoint = "Process32NextW", ExactSpelling = true, SetLastError = true)]
  static extern bool Next(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  public static void Print() {
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS only
    if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Entry entry = new Entry();
      entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      bool more = First(snapshot, ref entry);
      while (more) {
        Console.WriteLine("{0} {1}", entry.pid, entry.parent);
        more = Next(snapshot, ref entry);
      }
      int error = Marshal.GetLastWin32Error();
      if (error != 18) throw new Win32Exception(error); // ERROR_NO_MORE_FILES
    } finally { CloseHandle(snapshot); }
  }
}
'@
[LobstahProcessSnapshot]::Print()
`;
