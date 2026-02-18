#!/usr/bin/env npx tsx
/**
 * One-shot migration script: extracts secrets from config.json → auth.json.
 *
 * Usage:
 *   MUADDIB_HOME=~/.muaddib npx tsx scripts/migrate-auth.ts
 *
 * Does NOT modify config.json — you must remove the secret fields manually.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const muaddibHome = process.env.MUADDIB_HOME || join(process.env.HOME!, ".muaddib");
const configPath = join(muaddibHome, "config.json");
const authPath = join(muaddibHome, "auth.json");

if (!existsSync(configPath)) {
  console.error(`Config file not found: ${configPath}`);
  process.exit(1);
}

if (existsSync(authPath)) {
  console.error(`auth.json already exists at ${authPath} — aborting to avoid overwriting.`);
  process.exit(1);
}

interface AuthCredential {
  type: "api_key";
  key: string;
}

const config = JSON.parse(readFileSync(configPath, "utf-8"));
const auth: Record<string, AuthCredential> = {};
const extracted: string[] = [];

// Extract provider keys
const providers = config.providers ?? {};
for (const [name, cfg] of Object.entries(providers) as [string, any][]) {
  const key = cfg?.key?.trim();
  if (key) {
    auth[name] = { type: "api_key", key };
    extracted.push(`providers.${name}.key`);
  }
}

// Extract tool keys
if (config.tools?.jina?.api_key?.trim()) {
  auth.jina = { type: "api_key", key: config.tools.jina.api_key.trim() };
  extracted.push("tools.jina.api_key");
}
if (config.tools?.sprites?.token?.trim()) {
  auth.sprites = { type: "api_key", key: config.tools.sprites.token.trim() };
  extracted.push("tools.sprites.token");
}

// Extract room tokens
const rooms = config.rooms ?? {};

// Discord
const discordToken = rooms.discord?.token?.trim();
if (discordToken) {
  auth.discord = { type: "api_key", key: discordToken };
  extracted.push("rooms.discord.token");
}

// Slack app token
const slackAppToken = rooms.slack?.app_token?.trim();
if (slackAppToken) {
  auth["slack-app"] = { type: "api_key", key: slackAppToken };
  extracted.push("rooms.slack.app_token");
}

// Slack workspace bot tokens
const workspaces = rooms.slack?.workspaces ?? {};
for (const [wsId, wsCfg] of Object.entries(workspaces) as [string, any][]) {
  const botToken = wsCfg?.bot_token?.trim();
  if (botToken) {
    auth[`slack-${wsId}`] = { type: "api_key", key: botToken };
    extracted.push(`rooms.slack.workspaces.${wsId}.bot_token`);
  }
}

if (extracted.length === 0) {
  console.log("No secrets found in config.json — nothing to migrate.");
  process.exit(0);
}

writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", "utf-8");

console.log(`Created ${authPath} with ${extracted.length} credential(s):\n`);
for (const path of extracted) {
  console.log(`  ✓ ${path}`);
}
console.log(`\nNow manually remove these fields from ${configPath}.`);
