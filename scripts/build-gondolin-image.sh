#!/usr/bin/env bash
set -euo pipefail

# Build a custom Gondolin guest image for Muaddib.
#
# The image includes Python 3 (pip, numpy, matplotlib), Node.js, npm (upgraded
# at build time — Alpine 3.23's is broken), uv, Chromium, Playwright,
# poppler-utils, jq, git, imagemagick, and a 4 GB rootfs.
#
# postBuild.commands (run in chroot via container.force) handle npm upgrade,
# Playwright install, and Chromium symlinks at image build time.
# On first boot (checkpoint miss), the init script creates a uv venv at
# /workspace/.venv (persists across image rebuilds since /workspace is a
# host-mounted FUSE directory unavailable at build time) and imports the
# Gondolin MITM CA certificate into an NSS database so Chromium trusts it.
#
# Alpine 3.23 ships Node.js 24 in its main repo, so no version manager is needed.
#
# Usage:
#   ./scripts/build-gondolin-image.sh [OUTPUT_DIR]
#
# OUTPUT_DIR defaults to $MUADDIB_HOME/gondolin-image (~/.muaddib/gondolin-image),
# which muaddib picks up automatically.  Rebuilding changes the image buildId,
# so existing per-arc VM checkpoints are discarded on next use (the
# /workspace mount persists).
#
# The guest sandbox helpers (sandboxd, sandboxfs, ...) are resolved by
# `gondolin build` itself from its helper registry, matching the installed
# gondolin version.
#
# Requirements:
#   - npm ci must have been run (provides node_modules/.bin/gondolin)
#   - mke2fs / mkfs.ext4 (package: e2fsprogs)
#       Debian/Ubuntu: sudo apt install e2fsprogs
#       macOS:         brew install e2fsprogs

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUADDIB_HOME="${MUADDIB_HOME:-$HOME/.muaddib}"
OUTPUT_DIR="${1:-$MUADDIB_HOME/gondolin-image}"
GONDOLIN="${SCRIPT_DIR}/../node_modules/.bin/gondolin"

if [ ! -x "$GONDOLIN" ]; then
  echo "error: gondolin not found at $GONDOLIN — run 'npm ci' first" >&2
  exit 1
fi

BIN_TMPDIR=$(mktemp -d)
trap 'rm -rf "$BIN_TMPDIR"' EXIT

# Playwright's browser registry lives inside the image (not under $HOME, which
# is the host-mounted /workspace at runtime). Set both at build and run time.
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# Helper script to wire Playwright to system Chromium (copied into rootfs,
# executed by postBuild.commands, then deleted).
cat > "$BIN_TMPDIR/wire-playwright-chromium.sh" << 'PWEOF'
#!/bin/sh
set -eu
# Resolve playwright-core from the global playwright install.
cd /usr/lib/node_modules/playwright
# Playwright ignores env vars for the executable path and only checks its own
# registry paths; ask its (internal) registry where it expects each browser.
# Assigned separately so a changed internal API fails the build.
paths=$(node -e '
  const { registry } = require("playwright-core/lib/coreBundle").registry;
  for (const name of ["chromium", "chromium-headless-shell"]) {
    console.log(registry.findExecutable(name).executablePath("linux"));
  }
')
[ -x /usr/bin/chromium-browser ] || { echo "error: /usr/bin/chromium-browser missing" >&2; exit 1; }
for p in $paths; do
  case "$p" in
    /*) ;;
    *) echo "error: unexpected Playwright executable path '$p'" >&2; exit 1 ;;
  esac
  [ -e "$p" ] && continue
  mkdir -p "$(dirname "$p")"
  ln -sf /usr/bin/chromium-browser "$p"
done
PWEOF
chmod +x "$BIN_TMPDIR/wire-playwright-chromium.sh"

# Create an lz4 shim if the lz4 CLI tool is not available.
# gondolin uses `lz4 -l -c` to compress the initramfs in lz4 legacy format.
# The Debian package `lz4` provides the CLI, but python3-lz4 (part of Debian's
# python3-lz4 package) is often installed and can do the same thing.
if ! command -v lz4 &>/dev/null; then
  SYS_PYTHON3=/usr/bin/python3
  if ! "$SYS_PYTHON3" -c "import lz4.block" 2>/dev/null; then
    echo "error: 'lz4' command not found and python3-lz4 not available" >&2
    echo "       Install lz4: sudo apt install lz4" >&2
    echo "       Or install python3-lz4: sudo apt install python3-lz4" >&2
    exit 1
  fi
  echo "Note: 'lz4' CLI not found; using python3-lz4 shim for initramfs compression."
  cat > "$BIN_TMPDIR/lz4" << 'PYEOF'
#!/usr/bin/python3
"""Minimal lz4 legacy-format compressor shim.

Implements `lz4 -l -c` semantics: reads stdin, writes lz4 legacy format to
stdout. Used by gondolin's initramfs build when the lz4 CLI is not installed.
"""
import sys, struct, lz4.block

MAGIC = 0x184C2102
BLOCK_SIZE = 1 << 22  # 4 MB — matches Linux kernel's LZ4_BLOCK_SIZE

sys.stdout.buffer.write(struct.pack('<I', MAGIC))
while True:
    chunk = sys.stdin.buffer.read(BLOCK_SIZE)
    if not chunk:
        break
    compressed = lz4.block.compress(chunk, store_size=False)
    sys.stdout.buffer.write(struct.pack('<I', len(compressed)))
    sys.stdout.buffer.write(compressed)
sys.stdout.buffer.write(struct.pack('<I', 0))  # end-of-stream marker
sys.stdout.buffer.flush()
PYEOF
  chmod +x "$BIN_TMPDIR/lz4"
fi

ARCH=$(node -e "console.log(process.arch === 'arm64' ? 'aarch64' : 'x86_64')")

INIT_EXTRA=$(mktemp /tmp/gondolin-init-extra-XXXXXX.sh)
cat > "$INIT_EXTRA" << 'INITEOF'
# ── Boot-time setup (idempotent, runs under set -eu from parent init) ─────
# npm, Playwright, and Chromium symlinks are pre-installed at image build time
# via postBuild.commands.  The only boot-time task is creating the uv venv in
# /workspace (a host-mounted FUSE directory, unavailable at build time).

[ -d /workspace/.venv ] || uv venv --system-site-packages --seed /workspace/.venv

# Import Gondolin MITM CA into NSS database so Chromium trusts it.
# Chromium uses NSS for cert verification, not the OpenSSL CA bundle.
# HOME is /workspace (set by gondolin env), so Chromium reads ~/.pki/nssdb.
# The NSS DB persists across checkpoints on /workspace, so we skip the
# import when the cert hasn't changed (compared via sha256 stamp file).
mitm_ca_cert="/etc/gondolin/mitm/ca.crt"
if [ -r "${mitm_ca_cert}" ] && command -v certutil > /dev/null 2>&1; then
  nssdb_dir="${HOME}/.pki/nssdb"
  stamp_file="${nssdb_dir}/.mitm-ca-sha256"
  current_hash=$(sha256sum "${mitm_ca_cert}" | cut -d' ' -f1)
  stored_hash=$(cat "${stamp_file}" 2>/dev/null || true)
  if [ "${current_hash}" != "${stored_hash}" ]; then
    mkdir -p "${nssdb_dir}"
    certutil -d "sql:${nssdb_dir}" -N --empty-password 2>/dev/null || true
    certutil -d "sql:${nssdb_dir}" -D -n "gondolin-mitm-ca" 2>/dev/null || true
    certutil -d "sql:${nssdb_dir}" -A -t "C,," -n "gondolin-mitm-ca" -i "${mitm_ca_cert}" 2>/dev/null || true
    printf '%s' "${current_hash}" > "${stamp_file}"
  fi
fi
INITEOF

BUILD_CONFIG=$(mktemp /tmp/gondolin-build-XXXXXX.json)
trap 'rm -f "$BUILD_CONFIG" "$INIT_EXTRA"; rm -rf "$BIN_TMPDIR"' EXIT

# Use absolute paths (postBuild.copy src) so they resolve correctly regardless
# of configDir. gondolin calls path.resolve(configDir, value), which returns
# the absolute path unchanged when value is already absolute.
cat > "$BUILD_CONFIG" << EOF
{
  "arch": "$ARCH",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.7",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [
      "linux-virt",
      "rng-tools",
      "bash",
      "ca-certificates",
      "coreutils",
      "curl",
      "diffutils",
      "file",
      "findutils",
      "gawk",
      "grep",
      "python3",
      "py3-pip",
      "py3-numpy",
      "py3-matplotlib",
      "nodejs",
      "npm",
      "uv",
      "openssh",
      "poppler-utils",
      "sed",
      "tar",
      "chromium",
      "font-noto",
      "jq",
      "git",
      "imagemagick",
      "nss-tools"
    ]
  },
  "rootfs": {
    "label": "gondolin-root",
    "sizeMb": 4096
  },
  "container": {
    "force": true
  },
  "postBuild": {
    "copy": [
      {"src": "$BIN_TMPDIR/wire-playwright-chromium.sh", "dest": "/tmp/wire-playwright-chromium.sh"}
    ],
    "commands": [
      "rm -rf /usr/lib/node_modules/npm && mkdir -p /usr/lib/node_modules/npm && curl -fsSL https://registry.npmjs.org/npm/-/npm-11.2.0.tgz | tar -xz -C /usr/lib/node_modules/npm --strip-components=1",
      "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright",
      "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH sh /tmp/wire-playwright-chromium.sh && rm -f /tmp/wire-playwright-chromium.sh"
    ]
  },
  "init": {
    "rootfsInitExtra": "$INIT_EXTRA"
  },
  "env": {
    "HOME": "/workspace",
    "VIRTUAL_ENV": "/workspace/.venv",
    "PATH": "/workspace/bin:/workspace/.venv/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "CHROME_BIN": "/usr/bin/chromium-browser",
    "PLAYWRIGHT_BROWSERS_PATH": "$PLAYWRIGHT_BROWSERS_PATH"
  }
}
EOF

mkdir -p "$OUTPUT_DIR"

# Ensure sbin directories and our shim directory are on PATH so gondolin can
# find mke2fs (part of e2fsprogs) and our lz4 shim (if lz4 CLI isn't installed)
# even when running as a non-root user whose PATH omits /usr/sbin.
export PATH="$BIN_TMPDIR:/usr/sbin:/sbin:$PATH"

echo ""
echo "Building Gondolin guest image (arch: $ARCH)"
echo "Output: $OUTPUT_DIR"
echo "Downloads Alpine 3.23 packages and creates a 4 GB ext4 image — takes a few minutes."
echo ""

"$GONDOLIN" build --config "$BUILD_CONFIG" --output "$OUTPUT_DIR"

echo ""
echo "Done. Muaddib will use this image automatically on next start."
echo "Custom image written to: $OUTPUT_DIR"
