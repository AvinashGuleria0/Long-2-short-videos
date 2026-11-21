# L2S - AI YouTube Shorts Studio (Cross-Platform Launcher)
$ErrorActionPreference = "Continue"

Write-Host ""
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host "         🛹 L2S - AI YouTube Shorts Studio" -ForegroundColor Cyan
Write-Host "         Cross-Platform Automated Setup & Launcher" -ForegroundColor Cyan
Write-Host "=======================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check Bun
Write-Host "[1/6] Checking Bun runtime..." -ForegroundColor Yellow
if (-not (Get-Command "bun" -ErrorAction SilentlyContinue)) {
    Write-Host "[!] Bun is not installed. Installing Bun..." -ForegroundColor Yellow
    irm bun.sh/install.ps1 | iex
    $env:Path = "$HOME\.bun\bin;" + $env:Path
    if (-not (Get-Command "bun" -ErrorAction SilentlyContinue)) {
        Write-Host "[ERROR] Could not install Bun automatically. Please run: irm bun.sh/install.ps1 | iex" -ForegroundColor Red
        Read-Host "Press Enter to exit..."
        exit 1
    }
}
$bunVersion = bun --version
Write-Host "    [OK] Bun is ready (v$bunVersion)" -ForegroundColor Green

# 2. Check node_modules
Write-Host ""
Write-Host "[2/6] Verifying project dependencies..." -ForegroundColor Yellow
if (-not (Test-Path "node_modules")) {
    Write-Host "    Installing dependencies via Bun..." -ForegroundColor Yellow
    bun install
} else {
    Write-Host "    [OK] node_modules verified." -ForegroundColor Green
}

# 3. Check FFmpeg
Write-Host ""
Write-Host "[3/6] Checking FFmpeg (Required for video cutting & subtitles)..." -ForegroundColor Yellow
if (-not (Get-Command "ffmpeg" -ErrorAction SilentlyContinue)) {
    Write-Host "[!] FFmpeg missing. Attempting installation via winget..." -ForegroundColor Yellow
    winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}
if (Get-Command "ffmpeg" -ErrorAction SilentlyContinue) {
    Write-Host "    [OK] FFmpeg is ready!" -ForegroundColor Green
} else {
    Write-Host "    [WARNING] FFmpeg is not found. Please install it with: winget install Gyan.FFmpeg" -ForegroundColor DarkYellow
}

# 4. Check Python & yt-dlp
Write-Host ""
Write-Host "[4/6] Checking yt-dlp (YouTube downloader)..." -ForegroundColor Yellow
if (-not (Get-Command "yt-dlp" -ErrorAction SilentlyContinue)) {
    Write-Host "[!] yt-dlp missing. Attempting to install via pip..." -ForegroundColor Yellow
    python -m pip install --upgrade yt-dlp
}
if (Get-Command "yt-dlp" -ErrorAction SilentlyContinue) {
    $ytdlpVersion = yt-dlp --version
    Write-Host "    [OK] yt-dlp is ready (v$ytdlpVersion)" -ForegroundColor Green
} else {
    Write-Host "    [WARNING] yt-dlp could not be installed. Please run: pip install --upgrade yt-dlp" -ForegroundColor DarkYellow
}

# 5. Check .env and Ollama
Write-Host ""
Write-Host "[5/6] Checking configuration (.env & Ollama)..." -ForegroundColor Yellow
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
    } else {
        @"
PORT=3000
GROQ_API_KEY=
LLM_PROVIDER=groq
GROQ_MODEL=openai/gpt-oss-20b
WHISPER_PROVIDER=groq
WHISPER_MODEL=whisper-large-v3-turbo
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
"@ | Out-File -Encoding utf8 ".env"
    }
    Write-Host "    [i] Generated default .env file." -ForegroundColor Cyan
}

try {
    $res = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 2 -ErrorAction Stop
    Write-Host "    [OK] Ollama is active locally!" -ForegroundColor Green
} catch {
    Write-Host "    [i] Ollama is not running. (Cloud Groq API will be used if GROQ_API_KEY is provided in .env)" -ForegroundColor Gray
}

# 6. Launch Server & Open Browser
Write-Host ""
Write-Host "[6/6] Starting L2S Studio..." -ForegroundColor Green
Write-Host "-------------------------------------------------------" -ForegroundColor Cyan
Write-Host "  URL: http://localhost:3000" -ForegroundColor White
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray
Write-Host "-------------------------------------------------------" -ForegroundColor Cyan
Write-Host ""

Start-Job -ScriptBlock {
    Start-Sleep -Seconds 2
    Start-Process "http://localhost:3000"
} | Out-Null

bun start
