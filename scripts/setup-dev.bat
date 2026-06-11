@echo off
setlocal
title SubSync — Developer Setup

echo.
echo  ==========================================================
echo    SubSync — Developer Setup
echo  ==========================================================
echo.

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] Node.js not found. Download from https://nodejs.org & pause & exit /b 1 )
echo [OK] Node.js found.

where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] Python not found on PATH. & pause & exit /b 1 )
python --version
echo [OK] Python found.

echo.
echo [1/5] Clearing pip cache (prevents deserialization warnings)...
python -m pip cache purge >nul 2>&1
echo       Done.

echo [2/5] Creating Python virtual environment...
if not exist python\venv (
    python -m venv python\venv
    if %ERRORLEVEL% NEQ 0 ( echo [ERROR] venv creation failed. & pause & exit /b 1 )
    echo       Created.
) else (
    echo       Already exists.
)

echo [3/5] Upgrading pip in venv...
python\venv\Scripts\python.exe -m pip install --upgrade pip --no-cache-dir --quiet
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] pip upgrade failed. & pause & exit /b 1 )
echo       Done.

echo [4/5] Installing Python packages...

echo       Installing flask + flask-cors...
python\venv\Scripts\pip install --no-cache-dir flask flask-cors python-docx --quiet
if %ERRORLEVEL% NEQ 0 ( echo [ERROR] flask install failed. & pause & exit /b 1 )

echo       Installing openai-whisper (may take a few minutes)...
python\venv\Scripts\pip install --no-cache-dir openai-whisper --quiet
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] openai-whisper install failed.
    echo.
    echo         Most common cause on Windows: missing Visual C++ Build Tools.
    echo         Download free from: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo         Select "Desktop development with C++" then re-run this script.
    echo.
    pause & exit /b 1
)

echo       Verifying imports...
python\venv\Scripts\python.exe -c "import flask, flask_cors, whisper; print('  flask OK, whisper OK')"
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Package import failed even after install.
    echo         Run scripts\diagnose.bat for details.
    pause & exit /b 1
)

echo [5/5] Installing Node.js dependencies...
if not exist node_modules (
    npm install --silent
    if %ERRORLEVEL% NEQ 0 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
) else (
    echo       Already installed.
)

echo.
echo  ==========================================================
echo    Setup complete! Run: npm start
echo  ==========================================================
pause
