#!/usr/bin/env bash
set -euo pipefail

# Build a custom Gondolin guest image for Muaddib.
#
# The image includes Python 3 (pip, numpy, matplotlib), Node.js, npm (upgraded),
# uv, Chromium, Playwright, poppler-utils, jq, git, imagemagick, a uv venv with
# pip (created on first boot), and a 4 GB rootfs so the agent has room to install
# additional packages at runtime.
#
# Alpine 3.23 ships Node.js 24 in its main repo, so no version manager is needed.
#
# Usage:
#   ./scripts/build-gondolin-image.sh [OUTPUT_DIR]
#
# OUTPUT_DIR defaults to ~/.muaddib/gondolin-image
# After building, set agent.tools.gondolin.guestDir in config.json to OUTPUT_DIR.
#
# Requirements:
#   - npm ci must have been run (gondolin is a devDependency)
#   - mke2fs / mkfs.ext4 (package: e2fsprogs)
#       Debian/Ubuntu: sudo apt install e2fsprogs
#       macOS:         brew install e2fsprogs
#   - debugfs (part of e2fsprogs, at /usr/sbin/debugfs on Debian/Ubuntu)
#     Used to extract pre-built sandbox binaries from the default gondolin image.
#   - The default gondolin image must have been cached (run 'gondolin bash' once,
#     or it will be downloaded automatically on first VM launch).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUADDIB_HOME="${MUADDIB_HOME:-$HOME/.muaddib}"
OUTPUT_DIR="${1:-$MUADDIB_HOME/gondolin-image}"
GONDOLIN="${SCRIPT_DIR}/../node_modules/.bin/gondolin"
DEBUGFS="${DEBUGFS:-/usr/sbin/debugfs}"

if [ ! -x "$GONDOLIN" ]; then
  echo "error: gondolin not found at $GONDOLIN — run 'npm ci' first" >&2
  exit 1
fi

if [ ! -x "$DEBUGFS" ]; then
  echo "error: debugfs not found at $DEBUGFS" >&2
  echo "       Install e2fsprogs: sudo apt install e2fsprogs" >&2
  exit 1
fi

# Locate the cached gondolin rootfs containing pre-built sandbox binaries.
# Gondolin caches assets at ~/.cache/gondolin/<version>/rootfs.ext4.
GONDOLIN_CACHE_DIR="$HOME/.cache/gondolin"
CACHED_ROOTFS=""
if [ -d "$GONDOLIN_CACHE_DIR" ]; then
  CACHED_ROOTFS=$(find "$GONDOLIN_CACHE_DIR" -name "rootfs.ext4" | head -1)
fi

if [ -z "$CACHED_ROOTFS" ]; then
  echo "error: no cached gondolin rootfs found in $GONDOLIN_CACHE_DIR" >&2
  echo "       Run the default gondolin image once to populate the cache:" >&2
  echo "         node_modules/.bin/gondolin bash" >&2
  echo "       (Ctrl-C once you see the shell prompt)" >&2
  exit 1
fi

echo "Using cached gondolin rootfs: $CACHED_ROOTFS"

# Extract pre-built Zig sandbox binaries from the cached rootfs using debugfs.
# This avoids needing the gondolin source tree or a Zig toolchain.
BIN_TMPDIR=$(mktemp -d)
trap 'rm -rf "$BIN_TMPDIR"' EXIT

echo "Extracting pre-built sandbox binaries from cached image..."
for BIN in sandboxd sandboxfs sandboxssh sandboxingress; do
  "$DEBUGFS" -R "dump /usr/bin/$BIN $BIN_TMPDIR/$BIN" "$CACHED_ROOTFS" 2>/dev/null
  if [ ! -f "$BIN_TMPDIR/$BIN" ]; then
    echo "error: failed to extract $BIN from $CACHED_ROOTFS" >&2
    exit 1
  fi
  chmod +x "$BIN_TMPDIR/$BIN"
done
echo "Extracted: sandboxd, sandboxfs, sandboxssh, sandboxingress"

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
# Upgrade npm — Alpine 3.23's bundled version is broken
rm -rf /usr/lib/node_modules/npm
mkdir -p /usr/lib/node_modules/npm
curl -fsSL https://registry.npmjs.org/npm/-/npm-11.2.0.tgz \
  | tar -xz -C /usr/lib/node_modules/npm --strip-components=1

# Create uv venv with system site-packages
[ -d /opt/venv ] || uv venv --system-site-packages --seed /opt/venv

# Install Playwright and wire it to system Chromium.
# Playwright's chromium.launch() won't honour env vars for the executable path —
# it only looks in its own browser registry paths.  We install the npm package
# (skipping the bundled browser download, which wouldn't work on Alpine/musl
# anyway) and then create symlinks from every path Playwright expects to the
# real system Chromium binary.
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g playwright

# Discover the paths Playwright will probe for chromium / headless-shell and
# symlink them to the Alpine system Chromium.
node -e '
  const { registry } = require("playwright-core/lib/server");
  for (const name of ["chromium", "chromium-headless-shell"]) {
    const exe = registry.findExecutable(name);
    if (exe) console.log(exe.executablePath("linux"));
  }
' 2>/dev/null | while read -r p; do
  mkdir -p "$(dirname "$p")"
  ln -sf /usr/bin/chromium-browser "$p"
done
INITEOF

BUILD_CONFIG=$(mktemp /tmp/gondolin-build-XXXXXX.json)
trap 'rm -f "$BUILD_CONFIG" "$INIT_EXTRA"; rm -rf "$BIN_TMPDIR"' EXIT

# Use absolute paths for sandboxXxxPath so they resolve correctly regardless
# of configDir. gondolin calls path.resolve(configDir, value), which returns
# the absolute path unchanged when value is already absolute.
cat > "$BUILD_CONFIG" << EOF
{
  "arch": "$ARCH",
  "sandboxdPath": "$BIN_TMPDIR/sandboxd",
  "sandboxfsPath": "$BIN_TMPDIR/sandboxfs",
  "sandboxsshPath": "$BIN_TMPDIR/sandboxssh",
  "sandboxingressPath": "$BIN_TMPDIR/sandboxingress",
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "kernelImage": "vmlinuz-virt",
    "rootfsPackages": [
      "linux-virt",
      "rng-tools",
      "bash",
      "ca-certificates",
      "curl",
      "file",
      "python3",
      "py3-pip",
      "py3-numpy",
      "py3-matplotlib",
      "nodejs",
      "npm",
      "uv",
      "openssh",
      "poppler-utils",
      "chromium",
      "font-noto",
      "jq",
      "git",
      "imagemagick"
    ]
  },
  "rootfs": {
    "label": "gondolin-root",
    "sizeMb": 4096
  },
  "init": {
    "rootfsInitExtra": "$INIT_EXTRA"
  },
  "env": {
    "VIRTUAL_ENV": "/opt/venv",
    "PATH": "/opt/venv/bin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "CHROME_BIN": "/usr/bin/chromium-browser"
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
