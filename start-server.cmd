@echo off
rem Double-click to run Daily Budget on your Wi-Fi so the iPhone (app + shortcuts) can reach it.
rem Keep this window open; close it to stop the server.
cd /d "%~dp0"
set "PY=%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
if not exist "%PY%" set "PY=py"
"%PY%" server.py
pause
