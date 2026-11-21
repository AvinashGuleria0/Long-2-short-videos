@echo off
setlocal enabledelayedexpansion
title L2S - AI YouTube Shorts Studio
color 0b

echo.
echo =======================================================
echo          🛹 L2S - AI YouTube Shorts Studio
echo          Automated Setup ^& Diagnostic Launcher
echo =======================================================
echo.

:: 1. Check Bun runtime
echo [1/6] Checking Bun runtime...
where bun >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Bun is not installed on this machine.
    echo [*] Attempting automated installation via PowerShell...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
    where bun >nul 2>&1
    if %errorlevel% neq 0 (
        color 0c
        echo [ERROR] Automatic Bun installation failed.
        echo Please install Bun manually by opening PowerShell and running:
        echo   powershell -c "irm bun.sh/install.ps1 | iex"
        echo Or download from: https://bun.sh
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%v in ('bun --version 2^>nul') do set BUN_VER=%%v
echo     [OK] Bun is available (v%BUN_VER%)

:: 2. Check dependencies (bun install)
echo.
echo [2/6] Verifying project node_modules...
if not exist "node_modules\" (
    echo     Installing project packages with Bun...
    call bun install
) else (
    echo     [OK] node_modules found.
)

:: 3. Check FFmpeg
echo.
echo [3/6] Checking FFmpeg (Required for video editing ^& subtitles)...
where ffmpeg >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] FFmpeg was not found in your PATH.
    echo [*] Attempting to install FFmpeg via winget...
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    echo [*] Refreshing environment variables...
    for /f "tokens=*" %%p in ('powershell -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"') do set "PATH=%%p;%PATH%"
    where ffmpeg >nul 2>&1
    if %errorlevel% neq 0 (
        color 0e
        echo [WARNING] FFmpeg could not be auto-installed.
        echo Please install FFmpeg via: winget install Gyan.FFmpeg
        echo or download from: https://ffmpeg.org/download.html
        echo Render steps may fail without FFmpeg.
    ) else (
        echo     [OK] FFmpeg installed successfully!
    )
) else (
    for /f "tokens=*" %%v in ('ffmpeg -version 2^>nul ^| findstr "ffmpeg version"') do set FFMPEG_VER=%%v
    echo     [OK] FFmpeg detected: !FFMPEG_VER!
)

:: 4. Check Python & yt-dlp
echo.
echo [4/6] Checking Python ^& yt-dlp (Required for downloading videos)...
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Python is not installed.
    echo [*] Attempting to install Python via winget...
    winget install Python.Python.3.11 --accept-source-agreements --accept-package-agreements
    for /f "tokens=*" %%p in ('powershell -Command "[System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User')"') do set "PATH=%%p;%PATH%"
)
where yt-dlp >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] yt-dlp not found. Installing via pip...
    python -m pip install --upgrade yt-dlp
    where yt-dlp >nul 2>&1
    if %errorlevel% neq 0 (
        echo [WARNING] yt-dlp installation could not be completed automatically.
    ) else (
        echo     [OK] yt-dlp installed successfully!
    )
) else (
    for /f "tokens=*" %%v in ('yt-dlp --version 2^>nul') do set YTDLP_VER=%%v
    echo     [OK] yt-dlp is available (v!YTDLP_VER!)
)

:: 5. Check Environment (.env) & LLM
echo.
echo [5/6] Checking environment configuration...
if not exist ".env" (
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo     [i] Created .env from .env.example
    ) else (
        echo PORT=3000> .env
        echo GROQ_API_KEY=> .env
        echo LLM_PROVIDER=groq>> .env
        echo GROQ_MODEL=openai/gpt-oss-20b>> .env
        echo WHISPER_PROVIDER=groq>> .env
        echo WHISPER_MODEL=whisper-large-v3-turbo>> .env
        echo OLLAMA_URL=http://localhost:11434>> .env
        echo OLLAMA_MODEL=qwen2.5:7b>> .env
        echo     [i] Generated fresh .env file.
    )
    echo     [!] Note: You can add your GROQ_API_KEY inside the .env file for cloud AI,
    echo         or install Ollama (https://ollama.com) to run 100%% local AI.
) else (
    echo     [OK] .env configuration found.
)

:: Check Ollama status
curl -s http://localhost:11434/api/tags >nul 2>&1
if %errorlevel% equ 0 (
    echo     [OK] Ollama is RUNNING locally! (Local LLM ready)
) else (
    echo     [i] Ollama is not currently running. (Groq API will be used if configured)
)

:: 6. Launch Server & Open Browser
echo.
echo [6/6] Starting L2S server...
echo -------------------------------------------------------
echo   Server URL: http://localhost:3000
echo   Press CTRL+C anytime in this window to stop the server.
echo -------------------------------------------------------
echo.

:: Launch default browser after 2 seconds in background
start "" powershell -NoProfile -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:3000'"

:: Start the application with Bun
bun start

if %errorlevel% neq 0 (
    color 0c
    echo.
    echo =======================================================
    echo [ERROR] L2S server exited with code %errorlevel%.
    echo Please inspect the console error logs above.
    echo =======================================================
    pause
)
