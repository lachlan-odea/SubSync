@echo off
echo.
echo  ==========================================================
echo    SubSync — Diagnostics
echo  ==========================================================
echo.

set VENV_PYTHON=python\venv\Scripts\python.exe

echo [1] Checking venv exists...
if exist "%VENV_PYTHON%" (
    echo     FOUND: %VENV_PYTHON%
) else (
    echo     MISSING: %VENV_PYTHON%
    echo     Fix: run scripts\setup-dev.bat
    goto done
)

echo.
echo [2] Checking Python version...
%VENV_PYTHON% --version

echo.
echo [3] Checking installed packages...
%VENV_PYTHON% -m pip list 2>&1 | findstr /i "flask whisper"

echo.
echo [4] Test importing server dependencies...
%VENV_PYTHON% -c "import flask; print('flask OK:', flask.__version__)"
%VENV_PYTHON% -c "import flask_cors; print('flask_cors OK')"
%VENV_PYTHON% -c "import whisper; print('whisper OK:', whisper.__version__)"

echo.
echo [5] Test starting server.py directly (will run for 5 seconds)...
echo     Watch for any ImportError or startup errors below:
echo     -------------------------------------------------------
start /wait /b timeout /t 1 >nul
%VENV_PYTHON% python\server.py
echo     -------------------------------------------------------

:done
echo.
pause
