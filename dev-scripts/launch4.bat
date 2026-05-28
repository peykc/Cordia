@echo off
cd /d "%~dp0"
echo Current directory: %CD%
echo Setting up instance 4...

set CORDIA_DATA_DIR=C:\Users\peyto\Documents\!My Games\testenv\instance4
set PORT=1423

echo Updating tauri.conf.json for port %PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port = '%PORT%'; $identifier = 'com.cordia.app.instance4'; $file = '%CD%\src-tauri\tauri.conf.json'; if (-not (Test-Path $file)) { Write-Host 'ERROR: File not found: ' $file; exit 1 }; $content = Get-Content $file -Raw; $content = $content -replace 'http://localhost:\d+', \"http://localhost:$port\"; $content = $content -replace '\"identifier\":\s*\"[^\"]+\"', \"`\"identifier`\": `\"$identifier`\"\"; Set-Content $file -Value $content -NoNewline; Write-Host 'Updated devPath to http://localhost:' $port 'and identifier to' $identifier"

if errorlevel 1 (
    echo ERROR: Failed to update tauri.conf.json
    pause
    exit /b 1
)

echo Starting Tauri dev server on port %PORT%...
npm run tauri dev

if errorlevel 1 (
    echo ERROR: Failed to start Tauri
    pause
    exit /b 1
)