@echo off
REM Apply portable.nsi patch before building the portable target.
REM Run this after "npm install"/"npm ci" because they overwrite node_modules.
setlocal
set ROOT=%~dp0..
set TPL=%ROOT%\node_modules\app-builder-lib\templates\nsis\portable.nsi
set PATCHED=%ROOT%\build\portable.nsi.patched

if not exist "%PATCHED%" (
  echo [ERROR] missing %PATCHED%
  exit /b 1
)
if not exist "%TPL%" (
  echo [ERROR] missing template %TPL%
  exit /b 1
)

findstr /c:"LingYa patch" "%TPL%" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo [SKIP] template already patched
) else (
  copy /Y "%PATCHED%" "%TPL%" >nul
  echo [OK] applied portable.nsi patch
)
endlocal
