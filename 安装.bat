@echo off
REM =====================================================================
REM BetterTypora installer launcher
REM Usage:
REM   Run this file with no args: show menu (install / uninstall / detect / exit)
REM   Pass args to core.ps1 directly:
REM     -Uninstall    Uninstall (remove injection line, keep plugins dir)
REM     -TyporaDir "D:\Tools\Typoraesources"   specify resources dir
REM     -DetectOnly   Only detect Typora path, no changes
REM =====================================================================
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core.ps1" %*
echo.
pause
