@echo off
echo Creating UI-TARS Desktop Shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-desktop-shortcut.ps1"
echo Done! You can now launch UI-TARS directly from the shortcut on your Desktop.
pause
