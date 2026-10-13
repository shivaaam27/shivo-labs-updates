' Starts Shivo Labs AI quietly in the background and opens it in its own app window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
' Re-read the API key in case it was saved after Windows started.
On Error Resume Next
key = sh.RegRead("HKCU\Environment\ANTHROPIC_API_KEY")
If Err.Number = 0 And key <> "" Then sh.Environment("Process")("ANTHROPIC_API_KEY") = key
On Error GoTo 0
' Installed copies carry their own Node.js next to the app; otherwise use the one on this PC.
nodeExe = "node"
bundled = fso.GetParentFolderName(dir) & "\node\node.exe"
If fso.FileExists(bundled) Then nodeExe = """" & bundled & """"
' launcher.mjs starts server.mjs and puts the last working version back if an update won't start.
script = "server.mjs"
If fso.FileExists(dir & "\launcher.mjs") Then script = "launcher.mjs"
sh.Run nodeExe & " """ & dir & "\" & script & """", 0, False
WScript.Sleep 1500
' Its own Edge profile: own taskbar icon, own microphone permission, no clash with your browser.
profile = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.fabra-labs-ai\edge"
sh.Run "msedge --app=http://localhost:4823 --window-size=1280,860 --user-data-dir=""" & profile & """ --no-first-run --no-default-browser-check", 1, False
' Make the window share the pinned icon's taskbar ID, so pinning works (no second icon).
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & dir & "\set-taskbar-id.ps1""", 0, False
