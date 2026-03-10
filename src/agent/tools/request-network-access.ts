import { Type } from "@sinclair/typebox";

import {
  checkAndAutoApproveUrlInArc,
  type NetworkAccessApprovalResult,
  recordNetworkTrustEvent,
} from "../network-boundary.js";
import { resolveGondolinUrlAllowRegexes } from "../gondolin/env.js";
import type { MuaddibTool, ToolContext } from "./types.js";

export interface RequestNetworkAccessInput {
  url: string;
  reason?: string;
}

export type RequestNetworkAccessExecutor = (input: RequestNetworkAccessInput) => Promise<string>;

export function createRequestNetworkAccessTool(
  executors: { requestNetworkAccess: RequestNetworkAccessExecutor },
): MuaddibTool {
  return {
    name: "request_network_access",
    persistType: "summary",
    label: "Request Network Access",
    description:
      "Request approval to trust a URL for outbound HTTP if access has been denied. Access is allowed for URLs from websearch, configured allow rules, URLs from other trusted URLs, or URLs allowed previously.",
    parameters: Type.Object({
      url: Type.String({
        format: "uri",
        description: "The URL to trust for outbound HTTP in this arc.",
      }),
      reason: Type.Optional(Type.String({
        description: "Optional explanation of why this network access is needed (context for approval decision).",
      })),
    }),
    execute: async (_toolCallId, params: RequestNetworkAccessInput) => {
      const output = await executors.requestNetworkAccess(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          url: params.url,
          reason: params.reason,
        },
      };
    },
  };
}

export function createDefaultRequestNetworkAccessExecutor(
  options: ToolContext,
): RequestNetworkAccessExecutor {
  const autoApproveRegexes = resolveGondolinUrlAllowRegexes({
    config: options.toolsConfig?.gondolin ?? {},
    serverTag: options.serverTag,
    channelName: options.channelName,
  });

  return async (input: RequestNetworkAccessInput): Promise<string> => {
    const trust = await checkAndAutoApproveUrlInArc(options.arc, input.url, {
      autoApproveRegexes,
    });
    if (trust.trusted) {
      return trust.autoApproved
        ? `Network access auto-approved by config for ${trust.canonicalUrl}.`
        : `Network access already trusted for ${trust.canonicalUrl}.`;
    }

    const approver = options.networkAccessApprover;
    if (!approver) {
      throw new Error("request_network_access requires a harness-provided networkAccessApprover.");
    }

    const approval = normalizeApprovalResult(await approver({
      arc: options.arc,
      url: input.url,
      canonicalUrl: trust.canonicalUrl,
      reason: input.reason,
    }));

    if (!approval.approved) {
      return approval.message ?? `Network access denied for ${trust.canonicalUrl}.`;
    }

    await recordNetworkTrustEvent(options.arc, {
      source: "approval",
      rawUrl: input.url,
    });

    return approval.message ?? `Network access approved for ${trust.canonicalUrl}.`;
  };
}

function normalizeApprovalResult(value: NetworkAccessApprovalResult | boolean): NetworkAccessApprovalResult {
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
