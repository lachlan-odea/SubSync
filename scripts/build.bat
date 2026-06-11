@echo off
echo ============================================
echo  SubSync — Build Windows Installer
echo ============================================
echo.

REM Check venv exists
if not exist "python\venv" (
    echo [ERROR] Python venv not found. Run scripts\setup.bat first.
    pause
    exit /b 1
)

REM Check ffmpeg
if not exist "python\ffmpeg.exe" (
    echo [WARNING] python\ffmpeg.exe not found.
    echo   Download ffmpeg-essentials from https://www.gyan.dev/ffmpeg/builds/
    echo   Place ffmpeg.exe in the python\ folder before distributing.
    echo   (The app will still build but users need ffmpeg on their PATH.)
    echo.
)

echo [1/2] Building Electron app...
npm run build

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Build failed
    pause
    exit /b 1
)

echo.
echo [2/2] Done!
echo Installer is in: dist\
dir dist\*.exe 2>nul
echo.
echo ============================================
echo  Distribute the .exe installer to your team
echo ============================================
pause
