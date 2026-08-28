@echo off
REM =====================================================================
REM BetterTypora installer launcher
REM Usage:
REM   install.bat               Show menu (install / uninstall / detect / exit)
REM   install.bat -Uninstall    Uninstall (remove injection line, keep plugins dir)
REM   install.bat -TyporaDir "D:\Tools\Typoraesources"   specify resources dir
REM   install.bat -DetectOnly   Only detect Typora path, no changes
REM =====================================================================
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
