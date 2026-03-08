# Slack Setup Guide

This guide walks you through creating a Slack app, enabling Socket Mode, and configuring Muaddib's Slack frontend.

## Prerequisites
- Slack workspace admin permissions
- A Slack app that can be installed to your workspace

## 1) Create a Slack App from Manifest
1. Go to https://api.slack.com/apps
2. Click **Create New App** → **From an app manifest**.
3. Select your workspace.
4. Switch to the **YAML** tab and paste the contents of [`slack-manifest.yaml`](slack-manifest.yaml).
5. Review the summary (scopes, events, bot user, socket mode) and click **Create**.

This sets up everything in one shot: bot user, OAuth scopes, event subscriptions, DM support, and Socket Mode.

> **Prefer manual setup?** The manifest configures these bot scopes: `app_mentions:read`, `assistant:write`, `channels:history`, `channels:read`, `chat:write`, `files:read`, `groups:history`, `groups:read`, `im:history`, `im:read`, `mpim:history`, `mpim:read`, `users:read`. Event subscriptions: `app_mention`, `message.channels`, `message.groups`, `message.im`, `message.mpim`. Socket Mode enabled, Messages Tab enabled in App Home.

## 2) Generate Tokens
1. In your app settings, go to **Settings → Basic Information → App-Level Tokens**.
2. Click **Generate Token and Scopes**, add the `connections:write` scope, and create it.
3. Copy the **App Token** (`xapp-...`).
4. Go to **OAuth & Permissions** → **Install to Workspace** (if not already installed).
5. Copy the **Bot User OAuth Token** (`xoxb-...`).

## 3) Configure Muaddib
Edit `~/.muaddib/config.json` (or `$MUADDIB_HOME/config.json`) and add/enable the Slack block under `rooms`:

```json
"slack": {
  "enabled": true,
  "app_token": "xapp-...",
  "workspaces": {
    "T123": {
      "name": "AmazingB2BSaaS",
      "bot_token": "xoxb-..."
    }
  },
  "reply_start_thread": {
    "channel": true,
    "dm": false
  },
  "command": {
    "history_size": 20,
    "response_max_chars": 1600,
    "debounce": 3
  }
}
```

Notes:
- `T123` is the Slack **Team ID** for your workspace. If it's not shown in Workspace Settings, you can grab it from the URL when Slack is open in a browser (`https://app.slack.com/client/T123/...`).
- Slack uses **two tokens**: `xapp-` for Socket Mode connection and `xoxb-` for Web API calls.
- The Slack frontend reuses IRC command prompt/model configuration verbatim.

## 4) Run Muaddib
```bash
npm run start
```


## 5) Test
Mention the bot in a channel:
```
@YourBotName hello
```
The bot should reply in a thread (by default) or in channel based on configuration.

## Troubleshooting
- **No response**: confirm Socket Mode is enabled and the app is running.
- **Permission errors**: ensure the scopes above are granted and the app is installed.
- **Token errors**: verify `xapp-` and `xoxb-` tokens and restart the app.
