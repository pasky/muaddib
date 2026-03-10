/**
 * Network filtering helpers for Gondolin VMs.
 *
 * CIDR/IP math, internal-range blocking, and the factory for Gondolin's
 * httpHooks option that gates outbound HTTP from the sandbox.
 */

import type { VMOptions } from "@earendil-works/gondolin";

import type { Logger } from "../../app/logging.js";
import {
  checkAndAutoApproveUrlInArc,
  recordRedirectTrustEvent,
} from "../network-boundary.js";

// ── CIDR / IP math ─────────────────────────────────────────────────────────

const INTERNAL_HTTP_BLOCKED_CIDRS = [
  // IPv4
  "0.0.0.0/8",
  "10.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "255.0.0.0/8",
  // IPv6
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
] as const;

function extractIPv4MappedIp(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const mapped = ip.slice("::ffff:".length);
  return mapped.includes(".") ? mapped : null;
}

function isInternalHttpBlockedIp(ip: string): boolean {
  if (INTERNAL_HTTP_BLOCKED_CIDRS.some((cidr) => isIpInCidr(ip, cidr))) {
    return true;
  }

  const mappedIpv4 = extractIPv4MappedIp(ip);
  if (!mappedIpv4) return false;
  return INTERNAL_HTTP_BLOCKED_CIDRS.some((cidr) => isIpInCidr(mappedIpv4, cidr));
}

function parseCidrPrefixLength(rawLength: string, maxLength: number): number | null {
  if (!/^\d+$/.test(rawLength)) return null;
  const prefixLength = Number(rawLength);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxLength) return null;
  return prefixLength;
}

export function isIpInCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.lastIndexOf("/");
  if (slashIdx === -1) return false;
  const prefix = cidr.slice(0, slashIdx);
  const rawLength = cidr.slice(slashIdx + 1);

  if (prefix.includes(":") && ip.includes(":")) {
    const prefixLength = parseCidrPrefixLength(rawLength, 128);
    if (prefixLength === null) return false;
    return isIPv6InPrefix(ip, prefix, prefixLength);
  }
  if (!prefix.includes(":") && !ip.includes(":")) {
    const prefixLength = parseCidrPrefixLength(rawLength, 32);
    if (prefixLength === null) return false;
    return isIPv4InPrefix(ip, prefix, prefixLength);
  }
  return false;
}

function expandIPv6(ip: string): number[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) {
    const val = parseInt(g, 16);
    if (Number.isNaN(val)) return null;
    bytes.push((val >> 8) & 0xff, val & 0xff);
  }
  return bytes;
}

function isIPv6InPrefix(ip: string, prefix: string, length: number): boolean {
  const ipBytes = expandIPv6(ip);
  const prefixBytes = expandIPv6(prefix);
  if (!ipBytes || !prefixBytes) return false;
  const fullBytes = Math.floor(length / 8);
  const remainingBits = length % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== prefixBytes[i]) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff & (0xff << (8 - remainingBits));
    if ((ipBytes[fullBytes]! & mask) !== (prefixBytes[fullBytes]! & mask)) return false;
  }
  return true;
}

function isIPv4InPrefix(ip: string, prefix: string, length: number): boolean {
  const parseIPv4 = (s: string) => {
    const parts = s.split(".").map(Number);
    if (parts.length !== 4 || parts.some((b) => Number.isNaN(b) || b < 0 || b > 255)) return null;
    return parts;
  };
  const ipBytes = parseIPv4(ip);
  const prefixBytes = parseIPv4(prefix);
  if (!ipBytes || !prefixBytes) return false;
  const fullBytes = Math.floor(length / 8);
  const remainingBits = length % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== prefixBytes[i]) return false;
  }
  if (remainingBits > 0) {
    const mask = 0xff & (0xff << (8 - remainingBits));
    if ((ipBytes[fullBytes]! & mask) !== (prefixBytes[fullBytes]! & mask)) return false;
  }
  return true;
}

// ── HTTP hooks factory ─────────────────────────────────────────────────────

export type VmNetworkFetch = NonNullable<VMOptions["fetch"]>;
type VmNetworkFetchInput = Parameters<VmNetworkFetch>[0];
type VmNetworkFetchResponse = Awaited<ReturnType<VmNetworkFetch>>;

export interface VmSecretDefinition {
  hosts: string[];
  value: string;
}

export interface CreateVmHttpHooksOptions {
  arc: string;
  blockedCidrs: string[];
  artifactsUrl?: string;
  autoApproveRegexes?: RegExp[];
  secrets?: Record<string, VmSecretDefinition>;
  logger?: Logger;
  fetchImpl?: VmNetworkFetch;
}

export interface VmHttpHooksResult {
  httpHooks: NonNullable<VMOptions["httpHooks"]>;
  env: Record<string, string>;
  fetch: VmNetworkFetch;
}

/**
 * Build the `httpHooks` option for Gondolin's VM constructor.
 *
 * Dynamically imports `createHttpHooks` from Gondolin so callers don't need
 * a static dependency on the package at import time.
 */
export async function createVmHttpHooks(opts: CreateVmHttpHooksOptions): Promise<VmHttpHooksResult> {
  const { createHttpHooks } = await import("@earendil-works/gondolin");

  const artifactHostname = resolveArtifactHostname(opts.artifactsUrl, opts.logger);
  const allowedHosts = opts.secrets && Object.keys(opts.secrets).length > 0
    // Without this, Gondolin derives the global host allowlist from secret.hosts,
    // which would accidentally block unrelated outbound HTTP whenever any
    // secret-backed env var is configured.
    ? ["*"]
    : undefined;

  const { httpHooks, env = {} } = createHttpHooks({
    allowedHosts,
    secrets: opts.secrets,
    blockInternalRanges: false,
    isRequestAllowed: async (request) => {
      const trust = await checkAndAutoApproveUrlInArc(opts.arc, request.url, {
        autoApproveRegexes: opts.autoApproveRegexes,
      });
      return trust.trusted;
    },
    isIpAllowed: (info) => {
      const isArtifact =
        artifactHostname !== undefined && info.hostname.toLowerCase() === artifactHostname;

      if (!isArtifact && isInternalHttpBlockedIp(info.ip)) {
        return false;
      }

      if (opts.blockedCidrs.length === 0) return true;
      return !opts.blockedCidrs.some((cidr) => isIpInCidr(info.ip, cidr));
    },
  });

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as VmNetworkFetch);
  const trustAwareFetch: VmNetworkFetch = async (input, init) => {
    const response = await fetchImpl(input, init);
    const requestUrl = getFetchInputUrl(input);
    const redirectTarget = resolveRedirectTarget(response, requestUrl);
    if (redirectTarget) {
      await recordRedirectTrustEvent(opts.arc, {
        fromUrl: requestUrl,
        rawUrl: redirectTarget,
      });
    }
    return response;
  };

  return { httpHooks, env, fetch: trustAwareFetch };
}

function getFetchInputUrl(input: VmNetworkFetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as { url: string }).url;
}

function resolveRedirectTarget(response: VmNetworkFetchResponse, requestUrl: string): string | null {
  const location = response.headers.get("location");
  if (!location) {
    return null;
  }
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return null;
  }
  const redirectUrl = new URL(location, requestUrl);
  if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
    return null;
  }
  return redirectUrl.toString();
}

function resolveArtifactHostname(artifactsUrl: string | undefined, logger?: Logger): string | undefined {
  if (!artifactsUrl) return undefined;
  try {
    return new URL(artifactsUrl).hostname.toLowerCase();
  } catch (err) {
    logger?.warn(
      `Ignoring invalid tools.artifacts.url for Gondolin HTTP allowlist: ${artifactsUrl}`,
      String(err),
    );
    return undefined;
  }
}
