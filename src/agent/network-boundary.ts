import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getMuaddibHome } from "../config/paths.js";

export const NETWORK_TRUST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type NetworkTrustSource = "web_search" | "visit_webpage" | "approval" | "redirect";

export interface NetworkTrustEvent {
  ts: string;
  source: NetworkTrustSource;
  rawUrl: string;
  canonicalUrl: string;
  fromCanonicalUrl?: string;
}

export interface RecordNetworkTrustInput {
  source: Exclude<NetworkTrustSource, "redirect">;
  rawUrl: string;
}

export interface RecordRedirectTrustInput {
  rawUrl: string;
  fromUrl: string;
}

export interface NetworkAccessApprovalRequest {
  arc: string;
  url: string;
  canonicalUrl: string;
  reason?: string;
}

export interface NetworkAccessApprovalResult {
  approved: boolean;
  message?: string;
}

export interface NetworkTrustCheckResult {
  canonicalUrl: string;
  trusted: boolean;
  autoApproved: boolean;
}

export type NetworkAccessApprover = (
  request: NetworkAccessApprovalRequest,
) => Promise<NetworkAccessApprovalResult | boolean> | NetworkAccessApprovalResult | boolean;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function getRedirectTarget(
  response: { status: number; headers: { get(name: string): string | null } },
  currentUrl: string,
): string | null {
  const location = response.headers.get("location");
  if (!location || !REDIRECT_STATUSES.has(response.status)) {
    return null;
  }

  try {
    const redirectUrl = new URL(location, currentUrl);
    if (redirectUrl.protocol !== "http:" && redirectUrl.protocol !== "https:") {
      return null;
    }
    return redirectUrl.toString();
  } catch {
    return null;
  }
}

export function canonicalizeNetworkTrustUrl(rawUrl: string): string {
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Unsupported network trust URL protocol: ${parsedUrl.protocol}`);
  }

  parsedUrl.protocol = parsedUrl.protocol.toLowerCase();
  parsedUrl.username = "";
  parsedUrl.password = "";
  parsedUrl.hostname = parsedUrl.hostname.toLowerCase();
  parsedUrl.search = "";
  parsedUrl.hash = "";

  if (!parsedUrl.pathname) {
    parsedUrl.pathname = "/";
  }

  if ((parsedUrl.protocol === "http:" && parsedUrl.port === "80") ||
      (parsedUrl.protocol === "https:" && parsedUrl.port === "443")) {
    parsedUrl.port = "";
  }

  return parsedUrl.toString();
}

export function getArcNetworkTrustLedgerPath(arc: string): string {
  return join(getMuaddibHome(), "arcs", arc, "network-trust.jsonl");
}

export async function loadArcNetworkTrustEvents(arc: string): Promise<NetworkTrustEvent[]> {
  const ledgerPath = getArcNetworkTrustLedgerPath(arc);
  try {
    const content = await readFile(ledgerPath, "utf-8");
    if (!content.trim()) {
      return [];
    }

    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => parseNetworkTrustEvent(line, ledgerPath));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function isCanonicalUrlTrustedInArc(
  arc: string,
  canonicalUrl: string,
  now = new Date(),
): Promise<boolean> {
  const cutoff = now.getTime() - NETWORK_TRUST_TTL_MS;
  const events = await loadArcNetworkTrustEvents(arc);
  return events.some((event) => event.canonicalUrl === canonicalUrl && parseEventTimestamp(event) >= cutoff);
}

export async function isUrlTrustedInArc(
  arc: string,
  rawUrl: string,
  now = new Date(),
): Promise<boolean> {
  return isCanonicalUrlTrustedInArc(arc, canonicalizeNetworkTrustUrl(rawUrl), now);
}

export async function checkAndAutoApproveUrlInArc(
  arc: string,
  rawUrl: string,
  options?: { autoApproveRegexes?: ReadonlyArray<RegExp>; now?: Date },
): Promise<NetworkTrustCheckResult> {
  const now = options?.now ?? new Date();
  const canonicalUrl = canonicalizeNetworkTrustUrl(rawUrl);
  if (await isCanonicalUrlTrustedInArc(arc, canonicalUrl, now)) {
    return { canonicalUrl, trusted: true, autoApproved: false };
  }

  const autoApproveRegexes = options?.autoApproveRegexes ?? [];
  if (!autoApproveRegexes.some((regex) => regex.test(canonicalUrl))) {
    return { canonicalUrl, trusted: false, autoApproved: false };
  }

  await recordNetworkTrustEvent(arc, {
    source: "approval",
    rawUrl,
  }, now);

  return { canonicalUrl, trusted: true, autoApproved: true };
}

export async function recordNetworkTrustEvent(
  arc: string,
  input: RecordNetworkTrustInput,
  now = new Date(),
): Promise<NetworkTrustEvent> {
  const event: NetworkTrustEvent = {
    ts: now.toISOString(),
    source: input.source,
    rawUrl: input.rawUrl,
    canonicalUrl: canonicalizeNetworkTrustUrl(input.rawUrl),
  };
  await appendNetworkTrustEvents(arc, [event]);
  return event;
}

export async function recordNetworkTrustEvents(
  arc: string,
  inputs: ReadonlyArray<RecordNetworkTrustInput>,
  now = new Date(),
): Promise<NetworkTrustEvent[]> {
  if (inputs.length === 0) {
    return [];
  }

  const events = inputs.map((input) => ({
    ts: now.toISOString(),
    source: input.source,
    rawUrl: input.rawUrl,
    canonicalUrl: canonicalizeNetworkTrustUrl(input.rawUrl),
  })) satisfies NetworkTrustEvent[];

  await appendNetworkTrustEvents(arc, events);
  return events;
}

export async function recordRedirectTrustEvent(
  arc: string,
  input: RecordRedirectTrustInput,
  now = new Date(),
): Promise<NetworkTrustEvent> {
  const event: NetworkTrustEvent = {
    ts: now.toISOString(),
    source: "redirect",
    rawUrl: input.rawUrl,
    canonicalUrl: canonicalizeNetworkTrustUrl(input.rawUrl),
    fromCanonicalUrl: canonicalizeNetworkTrustUrl(input.fromUrl),
  };
  await appendNetworkTrustEvents(arc, [event]);
  return event;
}

function parseNetworkTrustEvent(line: string, ledgerPath: string): NetworkTrustEvent {
  const parsed = JSON.parse(line) as Partial<NetworkTrustEvent>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid network trust ledger entry in ${ledgerPath}: ${line}`);
  }
  if (typeof parsed.ts !== "string" ||
      typeof parsed.source !== "string" ||
      typeof parsed.rawUrl !== "string" ||
      typeof parsed.canonicalUrl !== "string") {
    throw new Error(`Malformed network trust ledger entry in ${ledgerPath}: ${line}`);
  }
  if (parsed.fromCanonicalUrl !== undefined && typeof parsed.fromCanonicalUrl !== "string") {
    throw new Error(`Malformed redirect trust entry in ${ledgerPath}: ${line}`);
  }

  return parsed as NetworkTrustEvent;
}

function parseEventTimestamp(event: NetworkTrustEvent): number {
  const timestamp = Date.parse(event.ts);
  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid network trust timestamp: ${event.ts}`);
  }
  return timestamp;
}

async function appendNetworkTrustEvents(
  arc: string,
  events: ReadonlyArray<NetworkTrustEvent>,
): Promise<void> {
  const ledgerPath = getArcNetworkTrustLedgerPath(arc);
  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(
    ledgerPath,
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf-8",
  );
}
