import type { GondolinConfig } from "../config/muaddib-config.js";
import { resolveUrlAllowRegexes } from "./gondolin/env.js";
import {
  checkAndAutoApproveUrlInArc,
  recordNetworkTrustEvent,
  recordNetworkTrustEvents,
  recordRedirectTrustEvent,
  type NetworkAccessApprover,
  type NetworkAccessApprovalResult,
  type NetworkTrustCheckResult,
  type RecordRedirectTrustInput,
} from "./network-boundary.js";

export interface NetworkBoundaryContext {
  arc: string;
  serverTag?: string;
  channelName?: string;
  gondolinConfig?: GondolinConfig;
  autoApproveRegexes?: ReadonlyArray<RegExp>;
  approver?: NetworkAccessApprover;
}

export interface RequestNetworkAccessInput {
  url: string;
  reason?: string;
}

export interface RequestNetworkAccessResult {
  canonicalUrl: string;
  approved: boolean;
  autoApproved: boolean;
  message: string;
}

export class NetworkBoundaryService {
  async checkUrlTrust(
    context: NetworkBoundaryContext,
    rawUrl: string,
  ): Promise<NetworkTrustCheckResult> {
    return await checkAndAutoApproveUrlInArc(context.arc, rawUrl, {
      autoApproveRegexes: this.resolveAutoApproveRegexes(context),
    });
  }

  async ensureUrlTrustedForVisit(context: NetworkBoundaryContext, rawUrl: string): Promise<string> {
    const trust = await this.checkUrlTrust(context, rawUrl);
    if (trust.trusted) {
      return trust.canonicalUrl;
    }

    throw new Error(
      `Network access denied for ${trust.canonicalUrl}. Use web_search or request_network_access first.`,
    );
  }

  async isRequestAllowed(context: NetworkBoundaryContext, rawUrl: string): Promise<boolean> {
    return (await this.checkUrlTrust(context, rawUrl)).trusted;
  }

  async requestAccess(
    context: NetworkBoundaryContext,
    input: RequestNetworkAccessInput,
  ): Promise<RequestNetworkAccessResult> {
    const trust = await this.checkUrlTrust(context, input.url);
    if (trust.trusted) {
      return {
        canonicalUrl: trust.canonicalUrl,
        approved: true,
        autoApproved: trust.autoApproved,
        message: trust.autoApproved
          ? `Network access auto-approved by config for ${trust.canonicalUrl}.`
          : `Network access already trusted for ${trust.canonicalUrl}.`,
      };
    }

    const approver = context.approver;
    if (!approver) {
      throw new Error("request_network_access requires a harness-provided networkAccessApprover.");
    }

    const approval = this.normalizeApprovalResult(await approver({
      arc: context.arc,
      url: input.url,
      canonicalUrl: trust.canonicalUrl,
      reason: input.reason,
    }));

    if (!approval.approved) {
      return {
        canonicalUrl: trust.canonicalUrl,
        approved: false,
        autoApproved: false,
        message: approval.message ?? `Network access denied for ${trust.canonicalUrl}.`,
      };
    }

    await recordNetworkTrustEvent(context.arc, {
      source: "approval",
      rawUrl: input.url,
    });

    return {
      canonicalUrl: trust.canonicalUrl,
      approved: true,
      autoApproved: false,
      message: approval.message ?? `Network access approved for ${trust.canonicalUrl}.`,
    };
  }

  async recordSearchResultUrls(context: NetworkBoundaryContext, rawUrls: ReadonlyArray<string>): Promise<void> {
    await recordNetworkTrustEvents(
      context.arc,
      rawUrls.map((rawUrl) => ({ source: "web_search" as const, rawUrl })),
    );
  }

  async recordVisit(context: NetworkBoundaryContext, rawUrl: string): Promise<void> {
    await recordNetworkTrustEvent(context.arc, {
      source: "visit_webpage",
      rawUrl,
    });
  }

  async recordRedirect(
    context: NetworkBoundaryContext,
    input: RecordRedirectTrustInput,
  ): Promise<void> {
    await recordRedirectTrustEvent(context.arc, input);
  }

  private resolveAutoApproveRegexes(context: NetworkBoundaryContext): ReadonlyArray<RegExp> {
    if (context.autoApproveRegexes) {
      return context.autoApproveRegexes;
    }

    return resolveUrlAllowRegexes({
      config: context.gondolinConfig ?? {},
      serverTag: context.serverTag,
      channelName: context.channelName,
    });
  }

  private normalizeApprovalResult(value: NetworkAccessApprovalResult | boolean): NetworkAccessApprovalResult {
    if (typeof value === "boolean") {
      return { approved: value };
    }

    if (!value || typeof value !== "object" || typeof value.approved !== "boolean") {
      throw new Error(`Invalid network access approval result: ${JSON.stringify(value)}`);
    }

    if (value.message !== undefined && typeof value.message !== "string") {
      throw new Error(`Invalid network access approval message: ${JSON.stringify(value.message)}`);
    }

    return value;
  }
}
