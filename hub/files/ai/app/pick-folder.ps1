# The modern Windows "Select folder" window (the Explorer-style one, with the address bar,
# Quick access and This PC). Prints the chosen folder, or nothing if cancelled.
# Started by server.mjs (/api/pick-folder) with -STA. FABRA_PICK_START = the folder to open in.
# Falls back to the older tree window if the modern one can't be created.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$code = @"
using System;
using System.Runtime.InteropServices;
public static class FabraFolderPick {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCo {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, IntPtr types);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attrs);
    void Compare(IShellItem other, uint hint, out int order);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

  public static string Pick(IntPtr owner, string title, string start) {
    IFileDialog d = (IFileDialog)new FileOpenDialogCo();
    uint o; d.GetOptions(out o);
    d.SetOptions(o | 0x20 | 0x40 | 0x800); // pick folders, real folders only, must exist
    d.SetTitle(title);
    d.SetOkButtonLabel("Select folder");
    if (!String.IsNullOrEmpty(start)) {
      try { IShellItem s; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out s); d.SetFolder(s); } catch {}
    }
    if (d.Show(owner) != 0) return null; // cancelled
    IShellItem r; d.GetResult(out r);
    string path; r.GetDisplayName(0x80058000, out path); // the file-system path
    return path;
  }
}
"@

# A hidden window that stays on top, so the folder window opens in front of the app.
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1); $owner.Opacity = 0
$owner.Show(); $owner.Activate()
$start = $env:FABRA_PICK_START
if (-not ($start -and (Test-Path -LiteralPath $start))) { $start = [Environment]::GetFolderPath('MyDocuments') }
$title = 'Choose a folder for Shivo Labs AI to work in'

$picked = $null
try {
  Add-Type -TypeDefinition $code -ErrorAction Stop
  $picked = [FabraFolderPick]::Pick($owner.Handle, $title, $start)
} catch {
  $d = New-Object System.Windows.Forms.FolderBrowserDialog
  $d.Description = $title; $d.ShowNewFolderButton = $true; $d.SelectedPath = $start
  if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $d.SelectedPath }
}
$owner.Close()
if ($picked) { Write-Output $picked }
