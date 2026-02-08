// Script to generate proper icon files for Tauri
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import toIco from 'to-ico';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const iconsDir = path.join(__dirname, 'src-tauri', 'icons');

// Create a simple black square with white C (Cordia)
async function createIcon(size) {
  const svg = `
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" fill="#0a0a0a"/>
      <text x="50%" y="50%" font-family="Arial" font-size="${size * 0.45}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">C</text>
    </svg>
  `;
  
  return sharp(Buffer.from(svg))
    .png()
    .toBuffer();
}

async function generateIcons() {
  console.log('Generating icon files...');
  
  // Generate PNG files
  const sizes = [32, 128, 256];
  const pngBuffers = [];
  
  for (const size of sizes) {
    const buffer = await createIcon(size);
    const filename = size === 256 ? '128x128@2x.png' : `${size}x${size}.png`;
    const filepath = path.join(iconsDir, filename);
    fs.writeFileSync(filepath, buffer);
    console.log(`Generated ${filename}`);
    
    if (size <= 128) {
      pngBuffers.push(buffer);
    }
  }
  
  // Generate ICO file from PNGs
  const icoBuffer = await toIco(pngBuffers);
  const icoPath = path.join(iconsDir, 'icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);
  console.log('Generated icon.ico');
  
  // Generate ICNS file (macOS) - simple placeholder
  // For now, we'll create a minimal ICNS structure
  // ICNS is complex, so we'll use a simple approach
  const icnsPath = path.join(iconsDir, 'icon.icns');
  // For development, we can skip ICNS or create a minimal one
  // Tauri will handle missing ICNS gracefully in dev mode
  if (!fs.existsSync(icnsPath)) {
    // Create a minimal valid ICNS file
    const icnsHeader = Buffer.from('icns', 'ascii');
    const icnsBuffer = Buffer.alloc(8);
    icnsHeader.copy(icnsBuffer, 0);
    icnsBuffer.writeUInt32BE(8, 4); // File size
    fs.writeFileSync(icnsPath, icnsBuffer);
    console.log('Generated icon.icns (placeholder)');
  }
  
  console.log('All icons generated successfully!');
}

generateIcons().catch(console.error);
