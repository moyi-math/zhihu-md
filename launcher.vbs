' Launch zhihu-md.exe without showing a console window.
' Double-click this file instead of the exe.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\zhihu-md.exe""", 0, False
