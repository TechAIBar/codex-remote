' codex-remote hidden/background start (no console window). Logs go to data\server.log
Dim sh, fso, root, node
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
node = sh.Environment("PROCESS")("CR_NODE")
If node = "" Then
  node = sh.ExpandEnvironmentStrings("%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
  If Not fso.FileExists(node) Then node = "node.exe"
End If
If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")
sh.CurrentDirectory = root
sh.Run "cmd /c """"" & node & """ server.js >> ""data\server.log"" 2>&1""", 0, False
