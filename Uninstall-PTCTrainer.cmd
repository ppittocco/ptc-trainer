@echo off
cd /d "%~dp0"
set PY=..\runtime\python.exe
if not exist "%PY%" set PY=python
"%PY%" -I install.py --uninstall
echo.
pause
