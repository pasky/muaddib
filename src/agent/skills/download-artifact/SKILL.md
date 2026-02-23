---
name: download-artifact
description: Download a previously shared artifact into the sandbox by its viewer URL.
---

# Download Artifact

When you need to download an artifact that was previously shared via `share_artifact`
(or any artifact URL from this system), use this procedure inside the sandbox.

## Artifact URL format

Artifact viewer URLs look like:

    https://<host>/?<filename>

For example: `https://artifacts.example.com/?A1b2C3d4.pdf`

The raw file is served at the same host with the filename as the path:

    https://<host>/<filename>

## How to download

Extract the filename from the query string and construct the raw URL:

```bash
# Given a viewer URL, download the raw artifact file:
# Example: https://artifacts.example.com/?A1b2C3d4.pdf
curl -fSL -o /workspace/A1b2C3d4.pdf "https://artifacts.example.com/A1b2C3d4.pdf"
```

To automate extraction from a viewer URL:

```bash
URL="https://artifacts.example.com/?A1b2C3d4.pdf"
FILENAME="${URL#*\?}"
BASE="${URL%%\?*}"
curl -fSL -o "/workspace/$FILENAME" "${BASE}${FILENAME}"
```

## Notes

- Always save downloaded artifacts to `/workspace/` so they persist across sessions.
- The `-f` flag makes curl fail on HTTP errors instead of saving error pages.
- The `-L` flag follows redirects.
