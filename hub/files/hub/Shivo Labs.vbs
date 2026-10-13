' Opens the Shivo Labs hub: starts its small server quietly (if it isn't running) and shows it in its own app window.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
' An installed copy may carry its own Node.js next to the hub; otherwise use the one on this PC.
nodeExe = "node"
bundled = fso.GetParentFolderName(dir) & "\node\node.exe"
If fso.FileExists(bundled) Then nodeExe = """" & bundled & """"
' A second copy of the server just notices the port is taken and quits, so this is safe to run twice.
sh.Run nodeExe & " """ & dir & "\server.mjs""", 0, False
WScript.Sleep 900
' "/background" (start with Windows): run the hub and Beam quietly, no window.
' "/open:<module>" opens the hub on that module, e.g. /open:xtools after the restart X Tools setup needs.
page = ""
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "/background" Then WScript.Quit
  If LCase(Left(WScript.Arguments(0), 6)) = "/open:" Then page = "#" & Mid(WScript.Arguments(0), 7)
End If
' Shivo Labs AI's Edge profile: its chats are saved in that profile, and the hub shows Shivo Labs AI inside its window.
' (Also its own taskbar icon and no clash with your browser.)
profile = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.fabra-labs-ai\edge"
sh.Run "msedge --app=http://localhost:4800/" & page & " --window-size=1100,760 --user-data-dir=""" & profile & """ --no-first-run --no-default-browser-check", 1, False
