---
name: download-artifact
description: Download a previously shared artifact into the sandbox by its viewer URL.
---

Artifact viewer URL `https://host/?filename` → raw file at `https://host/filename`.

```bash
URL="https://artifacts.example.com/?A1b2C3d4.pdf"; F="${URL#*\?}"; curl -fSL -o "$F" "${URL%%\?*}$F"
```
