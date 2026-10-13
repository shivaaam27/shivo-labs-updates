# Fabra Labs engine: setup, the Fabra Labs Linux, xtool, .ipa files and saved state.
# Runs inside Windows PowerShell (signed by Microsoft), so Smart App Control lets it
# run - the same path as the "Renew iPhone Apps" script. Lessons from 10 Oct 2026:
# xtool exits 0 even when it fails (we look for its success line), the first
# install can fail with "no current IOS devices" (we retry once), and a free
# account may need an old certificate revoked (we ask first).
# Expects $sync (shared with the window): Out queue, Answers, Cancel, Proc.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$EngineDir  = $PSScriptRoot
$Distro     = 'FabraLabs'
$DataDir    = Join-Path $env:LOCALAPPDATA 'Fabra Labs'
$AppsDir    = Join-Path $DataDir 'apps'
$StatePath  = Join-Path $DataDir 'state.json'
$UbuntuBase = 'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.5-base-amd64.tar.gz'
$AppleService = 'Apple Mobile Device Service'
$AppleDevicesStoreId = '9NP83LWLPZ9K'   # "Apple Devices" in the Microsoft Store
$RegisterRace = 'no current IOS devices'

# ---------- talking to the window ----------

function Send-Json($obj) { $sync.Out.Enqueue(($obj | ConvertTo-Json -Compress -Depth 8)) }
function Emit($evt, $data) { Send-Json @{ event = $evt; data = $data } }
function Check-Cancel { if ($sync.Cancel) { throw (New-Object OperationCanceledException) } }

# Shows a question in the window (2FA code, revoke) and waits for the answer.
function Ask($kind, $data) {
    $sync.Answers.Remove($kind)
    Emit 'ask' @{ kind = $kind; data = $data }
    while (-not $sync.Answers.ContainsKey($kind)) {
        if ($sync.Cancel) { return $null }
        Start-Sleep -Milliseconds 100
    }
    $v = $sync.Answers[$kind]; $sync.Answers.Remove($kind); $v
}

# ---------- Linux (WSL) ----------

function Q-Win([string]$s) { '"' + $s.Replace('\', '\\').Replace('"', '\"') + '"' }
function Q-Bash([string]$s) { "'" + $s.Replace("'", "'\''") + "'" }
function ConvertTo-LinuxPath([string]$p) {
    $f = [IO.Path]::GetFullPath($p)
    '/mnt/' + $f.Substring(0, 1).ToLower() + $f.Substring(2).Replace('\', '/')
}

function New-WslInfo([string]$ArgLine, [bool]$Stdin) {
    $psi = New-Object Diagnostics.ProcessStartInfo 'wsl.exe', $ArgLine
    $psi.RedirectStandardInput = $Stdin
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.WorkingDirectory = $env:USERPROFILE
    $psi.EnvironmentVariables['WSL_UTF8'] = '1'   # wsl.exe's own messages in UTF-8, not UTF-16
    $psi
}

# Runs wsl.exe and returns its exit code and output; $OnLine sees each line as it arrives.
function Invoke-Wsl([string]$ArgLine, [scriptblock]$OnLine) {
    $proc = [Diagnostics.Process]::Start((New-WslInfo $ArgLine $false))
    $sync.Proc = $proc
    $err = $proc.StandardError.ReadToEndAsync()
    $sb = New-Object Text.StringBuilder
    try {
        while ($null -ne ($line = $proc.StandardOutput.ReadLine())) {
            [void]$sb.AppendLine($line)
            if ($OnLine) { & $OnLine $line }
        }
    } catch {
        # Never leave a Linux command running behind an error.
        try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
        $sync.Proc = $null
        throw
    }
    $proc.WaitForExit()
    [void]$sb.Append($err.Result)
    $sync.Proc = $null
    Check-Cancel
    [pscustomobject]@{ Code = $proc.ExitCode; Out = $sb.ToString().Replace("`0", '') }
}

# A bash command as root inside the Fabra Labs Linux.
function Invoke-Sh([string]$Command, [scriptblock]$OnLine) {
    Invoke-Wsl "-d $Distro -u root --cd / -- bash -c $(Q-Win $Command)" $OnLine
}

function Test-Wsl { try { (Invoke-Wsl '--status').Code -eq 0 } catch { $false } }

function Test-DistroListed { ((Invoke-Wsl '-l -q').Out -split "`n" | ForEach-Object { $_.Trim() }) -contains $Distro }

function Test-Distro {
    try {
        if (-not (Test-DistroListed)) { return $false }
        (Invoke-Sh 'test -x /usr/local/bin/xtool && test -f /etc/fabra-ready').Code -eq 0
    } catch { $false }
}

# The iPhone bridge, exactly as the Renew iPhone Apps script does it: socat on
# /var/run/usbmuxd relays to Windows' Apple Mobile Device Service on
# 127.0.0.1:27015 (reachable because WSL networking is mirrored). Left alone when
# already running, so checking for a device never cuts off an install.
function Start-Bridge {
    [void](Invoke-Sh 'pgrep -x socat >/dev/null && test -S /var/run/usbmuxd && exit 0; pkill -x usbmuxd; pkill -x socat; rm -f /var/run/usbmuxd; (setsid socat UNIX-LISTEN:/var/run/usbmuxd,fork,mode=777 TCP:127.0.0.1:27015 >/dev/null 2>&1 &); sleep 1')
}

# The bridge needs WSL's mirrored networking. Returns $true if we had to turn it on.
function Set-MirroredNetworking {
    $cfg = Join-Path $env:USERPROFILE '.wslconfig'
    $text = if (Test-Path $cfg) { [IO.File]::ReadAllText($cfg) } else { '' }
    if ($text -match '(?im)^\s*networkingMode\s*=\s*mirrored') { return $false }
    if ($text -match '(?im)^\s*networkingMode\s*=') { $text = $text -replace '(?im)^\s*networkingMode\s*=.*$', 'networkingMode=mirrored' }
    elseif ($text -match '(?im)^\[wsl2\]') { $text = $text -replace '(?im)^\[wsl2\]\s*$', "[wsl2]`r`nnetworkingMode=mirrored" }
    else { $text = $text.TrimEnd() + "`r`n[wsl2]`r`nnetworkingMode=mirrored`r`n" }
    [IO.File]::WriteAllText($cfg, $text.TrimStart())
    $true
}

# ---------- setup ----------

function Test-Apple {
    try {
        $s = Get-Service $AppleService
        if ($s.Status -ne 'Running') { try { Start-Service $AppleService; $s.WaitForStatus('Running', '00:00:10') } catch { } ; $s.Refresh() }
        $s.Status -eq 'Running'
    } catch { $false }
}

function Get-SetupStatus {
    $wsl = Test-Wsl
    $engine = $wsl -and (Test-Distro)
    @{ wsl = $wsl; engine = $engine; apple = (Test-Apple) }
}

# Turns on WSL (admin prompt). Returns $true when Windows must restart first.
function Install-Wsl {
    Start-Process wsl.exe '--install --no-distribution' -Verb RunAs -Wait -WindowStyle Hidden
    if (Test-Wsl) { return $false }
    # Reopen the app after the restart so setup carries on by itself.
    # Inside the Shivo Labs hub, SHIVO_REOPEN opens the hub on X Tools instead of the old X Tools window.
    $launch = if ($env:SHIVO_REOPEN) { $env:SHIVO_REOPEN } else { 'conhost.exe --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "' + (Join-Path $EngineDir 'FabraLabs.ps1') + '"' }
    New-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Force | Out-Null
    Set-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' 'FabraLabs' $launch
    $true
}

function Install-Engine([scriptblock]$Progress) {
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    $tar = Join-Path $DataDir 'ubuntu-base.tar.gz'

    & $Progress 5 'Downloading Linux'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $res = [Net.WebRequest]::Create($UbuntuBase).GetResponse()
    $total = if ($res.ContentLength -gt 0) { $res.ContentLength } else { 30000000 }
    $src = $res.GetResponseStream(); $dst = [IO.File]::Create($tar)
    try {
        $buf = New-Object byte[] 81920; $done = 0; $last = -1
        while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) {
            $dst.Write($buf, 0, $n); $done += $n
            Check-Cancel
            $pct = 5 + [int][Math]::Floor(25 * $done / $total)
            if ($pct -ne $last) { $last = $pct; & $Progress $pct 'Downloading Linux' }
        }
    } finally { $dst.Close(); $src.Close(); $res.Close() }

    & $Progress 32 'Preparing Linux'
    if (Test-DistroListed) { [void](Invoke-Wsl "--unregister $Distro") }
    $dir = Join-Path $DataDir 'linux'
    New-Item -ItemType Directory -Force $dir | Out-Null
    $r = Invoke-Wsl "--import $Distro `"$dir`" `"$tar`" --version 2"
    if ($r.Code -ne 0) { throw ('Linux import failed: ' + $r.Out.Trim()) }
    Remove-Item $tar -Force

    $script = ConvertTo-LinuxPath (Join-Path $EngineDir 'provision.sh')
    $labels = @{ '1/5' = @(36, 'Preparing Linux'); '2/5' = @(42, 'Getting tools'); '3/5' = @(50, 'Installing tools'); '4/5' = @(78, 'Installing xtool'); '5/5' = @(95, 'Finishing') }
    $r = Invoke-Sh "tr -d '\r' < $(Q-Bash $script) > /tmp/provision.sh && bash /tmp/provision.sh" {
        param($line)
        if ($line.StartsWith('STEP ') -and $line.Length -ge 8) { $s = $labels[$line.Substring(5, 3)]; if ($s) { & $Progress $s[0] $s[1] } }
    }
    if ($r.Code -ne 0 -or -not $r.Out.Contains('DONE')) {
        throw ("Linux setup failed:`n" + (($r.Out.Trim() -split "`n" | Select-Object -Last 6) -join "`n"))
    }
    [void](Invoke-Wsl "--terminate $Distro")   # apply wsl.conf
    & $Progress 100 'Done'
}

function Install-Apple {
    Start-Process winget.exe "install --id $AppleDevicesStoreId -s msstore -e --accept-package-agreements --accept-source-agreements --silent" -Wait -WindowStyle Hidden
    for ($i = 0; $i -lt 10 -and -not (Test-Apple); $i++) { Start-Sleep -Milliseconds 1500; Check-Cancel }
    if (-not (Test-Apple)) { throw 'Apple''s iPhone drivers could not be installed. Install "Apple Devices" from the Microsoft Store, then try again.' }
}

function Invoke-Setup {
    $sync.Cancel = $false
    $SetupProgress = { param($step, $pct, $label) Emit 'setup' @{ step = $step; pct = $pct; label = $label } }

    if (-not (Test-Wsl)) {
        & $SetupProgress 'wsl' 10 'Turning on Linux for Windows'
        if (Install-Wsl) { [void](Set-MirroredNetworking); return @{ restart = $true } }
    }
    if (Set-MirroredNetworking) { [void](Invoke-Wsl '--shutdown') }   # new setting applies after a restart of WSL
    & $SetupProgress 'wsl' 100 'Ready'

    if (-not (Test-Distro)) { Install-Engine { param($pct, $label) & $SetupProgress 'engine' $pct $label } }
    & $SetupProgress 'engine' 100 'Ready'

    if (-not (Test-Apple)) { & $SetupProgress 'apple' 30 'Installing Apple Devices'; Install-Apple }
    & $SetupProgress 'apple' 100 'Ready'
    @{ restart = $false }
}

# ---------- xtool ----------

function Get-FirstDevice {
    $r = Invoke-Sh 'timeout 15 xtool devices --no-wait 2>&1'
    # e.g. "Shivam's iPhone [usb]: 00008140-000C11410E8B001C"
    foreach ($line in $r.Out -split "`n") {
        if ($line.Trim() -match '^(.+?) \[(\w+)\]: ([0-9A-Fa-f-]{20,})$') {
            return @{ name = $Matches[1].Replace([string][char]0x2019, "'"); udid = $Matches[3]; link = $Matches[2] }
        }
    }
    $null
}

function Get-SignedIn {
    $r = Invoke-Sh 'xtool auth status 2>&1'
    if ($r.Out -match '(?i)Logged out') { return $null }
    if ($r.Out -match 'Apple ID:\s*(\S+)') { return $Matches[1] }
    $null
}

# A running xtool with stdin open, for its prompts. Prompts have no newline, so we read chunks.
function Start-Session([string]$Command) {
    $p = [Diagnostics.Process]::Start((New-WslInfo "-d $Distro -u root --cd / -- bash -c $(Q-Win $Command)" $true))
    $sync.Proc = $p
    [pscustomobject]@{ P = $p; All = (New-Object Text.StringBuilder); Err = $p.StandardError.ReadToEndAsync(); Buf = (New-Object char[] 4096); Pending = $null }
}
# Waits for the next output. With -Timeout, throws 'stalled' after that many quiet
# seconds; Cancel is noticed even while xtool prints nothing.
function Read-Chunk($s, [int]$Timeout = 0) {
    if (-not $s.Pending) { $s.Pending = $s.P.StandardOutput.ReadAsync($s.Buf, 0, $s.Buf.Length) }
    $quiet = 0
    while (-not $s.Pending.Wait(500)) {
        Check-Cancel
        $quiet += 0.5
        if ($Timeout -gt 0 -and $quiet -ge $Timeout) { throw 'stalled' }
    }
    $n = $s.Pending.Result; $s.Pending = $null
    if ($n -le 0) { Check-Cancel; return $null }
    $str = New-Object string -ArgumentList $s.Buf, 0, $n
    [void]$s.All.Append($str)
    $str
}
function Get-Tail($s) { $t = $s.All.ToString(); if ($t.Length -gt 600) { $t.Substring($t.Length - 600) } else { $t } }
function Send-Line($s, [string]$line) { $s.P.StandardInput.Write($line + "`n"); $s.P.StandardInput.Flush() }
function Stop-Session($s) {
    try { if (-not $s.P.HasExited) { $s.P.Kill() } } catch { }
    try { if ($s.Err.Wait(1000)) { [void]$s.All.Append($s.Err.Result) } } catch { }
    $sync.Proc = $null
    # Killing wsl.exe leaves xtool running inside Linux, holding the iPhone, and
    # every later install then sits on "Preparing". Stop it too.
    Stop-LinuxXtool
}
function Stop-LinuxXtool {
    try { [void](Invoke-Sh "pkill -f '^script -qfec xtool'; pkill -f '^xtool (install|auth)'; true") } catch { }
}

function Get-XtoolError([string]$text) { if ($text -match 'Error:\s*([^\r\n]+)') { $Matches[1].Trim() } else { $null } }

# xtool's messages, in plain words.
function Get-Friendly([string]$err) {
    if ($err.Contains($RegisterRace)) { return $RegisterRace }
    if ($err.Contains('muxError') -or $err.Contains('Mux')) { return 'Lost the connection to the iPhone. Unplug it, plug it back in, unlock it and try again.' }
    if ($err -match '(?i)log in') { return 'Sign in with your Apple ID first.' }
    if ($err -match '(?i)incorrect|credentials' -or $err.Contains('-22406')) { return 'Apple ID or password is incorrect.' }
    if ($err -match '(?i)maximum number of apps' -or $err.Contains('3 apps')) { return 'A free Apple ID allows 3 apps at a time. Delete one from the iPhone, then try again.' }
    if ($err -cmatch 'App ID' -and $err -match '(?i)limit') { return 'A free Apple ID allows 10 new apps per week. Try again in a few days, or reinstall an existing app.' }
    if ($err.Length -gt 300) { return $err.Substring(0, 300) + '...' }
    $err
}

# Signs in. The password is typed into xtool's prompt, never on a command line or stored.
function Invoke-SignIn([string]$Email, [string]$Password) {
    $sync.Cancel = $false
    $s = Start-Session "script -qfec $(Q-Bash "xtool auth login -m password -u $(Q-Bash $Email)") /dev/null"
    try {
        $sentPassword = $false; $sentCode = $false
        while ($null -ne (Read-Chunk $s)) {
            $tail = Get-Tail $s
            if (-not $sentPassword -and $tail.TrimEnd().EndsWith('Password:')) { $sentPassword = $true; Send-Line $s $Password; continue }
            if (-not $sentCode -and $tail -match 'Code:\s*$') {
                $sentCode = $true
                $code = Ask 'code' $null
                if ([string]::IsNullOrWhiteSpace($code)) { throw (New-Object OperationCanceledException) }
                Send-Line $s $code.Trim(); continue
            }
            if ($tail.Contains('Logged in.')) { return }
            $e = Get-XtoolError $tail; if ($e) { throw (Get-Friendly $e) }
        }
        $e = Get-XtoolError $s.All.ToString()
        throw (Get-Friendly $(if ($e) { $e } else { 'Sign-in stopped unexpectedly.' }))
    } finally { Stop-Session $s }
}

$Stages = @(
    @('Unpacking app', 0, 10, 'Preparing'), @('Preparing device', 10, 20, 'Preparing'),
    @('Provisioning', 20, 45, 'Signing with Apple'), @('Signing', 45, 60, 'Signing with Apple'),
    @('Packaging', 60, 70, 'Packaging'), @('Connecting', 70, 80, 'Connecting to iPhone'),
    @('Installing', 80, 99, 'Installing'))

function Invoke-XtoolInstallOnce([string]$IpaPath, [scriptblock]$Progress) {
    Stop-LinuxXtool   # an earlier install left stuck would hold the iPhone
    Start-Bridge
    # the exact device the person is looking at in Shivo Labs (with two plugged in, xtool would otherwise pick one)
    $target = if ($script:TargetUdid) { " --udid $(Q-Bash $script:TargetUdid)" } else { '' }
    $s = Start-Session "script -qfec $(Q-Bash "xtool install --usb$target $(Q-Bash (ConvertTo-LinuxPath $IpaPath))") /dev/null"
    try {
        $revokeAsked = $false; $waitShown = $false
        & $Progress 0 'Preparing'
        while ($true) {
            # 3 quiet minutes means xtool is stuck (e.g. waiting for a locked phone forever).
            try { $chunk = Read-Chunk $s 180 }
            catch { if ("$_" -eq 'stalled') { throw 'The install stopped responding. Unplug the iPhone, plug it back in, unlock it and try again.' }; throw }
            if ($null -eq $chunk) { break }
            $tail = Get-Tail $s
            if (-not $waitShown -and $tail.Contains('Waiting for device')) { $waitShown = $true; & $Progress 0 'Waiting for your iPhone - unlock it' }
            foreach ($m in [regex]::Matches($chunk, '\[([A-Za-z ]+)\]\s*(\d+)?%?')) {
                $st = $Stages | Where-Object { $_[0] -eq $m.Groups[1].Value.Trim() } | Select-Object -First 1
                if (-not $st) { continue }
                $pct = if ($m.Groups[2].Success) { [int]$m.Groups[2].Value } else { 0 }
                & $Progress ([int]($st[1] + ($st[2] - $st[1]) * $pct / 100)) $st[3]
            }
            if (-not $revokeAsked -and $tail.Contains('Continue? (yes/no)')) {
                $revokeAsked = $true
                $certs = [regex]::Matches($s.All.ToString(), '- (iOS Development:[^\r\n]+)')
                $cert = if ($certs.Count) { $certs[$certs.Count - 1].Groups[1].Value } else { 'an older certificate' }
                $ok = (Ask 'revoke' @{ cert = $cert }) -eq 'yes'
                Send-Line $s $(if ($ok) { 'yes' } else { 'no' })
                if (-not $ok) { throw 'Install cancelled. Apple allows only a few certificates per free account.' }
                continue
            }
            if ($tail.Contains('Successfully installed')) { & $Progress 100 'Installed'; return }
            $e = Get-XtoolError $tail; if ($e) { throw (Get-Friendly $e) }
        }
        $e = Get-XtoolError $s.All.ToString()
        throw (Get-Friendly $(if ($e) { $e } else { 'The install stopped before it finished. Check the cable and try again.' }))
    } finally { Stop-Session $s }
}

function Invoke-XtoolInstall([string]$IpaPath, [scriptblock]$Progress) {
    try { Invoke-XtoolInstallOnce $IpaPath $Progress }
    catch {
        if (-not $_.Exception.Message.Contains($RegisterRace)) { throw }
        # First install on a phone: Apple registers the device a moment after
        # xtool asks for the profile. A second try succeeds.
        & $Progress 5 'Registering your iPhone'
        Start-Sleep -Seconds 3
        Invoke-XtoolInstallOnce $IpaPath $Progress
    }
}

# ---------- .ipa files ----------

function Get-BE($b, [long]$at, [int]$n) { [long]$v = 0; for ($i = 0; $i -lt $n; $i++) { $v = ($v -shl 8) -bor $b[[int]($at + $i)] }; $v }
function Get-BPLen($b, [long]$at) {
    $low = $b[[int]$at] -band 0xF
    if ($low -ne 0xF) { return @([long]$low, ($at + 1)) }
    $n = 1 -shl ($b[[int]($at + 1)] -band 0xF)
    @((Get-BE $b ($at + 2) $n), ($at + 2 + $n))
}
function Get-BPObj($c, [long]$idx) {
    if ($idx -ge $c.count) { return $null }
    $b = $c.b; $at = Get-BE $b ($c.table + $idx * $c.off) $c.off; $m = $b[[int]$at]
    switch ($m -shr 4) {
        5 { $l = Get-BPLen $b $at; return [Text.Encoding]::ASCII.GetString($b, [int]$l[1], [int]$l[0]) }
        6 { $l = Get-BPLen $b $at; return [Text.Encoding]::BigEndianUnicode.GetString($b, [int]$l[1], [int]$l[0] * 2) }
        default { return $null }
    }
}
# Just enough of Apple's binary plist for Info.plist: the top dict's string values.
function Read-BinaryPlist([byte[]]$b) {
    $t = $b.Length - 32
    $c = @{ b = $b; off = [int]$b[$t + 6]; ref = [int]$b[$t + 7]; count = (Get-BE $b ($t + 8) 8); table = (Get-BE $b ($t + 24) 8) }
    $top = Get-BE $b ($t + 16) 8
    $at = Get-BE $b ($c.table + $top * $c.off) $c.off
    $d = @{}
    if (($b[[int]$at] -shr 4) -ne 0xD) { return $d }
    $l = Get-BPLen $b $at
    for ($i = 0; $i -lt $l[0]; $i++) {
        $k = Get-BPObj $c (Get-BE $b ($l[1] + $i * $c.ref) $c.ref)
        if ($k -is [string] -and $k -like 'CFBundle*') { $d[$k] = Get-BPObj $c (Get-BE $b ($l[1] + ($l[0] + $i) * $c.ref) $c.ref) }
    }
    $d
}

# An app's name, bundle ID and version from its .ipa (Payload/*.app/Info.plist).
function Read-Ipa([string]$Path) {
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -match '^Payload/[^/]+\.app/Info\.plist$' } | Select-Object -First 1
        if (-not $entry) { throw 'This file is not an iPhone app (.ipa).' }
        $ms = New-Object IO.MemoryStream; $st = $entry.Open(); $st.CopyTo($ms); $st.Close()
        $data = $ms.ToArray()
    } finally { $zip.Dispose() }

    if ($data.Length -gt 8 -and [Text.Encoding]::ASCII.GetString($data, 0, 6) -eq 'bplist') { $d = Read-BinaryPlist $data }
    else {
        $d = @{}
        $x = New-Object Xml.XmlDocument; $x.XmlResolver = $null; $x.LoadXml([Text.Encoding]::UTF8.GetString($data))
        $items = @($x.SelectNodes('/plist/dict/*'))
        for ($i = 0; $i + 1 -lt $items.Count; $i += 2) {
            if ($items[$i].Name -eq 'key' -and $items[$i + 1].Name -eq 'string') { $d[$items[$i].InnerText] = $items[$i + 1].InnerText }
        }
    }
    $get = { param([string[]]$keys) foreach ($k in $keys) { if (-not [string]::IsNullOrWhiteSpace($d[$k])) { return $d[$k] } }; '' }
    $name = & $get 'CFBundleDisplayName', 'CFBundleName'
    if (-not $name) { $name = [IO.Path]::GetFileNameWithoutExtension($Path) }
    [pscustomobject]@{ Name = $name; BundleId = (& $get 'CFBundleIdentifier'); Version = (& $get 'CFBundleShortVersionString', 'CFBundleVersion') }
}

function Get-IpaSummary([string]$Path) {
    $i = Read-Ipa $Path
    @{ path = $Path; name = $i.Name; bundleId = $i.BundleId; version = $i.Version; size = (Get-Item -LiteralPath $Path).Length }
}

# .ipa files already on this PC: Desktop, Downloads, Documents and OneDrive, five
# folders deep, skipping code and build folders. Takes about half a second.
function Find-Ipas {
    $skip = 'node_modules', 'Pods', 'DerivedData', 'build', 'dist', 'vendor', 'backups', '__pycache__', 'venv'
    # also where phone\install\Get-Latest-IPA.ps1 puts the Shivo Labs phone app builds (with keys)
    $roots = @("$env:USERPROFILE\Desktop", "$env:USERPROFILE\Downloads", "$env:USERPROFILE\Documents", $env:OneDrive, "$env:USERPROFILE\.fabra-labs-ai\phone-build") |
        Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
    $stack = New-Object Collections.Stack
    foreach ($r in $roots) { $stack.Push(@($r, 0)) }
    $files = @()
    while ($stack.Count -and $files.Count -lt 50) {
        $item = $stack.Pop(); $dir = $item[0]; $depth = [int]$item[1]
        try { foreach ($f in [IO.Directory]::EnumerateFiles($dir, '*.ipa')) { $files += $f } } catch { }
        if ($depth -ge 5) { continue }
        try {
            foreach ($sub in [IO.Directory]::EnumerateDirectories($dir)) {
                $name = [IO.Path]::GetFileName($sub)
                if (-not $name.StartsWith('.') -and $skip -notcontains $name) { $stack.Push(@($sub, ($depth + 1))) }
            }
        } catch { }
    }
    foreach ($f in $files | Sort-Object { [IO.File]::GetLastWriteTime($_) } -Descending | Select-Object -First 20) {
        try { $i = Get-IpaSummary $f; $i.folder = Split-Path $f; $i } catch { }   # skip files that aren't real apps
    }
}

# ---------- what Fabra Labs remembers: the Apple ID's email and installed apps. Never a password. ----------

function Get-Store {
    $s = $null
    try { $s = [IO.File]::ReadAllText($StatePath) | ConvertFrom-Json } catch { }
    $apps = New-Object Collections.ArrayList
    if ($s -and $s.Apps) { foreach ($a in $s.Apps) { [void]$apps.Add([pscustomobject]@{ Name = $a.Name; BundleId = $a.BundleId; Version = $a.Version; File = $a.File; InstalledAt = [string]$a.InstalledAt }) } }
    [pscustomobject]@{ AppleId = $(if ($s) { $s.AppleId } else { $null }); Apps = $apps }
}
function Save-Store($store) {
    New-Item -ItemType Directory -Force $DataDir | Out-Null
    [IO.File]::WriteAllText($StatePath, (@{ AppleId = $store.AppleId; Apps = @($store.Apps) } | ConvertTo-Json -Depth 5))
}
function Get-AppsList {
    foreach ($a in (Get-Store).Apps | Sort-Object Name) {
        $when = [datetime]::Parse($a.InstalledAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToLocalTime()
        @{ name = $a.Name; bundleId = $a.BundleId; version = $a.Version
           daysLeft = [Math]::Max(0, 7 - [int][Math]::Floor(((Get-Date) - $when).TotalDays))
           installedAt = $when.ToString('d MMM', [Globalization.CultureInfo]::InvariantCulture) }
    }
}

function Invoke-Install([string]$Path) {
    $sync.Cancel = $false
    if (-not (Test-Path -LiteralPath $Path)) { throw 'The app file is missing. Add it again.' }
    $info = Read-Ipa $Path

    # Keep our own copy, so renewing works even if the original file moves.
    New-Item -ItemType Directory -Force $AppsDir | Out-Null
    $key = if ($info.BundleId) { $info.BundleId } else { [IO.Path]::GetFileNameWithoutExtension($Path) }
    $copy = Join-Path $AppsDir ((($key.ToCharArray() | Where-Object { [IO.Path]::GetInvalidFileNameChars() -notcontains $_ }) -join '') + '.ipa')
    if ([IO.Path]::GetFullPath($Path) -ne [IO.Path]::GetFullPath($copy)) { Copy-Item -LiteralPath $Path $copy -Force }

    Invoke-XtoolInstall $copy { param($pct, $label) Emit 'progress' @{ pct = $pct; label = $label } }

    $store = Get-Store
    foreach ($old in @($store.Apps | Where-Object { $_.BundleId -eq $info.BundleId })) { $store.Apps.Remove($old) }
    [void]$store.Apps.Add([pscustomobject]@{ Name = $info.Name; BundleId = $info.BundleId; Version = $info.Version; File = $copy; InstalledAt = (Get-Date).ToString('o') })
    Save-Store $store
    @{ name = $info.Name; apps = @(Get-AppsList) }
}

# ---------- updates: new versions reach every PC over the internet ----------
# update.json (next to this file) says where the update notice lives. The notice
# (manifest.json) names the version, the package and its SHA-256, and is signed
# with the publisher's private key; update-key.xml here is the public half.
# A package is used only if both the signature and the hash check out, so a
# changed link or file can't put someone else's code on people's PCs.
$UpdateDir = Join-Path $DataDir 'update'

function Get-AppVersion {
    $f = Join-Path $EngineDir 'version.txt'
    if (Test-Path $f) { ([IO.File]::ReadAllText($f)).Trim() } else { '0.0.0' }
}

function Test-ManifestSignature($m) {
    $keyFile = Join-Path $EngineDir 'update-key.xml'
    if (-not (Test-Path $keyFile) -or -not $m.signature) { return $false }
    $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
    try {
        $rsa.FromXmlString([IO.File]::ReadAllText($keyFile))
        $data = [Text.Encoding]::UTF8.GetBytes("$($m.version)|$($m.package)|$($m.sha256)")
        $rsa.VerifyData($data, 'SHA256', [Convert]::FromBase64String($m.signature))
    } catch { $false } finally { $rsa.Dispose() }
}

# Downloads and stages a newer version; FabraLabs.ps1 swaps it in on the next start.
function Invoke-UpdateCheck {
    $cfgFile = Join-Path $EngineDir 'update.json'
    if (-not (Test-Path $cfgFile)) { return $null }
    $cfg = [IO.File]::ReadAllText($cfgFile) | ConvertFrom-Json
    if (-not $cfg.manifest) { return $null }

    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $wc = New-Object Net.WebClient
    try {
        $m = $wc.DownloadString($cfg.manifest + '?t=' + [DateTime]::UtcNow.Ticks) | ConvertFrom-Json
        if ([version]$m.version -le [version](Get-AppVersion)) { return $null }
        if (-not (Test-ManifestSignature $m)) { throw 'The update is not signed by the publisher.' }

        $staged = Join-Path $UpdateDir 'staged'
        if ((Test-Path "$staged\version.txt") -and ([IO.File]::ReadAllText("$staged\version.txt").Trim() -eq $m.version)) {
            return @{ version = $m.version; notes = [string]$m.notes }   # already downloaded
        }
        New-Item -ItemType Directory -Force $UpdateDir | Out-Null
        $zip = Join-Path $UpdateDir 'package.zip'
        $url = if ($m.package -match '^https://') { $m.package } else { ($cfg.manifest -replace '[^/]+$', '') + $m.package }
        $wc.DownloadFile($url, $zip)
        if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $m.sha256.ToUpper()) { Remove-Item $zip -Force; throw 'The update download was damaged. It will try again next time.' }

        if (Test-Path $staged) { Remove-Item $staged -Recurse -Force }
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staged)
        Remove-Item $zip -Force
        [IO.File]::WriteAllText("$staged\version.txt", $m.version)
        @{ version = $m.version; notes = [string]$m.notes }
    } finally { $wc.Dispose() }
}

# ---------- the commands the window sends (long ones run here, off the window's thread) ----------

function Invoke-EngineCommand([string]$Cmd, $A) {
    switch ($Cmd) {
        'status' {
            $s = Get-SetupStatus
            $id = if ($s.engine) { Get-SignedIn } else { $null }
            return @{ wsl = $s.wsl; engine = $s.engine; apple = $s.apple; ready = ($s.wsl -and $s.engine -and $s.apple); appleId = $id; apps = @(Get-AppsList) }
        }
        'setup' { return Invoke-Setup }
        'device' {
            if (-not (Test-Apple)) { return $null }
            Start-Bridge
            return Get-FirstDevice
        }
        'signIn' {
            $email = ([string]$A.email).Trim()
            Invoke-SignIn $email ([string]$A.password)
            $store = Get-Store; $store.AppleId = $email; Save-Store $store
            return @{ appleId = $email }
        }
        'signOut' { [void](Invoke-Sh 'xtool auth logout 2>&1'); return $null }
        'install' { $script:TargetUdid = [string]$A.udid; return Invoke-Install ([string]$A.path) }
        'renew' {
            $script:TargetUdid = [string]$A.udid
            $app = (Get-Store).Apps | Where-Object { $_.BundleId -eq $A.bundleId } | Select-Object -First 1
            if (-not $app) { throw 'App not found.' }
            # a newer file of the same app on this PC (e.g. a new build in Downloads) is used instead of the kept copy;
            # before, Renew kept reinstalling the old copy and new builds never reached the phone
            $kept = if (Test-Path -LiteralPath $app.File) { (Get-Item -LiteralPath $app.File).LastWriteTime } else { [datetime]::MinValue }
            $newer = @(Find-Ipas) | Where-Object { $_.bundleId -eq $app.BundleId -and (Get-Item -LiteralPath $_.path).LastWriteTime -gt $kept } |
                Sort-Object { (Get-Item -LiteralPath $_.path).LastWriteTime } -Descending | Select-Object -First 1
            if ($newer) { return Invoke-Install $newer.path }
            return Invoke-Install $app.File
        }
        'forget' {
            $store = Get-Store
            $app = $store.Apps | Where-Object { $_.BundleId -eq $A.bundleId } | Select-Object -First 1
            if ($app) { $store.Apps.Remove($app); Save-Store $store; try { Remove-Item -LiteralPath $app.File -Force } catch { } }
            return , @(Get-AppsList)
        }
        'findIpas' { return , @(Find-Ipas) }
        'checkUpdate' { return Invoke-UpdateCheck }
        'version' { return @{ version = Get-AppVersion } }
        default { throw "Unknown command: $Cmd" }
    }
}
