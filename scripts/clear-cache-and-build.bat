@echo off
echo.
echo  Clearing electron-builder cache and rebuilding...
echo.

REM Clear the corrupt winCodeSign cache (causes symlink errors on non-admin Windows)
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    echo Removing winCodeSign cache...
    rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
)

REM Disable code signing
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set CSC_LINK=

echo Running build...
npm run build

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Build failed. See output above.
    pause
) else (
    echo.
    echo Build complete. Check dist\ folder.
    for %%f in (dist\*Setup*.exe) do echo    dist\%%~nxf
    pause
)
