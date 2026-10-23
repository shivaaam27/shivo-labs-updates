# Shivo Labs X Tools in the Windows notification area (UNIFY-PLAN.md phase 3). Windows PowerShell with Windows' own
# NotifyIcon, so there is no unsigned .exe of ours for Smart App Control to block. Started by the hub (hub/api/tray.mjs).
# Every 3 seconds it asks the hub what to show (GET /api/xtools/tray) and:
#   - lights up (a green dot) when an iPhone or iPad is plugged in or a phone set up for Wi-Fi is near; blue while working;
#   - shows the hub's notices as Windows notifications (a renew finished or failed);
#   - opens a small window only when Apple asks: the 2FA code, replacing a certificate, or signing in again.
# Its menu: Renew now, Install an .ipa..., the apps with their days left, Open X Tools, Open Shivo Labs.
# One copy at a time (exit 3 when another shows the icon). It closes by itself when the hub has been gone 5 minutes.
param(
    [Parameter(Mandatory)][string]$Hub,     # http://localhost:4800
    [Parameter(Mandatory)][string]$Icon,    # hub\shivo-labs.ico
    [Parameter(Mandatory)][string]$Vbs      # hub\Shivo Labs.vbs (opens the hub's window)
)
$ErrorActionPreference = 'Stop'
$mutex = New-Object Threading.Mutex($false, 'Local\ShivoLabsTray')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { exit 3 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

# ---------- talking to the hub
function Get-Hub([string]$path) {
    $r = [Net.WebRequest]::Create("$Hub$path"); $r.Timeout = 4000
    $resp = $r.GetResponse()
    try { $text = (New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8)).ReadToEnd() } finally { $resp.Close() }
    $text | ConvertFrom-Json
}
function Post-Hub([string]$path, $body) {
    $wc = New-Object Net.WebClient
    $wc.Encoding = [Text.Encoding]::UTF8
    $wc.Headers['x-hub'] = '1'; $wc.Headers['content-type'] = 'application/json'
    try { $wc.UploadString("$Hub$path", (ConvertTo-Json $body -Compress)) | ConvertFrom-Json } finally { $wc.Dispose() }
}
function Do-Tray([string]$what, $body = @{}) {
    try {
        $r = Post-Hub "/api/xtools/tray/$what" $body
        if (-not $r.ok) { $tray.ShowBalloonTip(5000, 'X Tools', [string]$r.error, [Windows.Forms.ToolTipIcon]::Warning) }
    } catch { $tray.ShowBalloonTip(5000, 'X Tools', 'Shivo Labs is not answering. Try again in a moment.', [Windows.Forms.ToolTipIcon]::Warning) }
}
function Open-Hub([string]$page) {
    $arg = if ($page) { " /open:$page" } else { '' }
    Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Vbs`"$arg"
}

# ---------- the icon: plain, with a green dot (a device is here) or a blue one (working)
$base = New-Object Drawing.Icon($Icon, (New-Object Drawing.Size(32, 32)))
function New-DotIcon([Drawing.Color]$color) {
    $bmp = New-Object Drawing.Bitmap(32, 32)
    $g = [Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.DrawIcon($base, (New-Object Drawing.Rectangle(0, 0, 32, 32)))
    $g.FillEllipse((New-Object Drawing.SolidBrush([Drawing.Color]::White)), 17, 17, 15, 15)
    $g.FillEllipse((New-Object Drawing.SolidBrush($color)), 19, 19, 11, 11)
    $g.Dispose()
    [Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$icons = @{ plain = $base; here = (New-DotIcon ([Drawing.Color]::FromArgb(52, 199, 89))); busy = (New-DotIcon ([Drawing.Color]::FromArgb(0, 122, 255))) }

$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = $icons.plain
$tray.Text = 'Shivo Labs X Tools'
$tray.Visible = $true
$tray.add_MouseDoubleClick({ Open-Hub 'xtools' })
$tray.add_BalloonTipClicked({ Open-Hub 'xtools' })

$script:state = $null
$script:since = -1        # notices already shown (the first answer only sets it)
$script:failedSince = $null
$script:dialog = $false   # a small window is open: the timer waits

# ---------- small windows, only when Apple asks
function New-Small([string]$title, [int]$h) {
    $f = New-Object Windows.Forms.Form
    $f.Text = $title; $f.Icon = $base; $f.Font = New-Object Drawing.Font('Segoe UI', 10)
    $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false
    $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.ClientSize = New-Object Drawing.Size(360, $h)
    $f
}
function Add-Label($f, [string]$text, [int]$y, [int]$h = 40) {
    $l = New-Object Windows.Forms.Label; $l.Text = $text; $l.SetBounds(16, $y, 328, $h); $f.Controls.Add($l)
}
function Add-Box($f, [int]$y, [bool]$secret = $false) {
    $t = New-Object Windows.Forms.TextBox; $t.SetBounds(16, $y, 328, 28); if ($secret) { $t.UseSystemPasswordChar = $true }; $f.Controls.Add($t); $t
}
function Add-Buttons($f, [int]$y, [string]$okText) {
    $ok = New-Object Windows.Forms.Button; $ok.Text = $okText; $ok.SetBounds(244, $y, 100, 32); $ok.DialogResult = 'OK'
    $no = New-Object Windows.Forms.Button; $no.Text = 'Cancel'; $no.SetBounds(136, $y, 100, 32); $no.DialogResult = 'Cancel'
    $f.Controls.AddRange(@($no, $ok)); $f.AcceptButton = $ok; $f.CancelButton = $no
}
function Show-Ask($ask) {
    if ($ask.kind -eq 'code') {
        $f = New-Small 'Apple sign-in' 150
        Add-Label $f 'Apple sent a 6-digit code to your devices. Type it here.' 14
        $box = Add-Box $f 58
        Add-Buttons $f 102 'Continue'
        $f.add_Shown({ $f.Activate(); $box.Focus() })
        $value = if ($f.ShowDialog() -eq 'OK') { $box.Text.Trim() } else { '' }
        $f.Dispose()
        Do-Tray 'answer' @{ kind = 'code'; value = $value }
    } elseif ($ask.kind -eq 'revoke') {
        $msg = "A free Apple ID holds only a few certificates. Apps signed with the old one stop opening until they are renewed.`n`n$($ask.data.cert)"
        $r = [Windows.Forms.MessageBox]::Show($msg, 'Replace an old certificate?', 'YesNo', 'Question', 'Button1', 'DefaultDesktopOnly')
        Do-Tray 'answer' @{ kind = 'revoke'; value = $(if ($r -eq 'Yes') { 'yes' } else { 'no' }) }
    }
}
function Show-SignIn([string]$email) {
    $f = New-Small 'Sign in to Apple' 236
    Add-Label $f 'X Tools needs your Apple ID again to renew your apps. The password goes to Apple only; it is not kept.' 14 44
    Add-Label $f 'Apple ID' 64 20
    $e = Add-Box $f 86; $e.Text = $email
    Add-Label $f 'Password' 122 20
    $p = Add-Box $f 144 $true
    Add-Buttons $f 188 'Sign in'
    $f.add_Shown({ $f.Activate(); if ($e.Text) { $p.Focus() } else { $e.Focus() } })
    if ($f.ShowDialog() -eq 'OK' -and $e.Text.Trim() -and $p.Text) { Do-Tray 'signin' @{ email = $e.Text.Trim(); password = $p.Text } }
    else { Do-Tray 'signin-later' }
    $p.Text = ''; $f.Dispose()
}

# ---------- the menu, made fresh each time it opens
$menu = New-Object Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
function Add-Item([string]$text, [scriptblock]$onClick, [bool]$enabled = $true, [bool]$bold = $false) {
    $i = New-Object Windows.Forms.ToolStripMenuItem($text)
    $i.Enabled = $enabled
    if ($bold) { $i.Font = New-Object Drawing.Font($i.Font, [Drawing.FontStyle]::Bold) }
    if ($onClick) { $i.add_Click($onClick) }
    [void]$menu.Items.Add($i); $i
}
$menu.add_Opening({
    $menu.Items.Clear()
    $s = $script:state
    if (-not $s) { [void](Add-Item 'Shivo Labs is starting' $null $false); return }
    $d = $s.device; $near = @($s.near)
    $line = if ($d -and $d.untrusted) { "$($d.name): unlock it and tap Trust" } elseif ($d) { "$($d.name) is plugged in" } elseif ($near.Count) { "$($near[0].name) is near (Wi-Fi)" } else { 'No iPhone connected' }
    [void](Add-Item $line $null $false $true)
    if ($s.job) { [void](Add-Item $(if ($s.job.label) { [string]$s.job.label } else { 'Working...' }) $null $false) }
    $ready = (($d -and -not $d.untrusted) -or $near.Count) -and -not $s.job
    [void](Add-Item 'Renew now' { Do-Tray 'renew' } $ready)
    [void](Add-Item 'Install an .ipa...' {
        $o = New-Object Windows.Forms.OpenFileDialog
        $o.Filter = 'iPhone apps (*.ipa)|*.ipa'; $o.InitialDirectory = [Environment]::GetFolderPath('UserProfile') + '\Downloads'
        $script:dialog = $true
        try { if ($o.ShowDialog() -eq 'OK') { Do-Tray 'install' @{ path = $o.FileName } } } finally { $script:dialog = $false; $o.Dispose() }
    } $ready)
    $apps = @($s.apps)
    if ($apps.Count) {
        [void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
        foreach ($a in $apps) {
            $left = if ($null -eq $a.daysLeft) { '' } elseif ($a.daysLeft -le 0) { ': renew now' } elseif ($a.daysLeft -eq 1) { ': 1 day left' } else { ": $($a.daysLeft) days left" }
            $id = [string]$a.bundleId
            $item = Add-Item "$($a.name)$left" { Do-Tray 'renew' @{ bundleId = $this.Tag } } ($ready -and $d -and $a.onDevice -eq $true)
            $item.Tag = $id
        }
    }
    [void]$menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
    [void](Add-Item 'Open X Tools' { Open-Hub 'xtools' })
    [void](Add-Item 'Open Shivo Labs' { Open-Hub '' })
    $_.Cancel = $false
})

# ---------- every 3 seconds
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
    if ($script:dialog) { return }
    try {
        $s = Get-Hub "/api/xtools/tray?since=$([Math]::Max(0, $script:since))"
        $script:failedSince = $null
    } catch {
        if (-not $script:failedSince) { $script:failedSince = Get-Date }
        if (((Get-Date) - $script:failedSince).TotalMinutes -ge 5) { $timer.Stop(); $tray.Visible = $false; [Windows.Forms.Application]::Exit() }
        return
    }
    $script:state = $s
    $d = $s.device; $near = @($s.near)
    $tray.Icon = if ($s.job) { $icons.busy } elseif (($d -and -not $d.untrusted) -or $near.Count) { $icons.here } else { $icons.plain }
    $tip = if ($s.job) { "X Tools: $(if ($s.job.label) { $s.job.label } else { 'working' })" } elseif ($d) { "X Tools: $($d.name) plugged in" } elseif ($near.Count) { "X Tools: $($near[0].name) is near" } else { 'Shivo Labs X Tools' }
    $tray.Text = $tip.Substring(0, [Math]::Min(63, $tip.Length))
    if ($script:since -lt 0) { $script:since = [int]$s.last }
    else {
        $new = @($s.notices)
        if ($new.Count) {
            $n = $new[$new.Count - 1]
            $tray.ShowBalloonTip(6000, [string]$n.title, $(if ($n.text) { [string]$n.text } else { ' ' }), $(if ($n.ok) { [Windows.Forms.ToolTipIcon]::Info } else { [Windows.Forms.ToolTipIcon]::Warning }))
            $script:since = [int]$s.last
        }
    }
    if ($s.ask) { $script:dialog = $true; try { Show-Ask $s.ask } finally { $script:dialog = $false } }
    elseif ($s.signIn) { $script:dialog = $true; try { Show-SignIn ([string]$s.appleId) } finally { $script:dialog = $false } }
})
$timer.Start()
[Windows.Forms.Application]::Run()
$tray.Visible = $false; $tray.Dispose()
try { $mutex.ReleaseMutex() } catch { }
