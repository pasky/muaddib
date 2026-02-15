import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { Type } from "@sinclair/typebox";

import type { ToolContext, MuaddibTool } from "./types.js";
import { stringifyError } from "../../utils/index.js";

export interface EditArtifactInput {
  artifact_url: string;
  old_string: string;
  new_string: string;
}

export type ShareArtifactExecutor = (content: string) => Promise<string>;
export type EditArtifactExecutor = (input: EditArtifactInput) => Promise<string>;
import { writeArtifactText } from "./artifact-storage.js";
import { createDefaultVisitWebpageExecutor, type VisitWebpageExecutor } from "./web.js";

export function createShareArtifactTool(
  executors: { shareArtifact: ShareArtifactExecutor },
): MuaddibTool {
  return {
    name: "share_artifact",
    persistType: "none",
    label: "Share Artifact",
    description:
      "Share additional content as an artifact and return a public URL. Use for scripts, reports, or large outputs.",
    parameters: Type.Object({
      content: Type.String({
        description: "The text content to publish as an artifact.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const output = await executors.shareArtifact(params.content);
      return {
        content: [{ type: "text", text: output }],
        details: {
          kind: "share_artifact",
        },
      };
    },
  };
}

export function createEditArtifactTool(executors: { editArtifact: EditArtifactExecutor }): MuaddibTool {
  return {
    name: "edit_artifact",
    persistType: "artifact",
    label: "Edit Artifact",
    description:
      "Edit an existing artifact by replacing a unique old_string with new_string and return a new artifact URL.",
    parameters: Type.Object({
      artifact_url: Type.String({
        format: "uri",
        description: "Artifact URL to edit.",
      }),
      old_string: Type.String({
        description: "Exact text to replace; must match uniquely.",
      }),
      new_string: Type.String({
        description: "Replacement text (can be empty).",
      }),
    }),
    execute: async (_toolCallId, params: EditArtifactInput) => {
      const output = await executors.editArtifact(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          artifactUrl: params.artifact_url,
          kind: "edit_artifact",
        },
      };
    },
  };
}

export function createDefaultShareArtifactExecutor(
  options: ToolContext,
): ShareArtifactExecutor {
  return async (content: string): Promise<string> => {
    if (!content.trim()) {
      throw new Error("share_artifact.content must be non-empty.");
    }

    const artifactUrl = await writeArtifactText(options, content, ".txt");
    return `Artifact shared: ${artifactUrl}`;
  };
}

export function createDefaultEditArtifactExecutor(
  options: ToolContext,
): EditArtifactExecutor {
  const visitWebpage = createDefaultVisitWebpageExecutor(options);

  return async (input: EditArtifactInput): Promise<string> => {
    const artifactUrl = input.artifact_url.trim();
    if (!artifactUrl) {
      throw new Error("edit_artifact.artifact_url must be non-empty.");
    }

    if (!input.old_string) {
      throw new Error("edit_artifact.old_string must be non-empty.");
    }

    if (!input.new_string && input.new_string !== "") {
      throw new Error("edit_artifact.new_string must be provided.");
    }

    let sourceContent: string;
    try {
      sourceContent = await loadArtifactContentForEdit(options, artifactUrl, visitWebpage);
    } catch (error) {
      const message = stringifyError(error);
      if (message.includes("Cannot edit binary artifacts")) {
        throw new Error(message);
      }
      throw new Error(`Failed to fetch artifact: ${message}`);
    }

    if (!sourceContent.includes(input.old_string)) {
      throw new Error("edit_artifact.old_string not found in artifact content.");
    }

    const occurrences = countOccurrences(sourceContent, input.old_string);
    if (occurrences > 1) {
      throw new Error(
        `edit_artifact.old_string appears ${occurrences} times; add more surrounding context to make it unique.`,
      );
    }

    const updatedContent = sourceContent.replace(input.old_string, input.new_string);
    const suffix = deriveArtifactSuffixFromUrl(artifactUrl);
    const updatedArtifactUrl = await writeArtifactText(options, updatedContent, suffix);

    return `Artifact edited successfully. New version: ${updatedArtifactUrl}`;
  };
}

async function loadArtifactContentForEdit(
  options: ToolContext,
  artifactUrl: string,
  visitWebpage: VisitWebpageExecutor,
): Promise<string> {
  const localArtifactPath = extractLocalArtifactPath(artifactUrl, options.toolsConfig?.artifacts?.url);
  if (localArtifactPath && options.toolsConfig?.artifacts?.path) {
    if (looksLikeImageUrl(localArtifactPath)) {
      throw new Error("Cannot edit binary artifacts (images).");
    }

    return await readLocalArtifact(options.toolsConfig.artifacts.path, localArtifactPath);
  }

  const fetchedContent = await visitWebpage(artifactUrl);
  if (typeof fetchedContent !== "string") {
    throw new Error("Cannot edit binary artifacts (images).");
  }

  return unwrapVisitWebpageResponse(fetchedContent);
}

async function readLocalArtifact(artifactsPath: string, relativeArtifactPath: string): Promise<string> {
  const artifactsBasePath = resolve(artifactsPath);
  const resolvedArtifactPath = resolve(artifactsBasePath, relativeArtifactPath);
  const relativeToBase = relative(artifactsBasePath, resolvedArtifactPath);

  if (relativeToBase.startsWith("..") || isAbsolute(relativeToBase)) {
    throw new Error("Path traversal detected in artifact URL.");
  }

  return await readFile(resolvedArtifactPath, "utf-8");
}

function deriveArtifactSuffixFromUrl(url: string): string {
  const filename = extractFilenameFromUrl(url) ?? "";
  if (!filename.includes(".")) {
    return ".txt";
  }

  const parts = filename.split(".");
  return `.${parts.slice(1).join(".")}`;
}

function extractFilenameFromUrl(url: string): string | undefined {
  const parsedUrl = new URL(url);
  const queryFilename = extractFilenameFromQuery(parsedUrl.search.slice(1));
  if (queryFilename) {
    return queryFilename;
  }

  const decodedPath = decodeURIComponent(parsedUrl.pathname);
  if (!decodedPath || decodedPath.endsWith("/")) {
    return undefined;
  }

  const pathLeaf = decodedPath.split("/").pop();
  if (!pathLeaf || pathLeaf === "index.html") {
    return undefined;
  }

  return pathLeaf;
}

function extractLocalArtifactPath(url: string, artifactsUrl: string | undefined): string | undefined {
  if (!artifactsUrl) {
    return undefined;
  }

  const base = artifactsUrl.replace(/\/+$/, "");
  if (!(url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`))) {
    return undefined;
  }

  let remainder = url.slice(base.length);
  if (remainder.startsWith("/")) {
    remainder = remainder.slice(1);
  }

  if (remainder.startsWith("?")) {
    return extractFilenameFromQuery(remainder.slice(1));
  }

  if (remainder.startsWith("index.html?")) {
    return extractFilenameFromQuery(remainder.slice("index.html?".length));
  }

  if (remainder.includes("?")) {
    const [pathPart, query] = remainder.split("?", 2);
    if (pathPart === "index.html") {
      return extractFilenameFromQuery(query);
    }
  }

  if (!remainder) {
    return undefined;
  }

  return decodeURIComponent(remainder);
}

function extractFilenameFromQuery(query: string): string | undefined {
  if (!query) {
    return undefined;
  }

  if (!query.includes("=")) {
    return decodeURIComponent(query.trim());
  }

  const params = new URLSearchParams(query);
  const keyBased = params.get("file") ?? params.get("filename");
  if (!keyBased) {
    return undefined;
  }

  const trimmed = keyBased.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function unwrapVisitWebpageResponse(content: string): string {
  if (!content.startsWith("## Content from ")) {
    return content;
  }

  const parts = content.split("\n\n", 2);
  if (parts.length !== 2) {
    return content;
  }

  return parts[1];
}

function countOccurrences(content: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let index = 0;
  let count = 0;

  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) {
      return count;
    }

    count += 1;
    index = found + needle.length;
  }
}

function looksLikeImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(url);
}
