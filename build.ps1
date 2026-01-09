# Build script that fixes PATH for Rust compilation
# Temporarily removes Git's link.exe from PATH to use MSVC linker

$originalPath = $env:PATH
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notlike '*Git\usr\bin*' }) -join ';'

Write-Host "Building with corrected PATH (Git link.exe removed)..." -ForegroundColor Green

try {
    npm run tauri:dev
} finally {
    $env:PATH = $originalPath
}





