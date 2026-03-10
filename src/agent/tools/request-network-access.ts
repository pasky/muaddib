import { Type } from "@sinclair/typebox";

import {
  canonicalizeNetworkTrustUrl,
  isUrlTrustedInArc,
  type NetworkAccessApprovalResult,
  recordNetworkTrustEvent,
} from "../network-boundary.js";
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
      "Request approval to trust a URL for outbound HTTP if access has been denied. Access is allowed for URLs from websearch, URLs from other trusted URLs, or URLs allowed previously.",
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
  return async (input: RequestNetworkAccessInput): Promise<string> => {
    const canonicalUrl = canonicalizeNetworkTrustUrl(input.url);
    if (await isUrlTrustedInArc(options.arc, input.url)) {
      return `Network access already trusted for ${canonicalUrl}.`;
    }

    const approver = options.networkAccessApprover;
    if (!approver) {
      throw new Error("request_network_access requires a harness-provided networkAccessApprover.");
    }

    const approval = normalizeApprovalResult(await approver({
      arc: options.arc,
      url: input.url,
      canonicalUrl,
      reason: input.reason,
    }));

    if (!approval.approved) {
      return approval.message ?? `Network access denied for ${canonicalUrl}.`;
    }

    await recordNetworkTrustEvent(options.arc, {
      source: "approval",
      rawUrl: input.url,
    });

    return approval.message ?? `Network access approved for ${canonicalUrl}.`;
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
