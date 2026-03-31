import { Type } from "@sinclair/typebox";

import { NetworkBoundaryService } from "../network-boundary-service.js";
import type { MuaddibTool, ToolContext } from "./types.js";

export interface RequestNetworkAccessInput {
  url: string;
  reason?: string;
}

export type RequestNetworkAccessExecutor = (input: RequestNetworkAccessInput) => Promise<string>;

const networkBoundary = new NetworkBoundaryService();

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
  return async (input: RequestNetworkAccessInput): Promise<string> => {
    const result = await networkBoundary.requestAccess(
      {
        arc: options.arc,
        serverTag: options.serverTag,
        channelName: options.channelName,
        gondolinConfig: options.toolsConfig?.gondolin ?? {},
        approver: options.networkAccessApprover,
      },
      input,
    );
    return result.message;
  };
}
