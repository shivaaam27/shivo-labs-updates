# Gives the Shivo Labs AI window and its shortcuts one shared taskbar ID,
# so the pinned taskbar icon and the open window are the same icon.
param([string]$Id = "FabraLabs.AI", [int]$WaitSeconds = 30)
$code = @'
using System; using System.Runtime.InteropServices; using System.Diagnostics; using System.Text;
public static class FabraAumid {
 [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPropertyStore { int GetCount(out uint c); int GetAt(uint i, out PK k); int GetValue(ref PK k, out PV v); int SetValue(ref PK k, ref PV v); int Commit(); }
 [StructLayout(LayoutKind.Sequential, Pack=4)] struct PK { public Guid f; public uint p; }
 [StructLayout(LayoutKind.Explicit)] struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
 [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
 interface IPersistFile { void GetClassID(out Guid g); [PreserveSig] int IsDirty(); void Load([MarshalAs(UnmanagedType.LPWStr)] string f, uint m); void Save([MarshalAs(UnmanagedType.LPWStr)] string f, bool r); void SaveCompleted(string f); void GetCurFile(out IntPtr f); }
 [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IPropertyStore ps);
 delegate bool EW(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(EW cb, IntPtr l);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 static PK Key(){ return new PK{ f=new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), p=5 }; }
 static void Set(IPropertyStore ps, string id){ PK k=Key(); PV v=new PV{ vt=31, p=Marshal.StringToCoTaskMemUni(id) }; ps.SetValue(ref k, ref v); ps.Commit(); }
 public static int TagWindows(string id){ int n=0; EnumWindows((h,l)=>{ if(!IsWindowVisible(h)) return true; uint pid; GetWindowThreadProcessId(h,out pid); string name; try{ name=Process.GetProcessById((int)pid).ProcessName; }catch{ return true; } if(name!="msedge") return true; var t=new StringBuilder(256); GetWindowText(h,t,256); if(!t.ToString().StartsWith("Shivo Labs AI") && !t.ToString().StartsWith("Fabra Labs AI")) return true; Guid g=new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"); IPropertyStore ps; if(SHGetPropertyStoreForWindow(h, ref g, out ps)==0){ Set(ps,id); n++; } return true; }, IntPtr.Zero); return n; }
 public static void TagShortcut(string path, string id){ var link=(IPersistFile)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"))); link.Load(path, 2); Set((IPropertyStore)link, id); link.Save(path, true); }
}
'@
Add-Type $code
# Shortcuts that open this app get the same ID (only if they point at this app).
$sh = New-Object -ComObject WScript.Shell
$places = "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:USERPROFILE\Desktop"
foreach ($p in $places) { Get-ChildItem $p -Filter "*Labs AI*.lnk" -EA 0 | % {
  if ($sh.CreateShortcut($_.FullName).Arguments -like "*Fabra Labs AI.vbs*") { try { [FabraAumid]::TagShortcut($_.FullName, $Id) } catch {} } } }
# Wait for the app window and tag it.
$end = (Get-Date).AddSeconds($WaitSeconds)
do { if ([FabraAumid]::TagWindows($Id) -gt 0) { break }; Start-Sleep -Milliseconds 300 } while ((Get-Date) -lt $end)
