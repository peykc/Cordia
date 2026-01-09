# Windows Setup Guide

## Prerequisites

To build Tauri applications on Windows, you need the Microsoft Visual C++ Build Tools.

### Option 1: Install Visual Studio Build Tools (Recommended)

1. Download [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)
2. Run the installer
3. Select **"Desktop development with C++"** workload
4. Click Install

### Option 2: Install Visual Studio Community

1. Download [Visual Studio Community](https://visualstudio.microsoft.com/downloads/)
2. During installation, select **"Desktop development with C++"** workload
3. Complete the installation

### Option 3: Use Build Script (Temporary Workaround)

If you have Visual Studio Build Tools installed but PATH is misconfigured, use the provided build script:

```powershell
.\build.ps1
```

## Common Issue: Git's link.exe Conflict

If you see linker errors mentioning "extra operand", Git's `link.exe` is being used instead of MSVC's linker.

**Solution**: The build script (`build.ps1`) temporarily removes Git's bin directory from PATH during compilation.

## Verify Installation

After installing Visual Studio Build Tools, verify Rust can find the linker:

```powershell
rustc --version
rustup show
```

Then try building again:

```powershell
npm run tauri:dev
```





