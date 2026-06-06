$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$[Environment]::GetFolderPath('Desktop')\UI-TARS Desktop.lnk")
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = "/c cd /d C:\Users\msjan\Desktop\UI-TARS-desktop && pnpm dev:ui-tars"
$Shortcut.WorkingDirectory = "C:\Users\msjan\Desktop\UI-TARS-desktop"
$Shortcut.IconLocation = "C:\Users\msjan\Desktop\UI-TARS-desktop\apps\ui-tars\resources\icon.png"
$Shortcut.Description = "Run UI-TARS Desktop App"
$Shortcut.Save()
Write-Host "Shortcut created successfully on Desktop!"
