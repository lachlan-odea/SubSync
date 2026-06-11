@echo off
echo ============================================
echo  SubSync — Developer Setup
echo ============================================
echo.

REM Check Python
python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Python not found. Install Python 3.10 or 3.11 from python.org
    pause
    exit /b 1
)

echo [1/4] Python found
python --version

REM Create venv
echo [2/4] Creating Python virtual environment...
python -m venv python\venv
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to create venv
    pause
    exit /b 1
)

REM Install Python deps
echo [3/4] Installing Python dependencies (this may take a few minutes)...
python\venv\Scripts\pip install --upgrade pip
python\venv\Scripts\pip install -r python\requirements.txt
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install Python packages
    pause
    exit /b 1
)

REM Install Node deps
echo [4/4] Installing Node.js dependencies...
npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Setup complete! Run: npm start
echo ============================================
pause
