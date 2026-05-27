Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\Laurent ROCHE\salon-alternance"
WshShell.Run """C:\Users\Laurent ROCHE\salon-alternance\start-parcoursup.bat""", 0, False
Set WshShell = Nothing
