# Script to create minimal placeholder icons for Tauri

$iconsDir = "src-tauri\icons"
if (-not (Test-Path $iconsDir)) {
    New-Item -ItemType Directory -Path $iconsDir -Force | Out-Null
}

Write-Host "Creating placeholder icons..." -ForegroundColor Green

# Create a minimal valid ICO file (1x1 pixel, 32-bit RGBA)
# This is a minimal valid ICO file structure
$icoBytes = @(
    0x00, 0x00,  # Reserved (must be 0)
    0x01, 0x00,  # Type (1 = ICO)
    0x01, 0x00,  # Number of images
    0x01,        # Width (1 pixel)
    0x01,        # Height (1 pixel)
    0x00,        # Color palette (0 = no palette)
    0x00,        # Reserved
    0x01, 0x00,  # Color planes
    0x20, 0x00,  # Bits per pixel (32)
    0x10, 0x00, 0x00, 0x00,  # Size of image data (16 bytes)
    0x16, 0x00, 0x00, 0x00   # Offset to image data (22 bytes)
) + @(
    # BITMAPINFOHEADER (40 bytes)
    0x28, 0x00, 0x00, 0x00,  # Size of header (40)
    0x01, 0x00, 0x00, 0x00,  # Width (1)
    0x02, 0x00, 0x00, 0x00,  # Height (2, ICO stores double height)
    0x01, 0x00,              # Planes (1)
    0x20, 0x00,              # Bits per pixel (32)
    0x00, 0x00, 0x00, 0x00,  # Compression (0 = none)
    0x00, 0x00, 0x00, 0x00,  # Image size (0 = uncompressed)
    0x00, 0x00, 0x00, 0x00,  # X pixels per meter
    0x00, 0x00, 0x00, 0x00,  # Y pixels per meter
    0x00, 0x00, 0x00, 0x00,  # Colors used
    0x00, 0x00, 0x00, 0x00   # Important colors
) + @(
    # Pixel data (4 bytes: RGBA for 1 pixel)
    0x00, 0x78, 0xD7, 0xFF  # Light blue pixel (you can change this)
)

# Write ICO file
$icoPath = Join-Path $iconsDir "icon.ico"
[System.IO.File]::WriteAllBytes($icoPath, $icoBytes)
Write-Host "Created: $icoPath" -ForegroundColor Green

# Create PNG placeholders using .NET (if available)
try {
    Add-Type -AssemblyName System.Drawing
    
    # Create a simple 32x32 PNG
    $bitmap = New-Object System.Drawing.Bitmap(32, 32)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::FromArgb(0, 120, 215))
    $font = New-Object System.Drawing.Font("Arial", 12, [System.Drawing.FontStyle]::Bold)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $graphics.DrawString("R", $font, $brush, 8, 6)
    $graphics.Dispose()
    
    $png32 = Join-Path $iconsDir "32x32.png"
    $bitmap.Save($png32, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Write-Host "Created: $png32" -ForegroundColor Green
    
    # Create 128x128 PNG
    $bitmap = New-Object System.Drawing.Bitmap(128, 128)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::FromArgb(0, 120, 215))
    $font = New-Object System.Drawing.Font("Arial", 48, [System.Drawing.FontStyle]::Bold)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $graphics.DrawString("R", $font, $brush, 32, 32)
    $graphics.Dispose()
    
    $png128 = Join-Path $iconsDir "128x128.png"
    $bitmap.Save($png128, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Dispose()
    Write-Host "Created: $png128" -ForegroundColor Green
    
    # Copy for 128x128@2x
    Copy-Item $png128 (Join-Path $iconsDir "128x128@2x.png")
    Write-Host "Created: $iconsDir\128x128@2x.png" -ForegroundColor Green
    
    # Create ICNS for macOS (simplified - just copy PNG)
    Copy-Item $png128 (Join-Path $iconsDir "icon.icns")
    Write-Host "Created: $iconsDir\icon.icns" -ForegroundColor Green
    
} catch {
    Write-Host "Could not create PNG icons (System.Drawing not available)" -ForegroundColor Yellow
    Write-Host "ICO file created. PNG icons are optional for Windows builds." -ForegroundColor Yellow
}

Write-Host "`nIcons created! You can replace these with custom icons later." -ForegroundColor Green
