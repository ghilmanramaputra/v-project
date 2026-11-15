@echo off
rem Copies a shortcut to StartHidden.vbs into the Windows Startup folder,
rem so the V-Project watcher runs automatically every time you log in.
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\VProjectWatcher.lnk'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%~dp0StartHidden.vbs\"'; $s.WorkingDirectory='%~dp0'; $s.Save()"
echo Selesai. Watcher V-Project akan jalan otomatis saat Windows login.
echo Untuk mematikan auto-start, hapus: %STARTUP%\VProjectWatcher.lnk
pause
