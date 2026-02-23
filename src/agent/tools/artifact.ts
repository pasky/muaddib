import { extname } from "node:path";

import { Type } from "@sinclair/typebox";

import type { ArtifactContext, MuaddibTool } from "./types.js";
import { writeArtifactBytes } from "./artifact-storage.js";

export interface ShareArtifactInput {
  file_path: string;
}

export type ShareArtifactExecutor = (input: ShareArtifactInput) => Promise<string>;

/**
 * Read a file from the sandbox VM as a Buffer.
 * Injected by the gondolin tool set.
 */
export type SandboxReadFile = (absolutePath: string) => Promise<Buffer>;

export function createShareArtifactTool(
  executors: { shareArtifact: ShareArtifactExecutor },
): MuaddibTool {
  return {
    name: "share_artifact",
    persistType: "summary",
    label: "Share Artifact",
    description:
      "Publish a file from the sandbox as a shareable artifact URL. Use for scripts, reports, images, data files, or any large output.",
    parameters: Type.Object({
      file_path: Type.String({
        description: "Path to the file inside the sandbox to publish as an artifact.",
      }),
    }),
    execute: async (_toolCallId, params: ShareArtifactInput) => {
      const output = await executors.shareArtifact(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "share_artifact",
          filePath: params.file_path,
        },
      };
    },
  };
}

export function createDefaultShareArtifactExecutor(
  options: ArtifactContext,
  readFile: SandboxReadFile,
): ShareArtifactExecutor {
  return async (input: ShareArtifactInput): Promise<string> => {
    const filePath = input.file_path?.trim();
    if (!filePath) {
      throw new Error("share_artifact.file_path must be non-empty.");
    }

    const data = await readFile(filePath);
    const suffix = extname(filePath) || ".bin";
    const artifactUrl = await writeArtifactBytes(options, data, suffix);
    return `Artifact shared: ${artifactUrl}`;
  };
}
