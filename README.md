# 🐁 Muaddib - a secure, multi-user AI assistant

<p align="center">
  <a href="https://discord.gg/rGABHaDEww"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord"></a>
  <a href="https://github.com/pasky/muaddib/releases"><img src="https://img.shields.io/github/v/release/pasky/muaddib?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://deepwiki.com/pasky/muaddib"><img src="https://img.shields.io/badge/DeepWiki-muaddib-111111?style=for-the-badge" alt="DeepWiki"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
</p>

**Muaddib** is an AI assistant that's been built from the ground up *not* as a private single-user assistant (such as the amazing Clawdbot / Moltbot), but as a resilient entity operating in an inherently untrusted public environment (public IRC / Discord / Slack servers).

What does it take to talk to many strangers?

1. It operates sandboxed, and with complete channel isolation.
2. It has been optimized for high cost and token efficiency (using a variety of context engineering etc. techniques).
3. It operates in "lurk" mode by default (rather than replying to everything, Muaddib replies when highlighted, but can also interject proactively when it seems useful).

Other work-in-progress features are also going to be tailored to this scenario (e.g. per-user token usage tracking and limiting / billing, per-channel code secrets and persistent workspaces, ...).

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

- **AI Integrations**: Anthropic Claude (Opus 4.5 recommended), OpenAI, DeepSeek, any OpenRouter model (including Gemini models)
- **Agentic Capability**: Ability to visit websites, view images, perform deep research, execute Python/Bash code via Sprites, publish artifacts
- **Restartable and Persistent Memory**: All state is persisted; AI agent maintains a continuous chronicle of events and experiences to refer to
- **Command System**: Automatic model routing (to balance cost, speed and intelligence) plus extensible command-based interaction with prefixes for various modes
- **Proactive Interjecting**: Channel-based whitelist system for automatic participation in relevant conversations
- [BETA] **Long-running Projects**: A *quest* mode (opt-in) that enables Muaddib to work on longer-horizon, many-step tasks in public, using the channel for long-term context and external steering

Muaddib has been **battle-tested since July 2025** in a (slightly) hostile IRC environment, lurking at a variety of [libera.chat](https://libera.chat/) channels.  However, bugs are possible (no warranty etc.) and LLM usage carries some inherent risks (e.g. a Sprites code execution sandbox with your API keys preloaded *plus* an access to the internet [*can* be fooled](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) by a highly crafted malicious website that the agent visits to upload these API keys somewhere).

## Getting Started

### Configuration

All muaddib data lives in `$MUADDIB_HOME` (defaults to `~/.muaddib/`):

```
~/.muaddib/
├── config.json         # Configuration
├── chat_history.db     # Chat history database
├── chronicle.db        # Chronicle database
└── logs/               # Per-message log files
```

Copy `config.json.example` to `~/.muaddib/config.json` (or `$MUADDIB_HOME/config.json`) and set your:
- API keys (you can get started with just a small subset)
- Paths for tools and artifacts (relative paths are resolved against `$MUADDIB_HOME`)
- Custom prompts for various modes
- integration settings such as channel modes

**Tip:** Set `MUADDIB_HOME=.` to use the current directory (useful for development).

### Installation

Recommended for Discord:
1. Follow [Discord setup instructions](docs/discord.md) to create a bot account and obtain a token. Set it in `~/.muaddib/config.json` Discord section.
2. Install dependencies: `npm ci`
3. Build runtime: `npm run build`
4. Run the service: `npm run start`

Recommended for Slack:
1. Follow [Slack setup instructions](docs/slack.md) to create a Slack app, enable Socket Mode, and obtain tokens.
2. Set the Slack config block in `~/.muaddib/config.json`.
3. Install dependencies: `npm ci`
4. Build runtime: `npm run build`
5. Run the service: `npm run start`

Recommended for an IRC bot: See [Docker instructions](docs/docker.md) for running a Muaddib service + irssi in tandem in a Docker compose setup.

Manual for IRC ("bring your own irssi"):
1. Ensure `irssi-varlink` is loaded in your irssi, and your varlink path is set up properly in `~/.muaddib/config.json` IRC section.
2. Install dependencies: `npm ci`
3. Build runtime: `npm run build`
4. Run the service: `npm run start`

> Python runtime note: the Python implementation is now deprecated and kept only as an auxiliary reference while we finish sunset. If you still need to invoke it manually: `uv run muaddib`.

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

### Deprecated Python CLI & tooling (auxiliary)

The legacy Python implementation is deprecated, but still available temporarily for compatibility and reference.

```bash
# Legacy Python CLI invocation
uv run muaddib --message "!h"

# Legacy chronicler commands
uv run muaddib --chronicler "Record: Completed API migration" --arc "project-x"
uv run muaddib --chronicler "Show me the current chapter" --arc "project-x"

# Legacy analysis scripts
uv run python analyze_classifier.py
uv run python analyze_proactive.py --limit 20
```
