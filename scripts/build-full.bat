@echo off
setlocal enabledelayedexpansion
title SubSync - Full Build

echo.
echo  ==========================================================
echo    SubSync - Automated Build
echo  ==========================================================
echo.

set PYTHON_VERSION=3.11.9
set PYTHON_EMBED_URL=https://www.python.org/ftp/python/%PYTHON_VERSION%/python-%PYTHON_VERSION%-embed-amd64.zip
set PYTHON_EMBED_ZIP=build-cache\python-embed.zip
set GETPIP_URL=https://bootstrap.pypa.io/get-pip.py
set GETPIP_PATH=build-cache\get-pip.py
set FFMPEG_URL=https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip
set FFMPEG_ZIP=build-cache\ffmpeg.zip
set BUNDLE_DIR=python-bundle

for %%T in (node npm curl) do (
    where %%T >nul 2>&1
    if !ERRORLEVEL! NEQ 0 ( echo [ERROR] %%T not found. & pause & exit /b 1 )
)
echo [OK] node, npm, curl found.
echo.

if not exist build-cache mkdir build-cache
if exist "%BUNDLE_DIR%" ( rmdir /s /q "%BUNDLE_DIR%" )
mkdir "%BUNDLE_DIR%"

REM -- 1. Python embeddable -------------------------------------------------
if not exist "%PYTHON_EMBED_ZIP%" (
    echo [1/5] Downloading Python %PYTHON_VERSION% embeddable...
    curl -L --progress-bar -o "%PYTHON_EMBED_ZIP%" "%PYTHON_EMBED_URL%"
    if !ERRORLEVEL! NEQ 0 ( echo [ERROR] Download failed. & pause & exit /b 1 )
) else ( echo [1/5] Python embeddable cached. )

echo       Extracting...
powershell -NoProfile -Command "Expand-Archive -Path '%PYTHON_EMBED_ZIP%' -DestinationPath '%BUNDLE_DIR%' -Force"
if !ERRORLEVEL! NEQ 0 ( echo [ERROR] Python extraction failed. & pause & exit /b 1 )

REM -- 2. Patch _pth --------------------------------------------------------
echo [2/5] Configuring embeddable Python...
set PTH_FILE=
for %%f in ("%BUNDLE_DIR%\python3*._pth") do set PTH_FILE=%%f
if not defined PTH_FILE for %%f in ("%BUNDLE_DIR%\python*._pth") do set PTH_FILE=%%f
if defined PTH_FILE (
    powershell -NoProfile -Command "(Get-Content '!PTH_FILE!') -replace '#import site','import site' | Set-Content '!PTH_FILE!'"
    powershell -NoProfile -Command "Add-Content -Path '!PTH_FILE!' -Value 'Lib\site-packages'"
    echo       Patched: !PTH_FILE!
) else ( echo [WARNING] ._pth file not found. )

REM -- 3. pip + packages ----------------------------------------------------
if not exist "%GETPIP_PATH%" (
    echo       Downloading get-pip.py...
    curl -L --silent -o "%GETPIP_PATH%" "%GETPIP_URL%"
)
"%BUNDLE_DIR%\python.exe" "%GETPIP_PATH%" --no-warn-script-location --quiet
if !ERRORLEVEL! NEQ 0 ( echo [ERROR] pip bootstrap failed. & pause & exit /b 1 )

echo [3/5] Installing Python packages...
"%BUNDLE_DIR%\python.exe" -m pip install flask flask-cors python-docx openai-whisper ^
    --target="%BUNDLE_DIR%\Lib\site-packages" --no-warn-script-location --quiet
if !ERRORLEVEL! NEQ 0 ( echo [ERROR] pip install failed. & pause & exit /b 1 )

copy /y "python\server.py" "%BUNDLE_DIR%\server.py" >nul
copy /y "python\sync.py"   "%BUNDLE_DIR%\sync.py"   >nul
echo       Packages installed, scripts copied.

REM -- 4. ffmpeg - use PowerShell Expand-Archive instead of tar -------------
if not exist "%FFMPEG_ZIP%" (
    echo [4/5] Downloading ffmpeg-essentials...
    curl -L --progress-bar -o "%FFMPEG_ZIP%" "%FFMPEG_URL%"
    if !ERRORLEVEL! NEQ 0 ( echo [ERROR] ffmpeg download failed. & pause & exit /b 1 )
) else ( echo [4/5] ffmpeg cached. )

echo       Extracting ffmpeg...
if exist build-cache\ffmpeg-extracted ( rmdir /s /q build-cache\ffmpeg-extracted )
mkdir build-cache\ffmpeg-extracted
powershell -NoProfile -Command "Expand-Archive -Path '%FFMPEG_ZIP%' -DestinationPath 'build-cache\ffmpeg-extracted' -Force"
if !ERRORLEVEL! NEQ 0 ( echo [ERROR] ffmpeg extraction failed. & pause & exit /b 1 )

REM Search recursively for ffmpeg.exe using PowerShell (handles nested folders)
echo       Locating ffmpeg.exe in extracted archive...
powershell -NoProfile -Command ^
  "$f = Get-ChildItem -Path 'build-cache\ffmpeg-extracted' -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1; if ($f) { Copy-Item $f.FullName -Destination '%BUNDLE_DIR%\ffmpeg.exe'; Write-Host ('Copied: ' + $f.FullName) } else { Write-Host 'NOT FOUND'; exit 1 }"
if !ERRORLEVEL! NEQ 0 (
    echo [ERROR] ffmpeg.exe not found in archive. The download may be corrupt.
    echo         Delete build-cache\ffmpeg.zip and run again.
    pause & exit /b 1
)

REM -- 5. Electron build -----------------------------------------------------
echo [5/5] Building Electron installer...
if not exist node_modules ( npm install --silent )

REM Disable code signing (no certificate, internal distribution only)
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set CSC_LINK=

REM Clear corrupt winCodeSign cache that causes symlink errors on Windows
echo       Clearing electron-builder winCodeSign cache...
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" (
    rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
    echo       Cache cleared.
)

npm run build
if !ERRORLEVEL! NEQ 0 ( echo [ERROR] Electron build failed. & pause & exit /b 1 )

echo.
echo  ==========================================================
echo    BUILD COMPLETE
echo  ==========================================================
echo.
for %%f in (dist\*Setup*.exe) do echo    dist\%%~nxf
echo.
pause
