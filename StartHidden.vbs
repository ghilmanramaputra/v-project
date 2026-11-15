' Runs the V-Project watcher in the background with no window.
' To stop it: Task Manager > find "Node.js JavaScript Runtime" > End task.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & dir & "\check.mjs""", 0, False
