@echo off
REM vibe-init.bat - init vibe-check for this project
REM Usage: run in project root

set SKILLS_DIR=.claude
set SKILLS_FILE=%SKILLS_DIR%\skills.json
set GLOBAL_SKILL=C:\Users\Lin\.claude\skills\vibe-check\SKILL.md

echo === Check %SKILLS_DIR%/ dir...

if not exist "%SKILLS_DIR%" (
  mkdir "%SKILLS_DIR%"
  echo   created %SKILLS_DIR%/
)

echo === Register vibe-check skill...

echo { "skills": ["%GLOBAL_SKILL%"] } > "%SKILLS_FILE%"

echo   [OK] %SKILLS_FILE%
echo.
echo   Now open a new session in this directory and type /vibe-check.
echo   Existing sessions need /reload.
