# X Tools engine for the hub. Does what FabraLabs.ps1 does for its own window, without the window:
# reads {id, cmd, args} lines on stdin, writes replies {id, ok, data | error} and events {event, data}
# as lines on stdout. The engine itself is the installed X Tools' Engine.ps1 (unchanged).
param([Parameter(Mandatory)][string]$EngineDir)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)

# One X Tools at a time (the same lock as its own window): two copies would fight over the iPhone and Linux.
$mutex = New-Object Threading.Mutex($false, 'Local\FabraLabs')
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { [Console]::Out.WriteLine('{"event":"busy"}'); [Console]::Out.Flush(); exit 3 }

$sync = [hashtable]::Synchronized(@{
    Out     = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
    Answers = [hashtable]::Synchronized(@{})
    Cancel  = $false
    Proc    = $null
})
. (Join-Path $EngineDir 'Engine.ps1')

$pool = [runspacefactory]::CreateRunspacePool(1, 4)
$pool.Open()
$jobs = New-Object Collections.ArrayList
$worker = {
    param($EngineDir, $sync, $id, $cmd, $argsJson)
    try {
        . (Join-Path $EngineDir 'Engine.ps1')
        $a = if ($argsJson) { $argsJson | ConvertFrom-Json } else { $null }
        $reply = @{ id = $id; ok = $true; data = (Invoke-EngineCommand $cmd $a) }
    } catch {
        $msg = if ($_.Exception -is [OperationCanceledException]) { 'Cancelled.' } else { $_.Exception.Message }
        $reply = @{ id = $id; ok = $false; error = $msg }
    }
    $sync.Out.Enqueue(($reply | ConvertTo-Json -Compress -Depth 8))
}
function Reply($id, $ok, $data, $err) {
    $r = if ($ok) { @{ id = $id; ok = $true; data = $data } } else { @{ id = $id; ok = $false; error = $err } }
    $sync.Out.Enqueue(($r | ConvertTo-Json -Compress -Depth 8))
}

# Its own reader: [Console]::In.ReadLineAsync() quietly waits for the line, which would hold up every reply.
$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding($false)))
$read = $stdin.ReadLineAsync()
while ($true) {
    if ($read.IsCompleted) {
        $line = $read.Result
        if ($null -eq $line) { break }   # the hub closed: stop
        $read = $stdin.ReadLineAsync()
        try { $msg = $line | ConvertFrom-Json } catch { $msg = $null }
        if ($msg) {
            $id = [string]$msg.id; $cmd = [string]$msg.cmd; $a = $msg.args
            try {
                switch ($cmd) {
                    'answer'  { $sync.Answers[[string]$a.kind] = [string]$a.value; Reply $id $true $null }
                    'cancel'  {
                        $sync.Cancel = $true
                        foreach ($k in @($sync.Answers.Keys)) { $sync.Answers.Remove($k) }
                        try { if ($sync.Proc -and -not $sync.Proc.HasExited) { $sync.Proc.Kill() } } catch { }
                        Reply $id $true $null
                    }
                    'summary' { Reply $id $true (Get-IpaSummary ([string]$a.path)) }   # an .ipa the hub just saved
                    default {
                        $ps = [powershell]::Create(); $ps.RunspacePool = $pool
                        [void]$ps.AddScript($worker).AddArgument($EngineDir).AddArgument($sync).AddArgument($id).AddArgument($cmd).AddArgument($(if ($a) { $a | ConvertTo-Json -Compress -Depth 5 } else { $null }))
                        [void]$jobs.Add(@{ ps = $ps; handle = $ps.BeginInvoke() })
                    }
                }
            } catch { Reply $id $false $null $_.Exception.Message }
        }
    }
    $json = $null
    while ($sync.Out.TryDequeue([ref]$json)) { [Console]::Out.WriteLine($json) }
    [Console]::Out.Flush()
    for ($i = $jobs.Count - 1; $i -ge 0; $i--) {
        $j = $jobs[$i]
        if ($j.handle.IsCompleted) { try { [void]$j.ps.EndInvoke($j.handle) } catch { }; $j.ps.Dispose(); $jobs.RemoveAt($i) }
    }
    Start-Sleep -Milliseconds 40
}
$sync.Cancel = $true
try { if ($sync.Proc -and -not $sync.Proc.HasExited) { $sync.Proc.Kill() } } catch { }
try { $mutex.ReleaseMutex() } catch { }
[Environment]::Exit(0)
