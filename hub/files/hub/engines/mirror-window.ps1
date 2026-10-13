# Shivo Labs Mirror - the floating iPhone window. A real window (no browser frame, no address),
# always on top, shaped like the phone. Windows PowerShell hosts it with Microsoft's own signed
# WebView2 files, so there is no unsigned .exe or .dll of ours for Smart App Control to block.
# The hub server starts it when a phone connects; the page inside is the hub's /mirror-float.html.
# The page talks to this window with postMessage: {cmd:'drag'}, {cmd:'close'}, {cmd:'aspect', w, h}.
param(
    [Parameter(Mandatory)] [string]$Url,
    [Parameter(Mandatory)] [string]$Lib,        # folder with Microsoft.Web.WebView2.Core.dll and .Wpf.dll (net462)
    [string]$Loader = $Lib,                     # folder with WebView2Loader.dll (x64)
    [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'Shivo Labs\mirror'),
    [string]$Icon = '',
    [int]$Height = 860,
    [double]$Aspect = 0.4615                    # width / height of the phone picture
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -Path (Join-Path $Lib 'Microsoft.Web.WebView2.Core.dll')
Add-Type -Path (Join-Path $Lib 'Microsoft.Web.WebView2.Wpf.dll')
[Microsoft.Web.WebView2.Core.CoreWebView2Environment]::SetLoaderDllFolderPath($Loader)
Add-Type -Namespace SL -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ReleaseCapture();
[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
'@

$border = 6   # a thin dark edge to grab for resizing (the picture itself is for dragging)
$aspect = $Aspect
$work = [Windows.SystemParameters]::WorkArea

$window = New-Object Windows.Window
$window.Title = 'Shivo Labs Mirror'
$window.WindowStyle = 'None'
$window.ResizeMode = 'CanResize'
$window.Topmost = $true
$window.ShowInTaskbar = $true
$window.Background = New-Object Windows.Media.SolidColorBrush ([Windows.Media.Color]::FromRgb(0x0B, 0x0B, 0x0C))
$window.Height = [Math]::Min($Height, $work.Height - 40)
$window.Width = [Math]::Round(($window.Height - 2 * $border) * $aspect) + 2 * $border
$window.Left = $work.Right - $window.Width - 24
$window.Top = $work.Top + 24
$window.MinWidth = 120; $window.MinHeight = 120
if ($Icon -and (Test-Path $Icon)) { try { $window.Icon = [Windows.Media.Imaging.BitmapFrame]::Create([Uri]$Icon) } catch { } }
# no title bar, but Windows still lets the edges resize it
$chrome = New-Object Windows.Shell.WindowChrome
$chrome.CaptionHeight = 0
$chrome.ResizeBorderThickness = New-Object Windows.Thickness $border
$chrome.GlassFrameThickness = New-Object Windows.Thickness 0
$chrome.CornerRadius = New-Object Windows.CornerRadius 0
[Windows.Shell.WindowChrome]::SetWindowChrome($window, $chrome)

$web = New-Object Microsoft.Web.WebView2.Wpf.WebView2
$web.Margin = New-Object Windows.Thickness $border
$web.DefaultBackgroundColor = [Drawing.Color]::FromArgb(0x0B, 0x0B, 0x0C)
$web.CreationProperties = New-Object Microsoft.Web.WebView2.Wpf.CoreWebView2CreationProperties
$web.CreationProperties.UserDataFolder = Join-Path $DataDir 'window'
$window.Content = $web

# keep the window the phone's shape: fit the picture area to the aspect after a resize
$fitting = $false
function Fit-Aspect([bool]$byHeight) {
    if ($script:fitting) { return }
    $script:fitting = $true
    try {
        if ($byHeight) { $window.Width = [Math]::Round(($window.Height - 2 * $border) * $script:aspect) + 2 * $border }
        else { $window.Height = [Math]::Round(($window.Width - 2 * $border) / $script:aspect) + 2 * $border }
    } finally { $script:fitting = $false }
}
$window.add_SizeChanged({ param($s, $e) if ($e.HeightChanged -and -not $e.WidthChanged) { Fit-Aspect $true } elseif ($e.WidthChanged -and -not $e.HeightChanged) { Fit-Aspect $false } })

$web.add_CoreWebView2InitializationCompleted({
    param($s, $e)
    if (-not $e.IsSuccess) { [Windows.MessageBox]::Show("The Mirror window could not start.`n`n$($e.InitializationException.Message)", 'Shivo Labs') | Out-Null; $window.Close(); return }
    $core = $web.CoreWebView2
    $core.Settings.AreDefaultContextMenusEnabled = $false
    $core.Settings.IsZoomControlEnabled = $false
    $core.Settings.IsStatusBarEnabled = $false
    $core.Settings.AreDevToolsEnabled = $false
    $core.add_NewWindowRequested({ param($s, $e) $e.Handled = $true })
    $core.add_WebMessageReceived({
        param($s, $e)
        try { $m = $e.WebMessageAsJson | ConvertFrom-Json } catch { return }
        switch ([string]$m.cmd) {
            'drag' {   # move the window like a title bar would
                $h = (New-Object Windows.Interop.WindowInteropHelper $window).Handle
                [void][SL.Win]::ReleaseCapture(); [void][SL.Win]::SendMessage($h, 0xA1, [IntPtr]2, [IntPtr]::Zero)
            }
            'close' { $window.Close() }
            'aspect' {   # the phone turned: keep the same height for upright, the same width for sideways
                $a = [double]$m.w / [double]$m.h
                if ($a -gt 0 -and [Math]::Abs($a - $script:aspect) -gt 0.01) {
                    $wasUpright = $script:aspect -lt 1
                    $script:aspect = $a
                    $script:fitting = $true
                    try {
                        if ($a -lt 1) { $window.Height = [Math]::Min(860, $work.Height - 40); $window.Width = [Math]::Round(($window.Height - 2 * $border) * $a) + 2 * $border }
                        else { $window.Width = [Math]::Min(1100, $work.Width - 40); $window.Height = [Math]::Round(($window.Width - 2 * $border) / $a) + 2 * $border }
                        if ($window.Left + $window.Width -gt $work.Right) { $window.Left = [Math]::Max($work.Left, $work.Right - $window.Width - 24) }
                        if ($window.Top + $window.Height -gt $work.Bottom) { $window.Top = [Math]::Max($work.Top, $work.Bottom - $window.Height - 24) }
                    } finally { $script:fitting = $false }
                }
            }
        }
    })
    $core.Navigate($Url)
})

$window.add_Loaded({ [void]$web.EnsureCoreWebView2Async($null) })
[void]$window.ShowDialog()
[Environment]::Exit(0)
