@echo off
REM =====================================================================
REM BetterTypora 安装引导 — 双击运行即可
REM 用法:
REM   install.bat               安装 (自动定位 Typora, 幂等注入 + 复制插件)
REM   install.bat -Uninstall   卸载 (移除注入行, 插件目录保留)
REM   install.bat -TyporaDir "D:\Tools\Typora\resources"   指定目录
REM =====================================================================
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
