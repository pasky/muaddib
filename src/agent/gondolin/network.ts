/**
 * Network filtering helpers for Gondolin VMs.
 *
 * CIDR/IP math, internal-range blocking, the factory for Gondolin's
 * httpHooks option that gates outbound HTTP from the sandbox, and the
 * factory for its credential-injecting SSH egress proxy.
 */

import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";

import type { VMOptions } from "@earendil-works/gondolin";

import type { Logger } from "../../app/logging.js";
import { NetworkBoundaryService } from "../network-boundary-service.js";
import { getRedirectTarget } from "../network-boundary.js";

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

const networkBoundary = new NetworkBoundaryService();

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
    isRequestAllowed: async (request) =>
      await networkBoundary.isRequestAllowed(
        {
          arc: opts.arc,
          autoApproveRegexes: opts.autoApproveRegexes,
        },
        request.url,
      ),
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
    const hostFetchInit = stripGuestHandledHeaders(await bufferStreamingRequestBody(init));
    const requestUrl = getFetchInputUrl(input);
    let response: Awaited<ReturnType<VmNetworkFetch>>;
    try {
      response = await fetchImpl(input, hostFetchInit);
    } catch (err) {
      let safeUrl = requestUrl;
      try {
        const parsed = new URL(requestUrl);
        safeUrl = `${parsed.origin}${parsed.pathname}`;
      } catch {
        // best effort only; keep the original fetch error
      }
      const method = hostFetchInit?.method ?? (
        typeof input === "object" && input !== null && "method" in input && typeof input.method === "string"
          ? input.method
          : "GET"
      );
      opts.logger?.warn(
        `Gondolin host fetch failed ${method.toUpperCase()} ${safeUrl}`,
        err,
        err instanceof Error ? err.cause : undefined,
      );
      throw err;
    }
    const redirectTarget = getRedirectTarget(response, requestUrl);
    if (redirectTarget) {
      await networkBoundary.recordRedirect(
        { arc: opts.arc },
        {
          fromUrl: requestUrl,
          rawUrl: redirectTarget,
        },
      );
    }
    return response;
  };

  return { httpHooks, env, fetch: trustAwareFetch };
}

// ── SSH egress factory ─────────────────────────────────────────────────────

export interface VmSshHostDefinition {
  username: string;
  privateKey: string;
  /** Pinned upstream host public keys (wire blobs). */
  hostKeys: Buffer[];
}

export interface CreateVmSshEgressOptions {
  arc: string;
  /** Keyed by canonical SSH target: "host", or "host:port" for non-default ports. */
  hosts: Record<string, VmSshHostDefinition>;
  logger?: Logger;
}

export interface VmSshEgress {
  ssh: NonNullable<VMOptions["ssh"]>;
  /** Guest path → content of the OpenSSH client config the guest needs to talk to the proxy. */
  guestFiles: Record<string, string>;
}

/**
 * Build the `ssh` option for Gondolin's VM constructor, or undefined when the
 * arc has no SSH hosts (leaving all SSH egress blocked).
 *
 * Gondolin terminates the guest's SSH connection on the host and re-issues each
 * exec request upstream using the host-held private key, so the guest gets
 * authenticated access without ever holding a credential it could leak.
 */
export async function createVmSshEgress(opts: CreateVmSshEgressOptions): Promise<VmSshEgress | undefined> {
  const targets = Object.keys(opts.hosts);
  if (targets.length === 0) return undefined;

  const proxyHostKey = await getSshProxyHostKey();
  const formatTarget = (hostname: string, port: number) => (port === 22 ? hostname : `${hostname}:${port}`);

  return {
    guestFiles: {
      // Every SSH server the guest can reach is the proxy, so its key is trusted for all hosts.
      "/etc/ssh/ssh_known_hosts": `* ${proxyHostKey.publicKey}\n`,
      // OpenSSH 10+ warns on every connection that the key exchange is not post-quantum and
      // that "the server may need to be upgraded". The server it is judging is the proxy, over
      // a hop that never leaves this machine; left in, the agent relays it as a finding about
      // the real upstream host.
      "/etc/ssh/ssh_config.d/muaddib-ssh-proxy.conf": "IgnoreUnknown WarnWeakCrypto\nWarnWeakCrypto no\n",
    },
    ssh: {
      allowedHosts: targets,
      credentials: Object.fromEntries(
        Object.entries(opts.hosts).map(([target, { username, privateKey }]) => [target, { username, privateKey }]),
      ),
      hostKey: proxyHostKey.privateKey,
      hostVerifier: (hostname, key, port) => {
        const pinned = opts.hosts[formatTarget(hostname.toLowerCase(), port)]?.hostKeys ?? [];
        const trusted = pinned.some((hostKey) => hostKey.equals(key));
        if (!trusted) {
          opts.logger?.warn(
            `Gondolin VM [${opts.arc}] ssh host key mismatch for ${hostname}:${port}: ` +
              `server presented ${readSshKeyType(key)} ${key.toString("base64")}, which is not in the configured hostKeys`,
          );
        }
        return trusted;
      },
      execPolicy: (request) => {
        // Quoted: the command is sandbox-controlled and may carry newlines or terminal escapes.
        opts.logger?.info(
          `Gondolin VM [${opts.arc}] ssh exec ${request.hostname}:${request.port}: ${JSON.stringify(request.command)}`,
        );
        return { allow: true };
      },
    },
  };
}

function encodeSshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}

/** Key type name leading an SSH public key wire blob (best effort, for diagnostics). */
function readSshKeyType(blob: Buffer): string {
  return blob.length >= 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString("latin1") : "unknown";
}

interface SshProxyHostKey {
  /** PKCS#1 PEM. */
  privateKey: string;
  /** OpenSSH "<type> <base64>" form. */
  publicKey: string;
}

let sshProxyHostKey: Promise<SshProxyHostKey> | undefined;

/**
 * Guest-facing host key of the SSH proxy, generated once per process.
 *
 * Left to itself Gondolin mints a throwaway key per VM that the guest has no way
 * to verify, so every `ssh` would fail strict host key checking. We supply the
 * key ourselves so its public half can be installed in the guest's known_hosts.
 * RSA in PKCS#1 PEM is the one format both node can export and ssh2 can load.
 */
function getSshProxyHostKey(): Promise<SshProxyHostKey> {
  sshProxyHostKey ??= promisify(generateKeyPair)("rsa", { modulusLength: 3072 }).then(({ publicKey, privateKey }) => {
    const { e, n } = publicKey.export({ format: "jwk" });
    // SSH mpints are signed: prefix a zero byte when the top bit is set.
    const mpint = (base64url: string) => {
      const bytes = Buffer.from(base64url, "base64url");
      return encodeSshString((bytes[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.alloc(1), bytes]) : bytes);
    };
    const blob = Buffer.concat([encodeSshString(Buffer.from("ssh-rsa")), mpint(e!), mpint(n!)]);
    return {
      privateKey: privateKey.export({ format: "pem", type: "pkcs1" }) as string,
      publicKey: `ssh-rsa ${blob.toString("base64")}`,
    };
  });
  return sshProxyHostKey;
}

const MAX_BUFFERED_STREAMING_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

type VmNetworkFetchInit = Parameters<VmNetworkFetch>[1];
type VmNetworkFetchInitWithBody = NonNullable<VmNetworkFetchInit> & { body?: unknown };

async function bufferStreamingRequestBody(init: VmNetworkFetchInit): Promise<VmNetworkFetchInit> {
  if (!init) return init;

  const body = (init as VmNetworkFetchInitWithBody).body;
  if (!isReadableStreamLike(body)) return init;

  return {
    ...init,
    body: await readStreamBody(body),
  } as VmNetworkFetchInit;
}

function stripGuestHandledHeaders(init: VmNetworkFetchInit): VmNetworkFetchInit {
  if (!init) return init;

  const headers = (init as VmNetworkFetchInitWithBody & { headers?: unknown }).headers;
  const strippedHeaders = stripHeaders(headers, ["expect", "content-length"]);
  if (strippedHeaders === headers) return init;

  return {
    ...init,
    headers: strippedHeaders,
  } as VmNetworkFetchInit;
}

function stripHeaders(headers: unknown, headerNames: string[]): unknown {
  return headerNames.reduce((nextHeaders, headerName) => stripHeader(nextHeaders, headerName), headers);
}

function stripHeader(headers: unknown, headerName: string): unknown {
  if (!headers) return headers;
  const normalizedName = headerName.toLowerCase();

  if (headers instanceof Headers) {
    if (!headers.has(headerName)) return headers;
    const nextHeaders = new Headers(headers);
    nextHeaders.delete(headerName);
    return nextHeaders;
  }

  if (Array.isArray(headers)) {
    const nextHeaders = headers.filter((entry) => {
      const name = Array.isArray(entry) ? entry[0] : undefined;
      return typeof name !== "string" || name.toLowerCase() !== normalizedName;
    });
    return nextHeaders.length === headers.length ? headers : nextHeaders;
  }

  if (typeof headers !== "object") return headers;

  let found = false;
  const nextHeaders: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) {
      found = true;
      continue;
    }
    nextHeaders[key] = value;
  }

  return found ? nextHeaders : headers;
}

function isReadableStreamLike(value: unknown): value is ReadableStream<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { getReader?: unknown }).getReader === "function";
}

async function readStreamBody(stream: ReadableStream<unknown>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = bodyChunkToBuffer(value);
    totalBytes += chunk.length;
    if (totalBytes > MAX_BUFFERED_STREAMING_REQUEST_BODY_BYTES) {
      throw new Error(
        `Gondolin streaming HTTP request body exceeds ${MAX_BUFFERED_STREAMING_REQUEST_BODY_BYTES} bytes`,
      );
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, totalBytes);
}

function bodyChunkToBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value);
  throw new Error(`Unsupported streaming HTTP request body chunk: ${typeof value}`);
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
