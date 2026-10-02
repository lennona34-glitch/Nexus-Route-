#!/usr/bin/env python3
"""
Nexus DLSS 5 Runtime Installer & Verifier
Downloads and installs the native D3D12 DLSS 5 (NGX Feature 18) worker into E:\\dlss5_runtime.
"""

import os
import sys
import argparse
import urllib.request
import zipfile
import shutil
from pathlib import Path

# Force UTF-8 on Windows console
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

RUNTIME_DIR = Path("E:/dlss5_runtime")
RELEASE_URL = (
    "https://github.com/Merserk/dlss5-visual-enhancer/releases/download/3.0/"
    "DLSS.5.Visual.Enhancer.v3.0.zip"
)

REQUIRED_FILES = [
    "nvngx.dll",
    "nvngx_dlss.dll",
    "nvngx_dlssnr.dll",
    "dxgi.dll",
    "renodx-dlss5.addon64",
]


def check_installed(target_dir: Path = RUNTIME_DIR) -> bool:
    if not target_dir.exists():
        return False
    for req in REQUIRED_FILES:
        if not (target_dir / req).exists():
            return False
    return True


def install_runtime(target_dir: Path = RUNTIME_DIR, force: bool = False) -> bool:
    target_dir.mkdir(parents=True, exist_ok=True)
    if check_installed(target_dir) and not force:
        print(f"[DLSS5 Setup] Runtime already installed and verified at: {target_dir}")
        return True

    print(f"[DLSS5 Setup] Installing NVIDIA DLSS 5 Runtime to: {target_dir}")
    print(f"[DLSS5 Setup] Source: {RELEASE_URL}")

    zip_path = target_dir / "dlss5_runtime_archive.zip"
    try:
        # Download archive
        print(f"[DLSS5 Setup] Downloading release archive (~467 MB)...")
        with urllib.request.urlopen(RELEASE_URL) as response, zip_path.open("wb") as sink:
            total = int(response.headers.get("Content-Length") or 0)
            received = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                sink.write(block)
                received += len(block)
                if total:
                    pct = received * 100 // total
                    print(f"\r  Downloading: {pct:3d}%  {received / 1e6:6.1f} / {total / 1e6:.1f} MB", end="")
                else:
                    print(f"\r  Downloading: {received / 1e6:6.1f} MB", end="")
        print("\n[DLSS5 Setup] Download finished. Extracting required runtime binaries...")

        # Extract only needed binaries
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.infolist():
                name = member.filename.replace("\\", "/")
                # Extract bin/runtime files into target_dir root
                if "/bin/runtime/" in name or name.startswith("bin/runtime/"):
                    base = os.path.basename(name)
                    if base:
                        with zf.open(member) as src, (target_dir / base).open("wb") as dst:
                            shutil.copyfileobj(src, dst)
                            print(f"  -> Extracted: {base}")
                # Extract ffmpeg/ffprobe if needed
                elif "/bin/ffmpeg/bin/" in name or name.startswith("bin/ffmpeg/bin/"):
                    base = os.path.basename(name)
                    if base:
                        with zf.open(member) as src, (target_dir / base).open("wb") as dst:
                            shutil.copyfileobj(src, dst)
                            print(f"  -> Extracted: {base}")

        # Clean up zip file
        if zip_path.exists():
            zip_path.unlink()

        if check_installed(target_dir):
            print(f"[OK] DLSS 5 Runtime successfully installed to: {target_dir}")
            return True
        else:
            print(f"[ERROR] Some required runtime files were missing after extraction.")
            return False

    except Exception as e:
        print(f"[ERROR] Failed to download or install DLSS 5 runtime: {e}")
        if zip_path.exists():
            try:
                zip_path.unlink()
            except Exception:
                pass
        return False


def main():
    parser = argparse.ArgumentParser(description="Nexus DLSS 5 Runtime Installer")
    parser.add_argument("--check", action="store_true", help="Check if runtime is installed")
    parser.add_argument("--force", action="store_true", help="Force re-download and re-install")
    parser.add_argument("--dir", type=str, default=str(RUNTIME_DIR), help="Target runtime directory")
    args = parser.parse_args()

    target = Path(args.dir)
    if args.check:
        installed = check_installed(target)
        print(f"[STATUS] DLSS 5 Runtime Installed: {installed} ({target})")
        sys.exit(0 if installed else 1)

    success = install_runtime(target, force=args.force)
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
