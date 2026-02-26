---
name: download-artifact
description: Save a previously shared artifact URL to a file
---

Artifact viewer URL `https://host/?filename` → raw file at `https://host/filename`.

```bash
URL="https://artifacts.example.com/?A1b2C3d4.pdf"; F="${URL#*\?}"; curl -fSL -o "$F" "${URL%%\?*}$F"
```
