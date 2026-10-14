@echo off
chcp 65001 >nul
REM 构建前准备：把 patch 后的 portable.nsi 应用到 node_modules
REM 用途：npm install 会覆盖 node_modules，构建前跑一次即可
setlocal
set ROOT=%~dp0..
set TPL=%ROOT%\node_modules\app-builder-lib\templates\nsis\portable.nsi
set PATCHED=%ROOT%\build\portable.nsi.patched

if not exist "%PATCHED%" (
  echo [ERROR] 未找到 %PATCHED%
  exit /b 1
)
if not exist "%TPL%" (
  echo [ERROR] 未找到模板 %TPL%
  exit /b 1
)

findstr /c:"LingYa patch" "%TPL%" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo [SKIP] 模板已是 patch 版
) else (
  copy /Y "%PATCHED%" "%TPL%" >nul
  echo [OK] 已应用 portable.nsi patch
)
endlocal
