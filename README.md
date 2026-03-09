# 🐁 Muaddib - a secure, multi-user AI assistant

<p align="center">
  <a href="https://discord.gg/rGABHaDEww"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/pasky/muaddib/releases"><img src="https://img.shields.io/github/v/release/pasky/muaddib?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://deepwiki.com/pasky/muaddib"><img src="https://img.shields.io/badge/DeepWiki-muaddib-111111?style=for-the-badge" alt="DeepWiki"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Muaddib** is an AI agent that's been built from the ground up *not* as a private single-user assistant (such as OpenClaw), but as a resilient entity operating in an inherently untrusted public environment (public IRC / Discord / Slack servers).

What does it take to talk to many strangers?

1. It operates sandboxed, and with complete channel isolation.
2. It has been optimized for high cost and token efficiency (using a variety of context engineering etc. techniques).
3. It operates in "lurk" mode by default (rather than replying to everything, Muaddib replies when highlighted, but can also interject proactively when it seems useful).

Of course, this means a tradeoff. Muaddib is not designed to sift through your email and manage your personal calendar!

It is tailored for **public and team environments, where it's useful to have an AI agent as a "virtual teammate"** - both as an AI colleague in chat for public many-to-many collaboration, and allowing personal or per-channel contexts.

## Quick Demo

Muaddib maintains a refreshing, very un-assistanty tone of voice that **optimizes for short, curt responses** (sometimes sarcastic, always informative) with great information density.
And you may quickly find that Muaddib (in this case equipped with Opus 4.5) can [do things](https://x.com/xpasky/status/2009380722855890959?s=20) that official Claude app does much worse (let alone other apps like ChatGPT or Gemini!).

![An example interaction](https://pbs.twimg.com/media/G-LAw3NXIAA-uSm?format=jpg&name=large)

[➜ Generated image](https://pbs.twimg.com/media/G-LAy5yXcAAhV4d?format=jpg&name=large)

_(By the way, the token usage has been optimized since!)_

Of course, as with any AI agent, the real magic is in chatting back and forth. (Multiple conversations with several people involved can go on simultaneously on a channel and Muaddib will keep track!)

![A followup discussion](https://pbs.twimg.com/media/G-LA59SXAAAv_5w?format=png&name=4096x4096)

[(➜ Generated image, in case you are curious)](https://pbs.twimg.com/media/G-LA8VGWAAED6sn?format=jpg&name=large)

_(Note that this particular task is on the edge of raw Opus 4.5 capability and all other harnesses and apps I tried failed it completely.)_

Discord is of course supported:

![Discord screenshot](docs/images/discord-screenshot.jpg)

So is Slack - including threads:

![Slack screenshot](docs/images/slack-screenshot.jpg)

## Features

- **AI Integrations**: Anthropic Claude (Opus 4.6 recommended), OpenAI, DeepSeek, any OpenRouter model (including Gemini models)
- **Agentic Capability**: Ability to visit websites, view images, perform deep research, fully sandboxed and isolated code execution and long-term state maintenance, publish artifacts; each channel/DM gets a persistent sandboxed workspace with long-term state (code, data, installed packages)
- **Continuous Learning**: AI agent maintains short-term memory (smart context engineering), mid-term memory (a scratchpad), and long-term memory both episodic (a continuous chronicle of events and experiences) and procedural (automatically maintained skills)
- **Command System**: Automatic model routing (to balance cost, speed and intelligence) plus multiple, extensible "command modes" based on specific prefixes
- **Proactive Interjecting**: Lurk-by-default with a opt-in automatic participation in relevant conversations

Muaddib has been **battle-tested since July 2025** in a (slightly) hostile IRC environment, lurking at a variety of [libera.chat](https://libera.chat/) channels.  However, bugs are possible (no warranty etc.) and LLM usage carries some inherent risks (e.g. a code execution sandbox with your API keys preloaded *plus* an access to the internet [*can* be fooled](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) by a highly crafted malicious website that the agent visits to upload these API keys somewhere).

## Getting Started

### Configuration

All muaddib data lives in `$MUADDIB_HOME` (defaults to `~/.muaddib/`):

```
~/.muaddib/
├── config.json         # Configuration (no secrets)
├── auth.json           # API keys and secrets
├── arcs/               # Per-arc data (one subdir per channel/DM)
│   └── <arc>/
│       ├── chat_history/   # JSONL chat logs (one file per day)
│       ├── chronicle/      # Markdown chronicle entries
│       ├── workspace/      # Gondolin VM persistent workspace (mounted at /workspace)
│       └── checkpoint.qcow2  # Gondolin VM disk checkpoint
├── artifacts/          # Published artifacts
└── logs/               # Per-message log files
```

1. Copy `config.json.example` to `~/.muaddib/config.json` and configure:
   - Provider endpoints and model settings
   - Paths for tools and artifacts (relative paths are resolved against `$MUADDIB_HOME`)
   - Custom prompts for various modes
   - Room integration settings (channels, modes, proactive behavior)

2. Copy `auth.json.example` to `~/.muaddib/auth.json` and set your API keys:
   - Provider keys (`anthropic`, `openai`, `openrouter`, `deepseek`, etc.)
   - Tool keys (`jina`, `brave`)
   - Room tokens (`discord`, `slack-app`, `slack-{workspaceId}`)

**Tip:** Set `MUADDIB_HOME=.` to use the current directory (useful for development).

**Migrating from older versions:** If you previously had API keys in `config.json`, run `npx tsx scripts/migrate-auth.ts` to extract them into `auth.json`, then manually remove the secret fields from `config.json`.

### Installation

Before using Muaddib's sandboxed read/write/edit/bash tools, install QEMU on the host:

```bash
# Debian/Ubuntu
sudo apt install qemu-system qemu-utils

# macOS
brew install qemu
```

If you see `spawnSync qemu-img ENOENT`, it means the `qemu-img` helper is missing - on Debian/Ubuntu that usually means `qemu-utils` is not installed.

Recommended for Discord:
1. Follow [Discord setup instructions](docs/discord.md) to create a bot account and obtain a token. Set it in `~/.muaddib/auth.json` as the `discord` key.
2. Install dependencies: `npm ci`
3. Build runtime: `npm run build`
4. Run the service: `npm run start`

Recommended for Slack:
1. Follow [Slack setup instructions](docs/slack.md) to create a Slack app, enable Socket Mode, and obtain tokens.
2. Set the Slack config block in `~/.muaddib/config.json` and tokens in `~/.muaddib/auth.json`.
3. Install dependencies: `npm ci`
4. Build runtime: `npm run build`
5. Run the service: `npm run start`

Recommended for an IRC bot: See [Docker instructions](docs/docker.md) for running a Muaddib service + irssi in tandem in a Docker compose setup.

Manual for IRC ("bring your own irssi"):
1. Ensure `irssi-varlink` is loaded in your irssi, and your varlink path is set up properly in `~/.muaddib/config.json` IRC section.
2. Install dependencies: `npm ci`
3. Build runtime: `npm run build`
4. Run the service: `npm run start`

### Gondolin Sandbox Image

Muaddib runs agent code in isolated QEMU micro-VMs (Gondolin).
The default image downloaded by gondolin is a minimal Alpine Linux with basic utilities.
For a more capable environment (Python 3 with pip/numpy/matplotlib, Node.js 24, npm, uv, 1 GB rootfs), build a custom image:

```bash
# Requires e2fsprogs (for mke2fs + debugfs) and either lz4 or python3-lz4:
#   Debian/Ubuntu: sudo apt install e2fsprogs lz4
#                  (python3-lz4 can substitute if lz4 CLI is unavailable)
./scripts/build-gondolin-image.sh
```

The image is written to `$MUADDIB_HOME/gondolin-image/` and picked up automatically on next start.
The 1 GB rootfs gives the agent room to `apk add` or `pip install` further packages; those changes persist across checkpoints within an arc.

### Commands

- `mynick: message` - Automatic mode
- `mynick: !h` - Show help and info about other modes

## Architecture

Muaddib is built on the [`pi-coding-agent`](https://github.com/badlogic/pi-mono) SDK (`@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`) for its agent runtime, but defines its own complete tool set (code execution, web search, artifacts, etc.) — pi's built-in tools are not used.

## Development

```bash
# Install dependencies
npm ci

# Typecheck + tests
npm run typecheck
npm test

# Build
npm run build
```

### CLI Testing Mode (TypeScript)

You can test command parsing and response flow from the command line:

```bash
npm run cli:message -- --message "!h"
npm run cli:message -- --message "tell me a joke"
npm run cli:message -- --message "!d tell me a joke"
npm run cli:message -- --message "!a summarize https://python.org"
# Or with explicit config:
# npm run cli:message -- --message "!a summarize https://python.org" --config /path/to/config.json
```

This simulates full room command handling without running the full chat service.
