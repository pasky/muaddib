#!/usr/bin/env bash
set -euo pipefail

# Build a custom Gondolin guest image for Muaddib.
#
# The image includes Python 3 (pip, numpy, matplotlib), Node.js 24, npm, uv,
# and a 1 GB rootfs so the agent has room to install additional packages at runtime.
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MUADDIB_HOME="${MUADDIB_HOME:-$HOME/.muaddib}"
OUTPUT_DIR="${1:-$MUADDIB_HOME/gondolin-image}"
GONDOLIN="${SCRIPT_DIR}/../node_modules/.bin/gondolin"

if [ ! -x "$GONDOLIN" ]; then
  echo "error: gondolin not found at $GONDOLIN — run 'npm ci' first" >&2
  exit 1
fi

if ! command -v mke2fs >/dev/null 2>&1 && ! command -v mkfs.ext4 >/dev/null 2>&1; then
  echo "error: mke2fs not found — install e2fsprogs:" >&2
  echo "  Debian/Ubuntu: sudo apt install e2fsprogs" >&2
  echo "  macOS:         brew install e2fsprogs && export PATH=\"\$(brew --prefix e2fsprogs)/sbin:\$PATH\"" >&2
  exit 1
fi

ARCH=$(node -e "console.log(process.arch === 'arm64' ? 'aarch64' : 'x86_64')")

BUILD_CONFIG=$(mktemp /tmp/gondolin-build-XXXXXX.json)
trap 'rm -f "$BUILD_CONFIG"' EXIT

cat > "$BUILD_CONFIG" << EOF
{
  "arch": "$ARCH",
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
      "python3",
      "py3-pip",
      "py3-numpy",
      "py3-matplotlib",
      "nodejs",
      "npm",
      "uv",
      "openssh"
    ]
  },
  "rootfs": {
    "label": "gondolin-root",
    "sizeMb": 1024
  }
}
EOF

mkdir -p "$OUTPUT_DIR"

echo "Building Gondolin guest image (arch: $ARCH)"
echo "Output: $OUTPUT_DIR"
echo "Downloads Alpine 3.23 packages and creates a 1 GB ext4 image — takes a few minutes."
echo ""

"$GONDOLIN" build --config "$BUILD_CONFIG" --output "$OUTPUT_DIR"

echo ""
echo "Done. Add to your config.json under agent.tools.gondolin:"
echo "  \"guestDir\": \"$OUTPUT_DIR\""
