import { execFile, type ExecFileOptions } from "node:child_process";

import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { recordUsage } from "../../cost/cost-span.js";
import { LLM_CALL_TYPE } from "../../cost/llm-call-type.js";
import { emptyUsage } from "../../cost/usage.js";
import { parseModelSpec } from "../../models/model-spec.js";
import { stringifyError, toConfiguredString } from "../../utils/index.js";
import { writeArtifactBytes } from "./artifact-storage.js";
import type { ToolContext, MuaddibTool } from "./types.js";
import { extractLocalArtifactPath, resolveLocalArtifactFilePath } from "./url-utils.js";

export interface GenerateImageInput {
  prompt: string;
  image_urls?: string[];
}

export interface GeneratedImageResultItem {
  data: string;
  mimeType: string;
  artifactUrl: string;
}

export interface GenerateImageResult {
  summaryText: string;
  images: GeneratedImageResultItem[];
}

export type GenerateImageExecutor = (input: GenerateImageInput) => Promise<GenerateImageResult>;

const GENERATE_IMAGE_PARAMETERS = Type.Object({
  prompt: Type.String({
    description: "Text description of the image to generate.",
  }),
  image_urls: Type.Optional(
    Type.Array(Type.String({ format: "uri" }), {
      description: "Optional list of reference image URLs to include.",
    }),
  ),
});

const DEFAULT_IMAGE_LIMIT = 3_500_000;
const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 120_000;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const SLOP_WATERMARK_TIMEOUT_MS = 30_000;
const SLOP_WATERMARK_MAX_BUFFER = 1024 * 1024;
const IMAGE_SUFFIX_BY_MIME_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export function createGenerateImageTool(
  executors: { generateImage: GenerateImageExecutor },
  modelId?: string,
): MuaddibTool<typeof GENERATE_IMAGE_PARAMETERS> {
  const modelClause = modelId ? `using ${modelId}` : "using the configured image generation model";
  return {
    name: "generate_image",
    persistType: "summary",
    label: "Generate Image",
    description:
      `Generate image(s) ${modelClause}. Optionally include reference image URLs for edits or variations. This can easily take 5-10 minutes to complete, so bias towards telling the user you are generating an image before calling this tool, so they don't think you got stuck.`,
    parameters: GENERATE_IMAGE_PARAMETERS,
    execute: async (_toolCallId, params: GenerateImageInput) => {
      const output = await executors.generateImage(params);
      return {
        content: [
          { type: "text", text: output.summaryText },
          ...output.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        ],
        details: {
          kind: "generate_image",
          count: output.images.length,
        },
      };
    },
  };
}

export function createDefaultGenerateImageExecutor(
  options: ToolContext,
): GenerateImageExecutor {

  const openRouterBaseUrl = DEFAULT_OPENROUTER_BASE_URL;
  const maxImageBytes = options.toolsConfig?.jina?.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;
  const timeoutMs = options.toolsConfig?.imageGen?.timeoutMs ?? DEFAULT_IMAGE_GEN_TIMEOUT_MS;

  return async (input: GenerateImageInput): Promise<GenerateImageResult> => {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("generate_image.prompt must be non-empty.");
    }

    const configuredModel = toConfiguredString(options.toolsConfig?.imageGen?.model);
    if (!configuredModel) {
      throw new Error("generate_image tool requires tools.imageGen.model configuration.");
    }

    const modelSpec = parseModelSpec(configuredModel);
    if (modelSpec.provider !== "openrouter") {
      throw new Error(`tools.imageGen.model must use openrouter provider, got: ${modelSpec.provider}`);
    }

    const apiKey = await resolveOpenRouterApiKey(options);
    if (!apiKey) {
      throw new Error(
        "generate_image requires OpenRouter API key via providers.openrouter.key or OPENROUTER_API_KEY.",
      );
    }

    const inputReferences: ImageInputReference[] = [];
    const imageUrls = input.image_urls ?? [];

    for (const rawImageUrl of imageUrls) {
      const imageUrl = rawImageUrl.trim();
      if (!imageUrl) {
        throw new Error("generate_image.image_urls entries must be non-empty URLs.");
      }

      const dataUrl = await fetchImageAsDataUrl(
        imageUrl,
        maxImageBytes,
        options.toolsConfig?.artifacts?.url,
      );
      inputReferences.push({
        type: "image_url",
        image_url: {
          url: dataUrl,
        },
      });
    }

    const responsePayload = await callOpenRouterImageGeneration({
      baseUrl: openRouterBaseUrl,
      apiKey,
      modelId: modelSpec.modelId,
      timeoutMs,
      prompt,
      inputReferences,
    });

    recordUsage(
      LLM_CALL_TYPE.GENERATE_IMAGE,
      configuredModel,
      extractUsageFromResponse(responsePayload),
    );

    const generatedImages = extractGeneratedImages(responsePayload);
    if (generatedImages.length === 0) {
      throw new Error("Image generation failed: No images generated by model.");
    }

    const images: GeneratedImageResultItem[] = [];
    for (const generatedImage of generatedImages) {
      const imageBytes = Buffer.from(generatedImage.b64Data, "base64");
      const mimeType = generatedImage.mediaType ?? sniffImageMimeType(imageBytes);
      if (!mimeType) {
        throw new Error("Image generation returned an image of undeterminable format (no media_type, unrecognized bytes).");
      }

      if (imageBytes.length > maxImageBytes) {
        throw new Error(
          `Generated image too large (${imageBytes.length} bytes). Maximum allowed: ${maxImageBytes} bytes`,
        );
      }

      const suffix = IMAGE_SUFFIX_BY_MIME_TYPE[mimeType] ?? ".png";
      const artifactUrl = await writeArtifactBytes(options, imageBytes, suffix);
      await addSlopWatermarkToArtifact(options, artifactUrl);
      images.push({
        data: generatedImage.b64Data,
        mimeType,
        artifactUrl,
      });
    }

    const summaryText = images.map((entry) => `Generated image: ${entry.artifactUrl} (you must mention to the user explicitly)`).join("\n");

    return {
      summaryText,
      images,
    };
  };
}

interface ImageInputReference {
  type: "image_url";
  image_url: { url: string };
}

interface OpenRouterImageGenerationRequest {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  prompt: string;
  inputReferences: ImageInputReference[];
}

async function callOpenRouterImageGeneration(
  request: OpenRouterImageGenerationRequest,
): Promise<unknown> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, request.timeoutMs);

  try {
    // OpenRouter's dedicated Images API. Image-only models (e.g. gpt-image-*)
    // are not served on /chat/completions at all; multimodal chat image models
    // (Gemini image, gpt-5.x-image) are served here too.
    const response = await fetch(`${request.baseUrl}/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        prompt: request.prompt,
        n: 1,
        ...(request.inputReferences.length > 0 ? { input_references: request.inputReferences } : {}),
      }),
      signal: abortController.signal,
    });

    const bodyText = (await response.text()).trim();
    const parsedBody = parseJsonResponseBody(bodyText);

    if (!response.ok) {
      const details = toResponseErrorDetail(parsedBody, bodyText);
      throw new Error(`Image generation failed: OpenRouter HTTP ${response.status}: ${details}`);
    }

    const responseError = extractErrorMessage(parsedBody);
    if (responseError) {
      throw new Error(`Image generation failed: ${responseError}`);
    }

    return parsedBody;
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`generate_image request timed out after ${request.timeoutMs}ms.`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface GeneratedImagePayload {
  b64Data: string;
  /** Absent when the provider could not determine the format. */
  mediaType?: string;
}

/**
 * Extract images from an OpenRouter Images API response:
 * `{ data: [{ b64_json, media_type }], usage }`.
 */
function extractGeneratedImages(payload: unknown): GeneratedImagePayload[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const entries = (payload as { data?: unknown }).data;
  if (!Array.isArray(entries)) {
    return [];
  }

  const images: GeneratedImagePayload[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { b64_json?: unknown; media_type?: unknown };
    if (typeof record.b64_json !== "string" || !record.b64_json.trim()) {
      continue;
    }

    const mediaType = typeof record.media_type === "string" && record.media_type.trim()
      ? normalizeMimeType(record.media_type)
      : undefined;
    images.push({ b64Data: record.b64_json.trim(), mediaType });
  }

  return images;
}

function normalizeMimeType(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase();
  // Normalize non-standard "image/jpg" to the canonical "image/jpeg".
  return lower === "image/jpg" ? "image/jpeg" : lower;
}

/** Identify common raster formats from their magic bytes. */
function sniffImageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return "image/jpeg";
  }
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("latin1"))) {
    return "image/gif";
  }
  return undefined;
}

async function fetchImageAsDataUrl(
  imageUrl: string,
  maxImageBytes: number,
  artifactsUrl: string | undefined,
): Promise<string> {
  const fetchUrl = toRawArtifactReferenceUrl(imageUrl, artifactsUrl);
  const parsedUrl = new URL(fetchUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Failed to fetch reference image ${imageUrl}: URL must use http:// or https://.`);
  }

  const response = await fetch(fetchUrl, {
    headers: {
      "User-Agent": "muaddib/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch reference image ${imageUrl}: HTTP ${response.status}.`);
  }

  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(
      `Failed to fetch reference image ${imageUrl}: URL is not an image (content-type: ${contentType || "unknown"}).`,
    );
  }

  const imageBytes = Buffer.from(await response.arrayBuffer());
  if (imageBytes.length > maxImageBytes) {
    throw new Error(
      `Failed to fetch reference image ${imageUrl}: Image too large (${imageBytes.length} bytes). Maximum allowed: ${maxImageBytes} bytes.`,
    );
  }

  return `data:${contentType};base64,${imageBytes.toString("base64")}`;
}

function toRawArtifactReferenceUrl(imageUrl: string, artifactsUrl: string | undefined): string {
  const artifactPath = extractLocalArtifactPath(imageUrl, artifactsUrl);
  if (!artifactPath || !artifactsUrl) {
    return imageUrl;
  }

  const encodedPath = artifactPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${artifactsUrl.replace(/\/+$/, "")}/${encodedPath}`;
}

async function resolveOpenRouterApiKey(options: ToolContext): Promise<string | undefined> {
  const key = toConfiguredString(await options.authStorage.getApiKey("openrouter"));
  if (key) return key;
  return toConfiguredString(process.env.OPENROUTER_API_KEY);
}

async function addSlopWatermarkToArtifact(options: ToolContext, artifactUrl: string): Promise<void> {
  try {
    const filePath = resolveLocalArtifactFilePath(
      artifactUrl,
      options.toolsConfig?.artifacts?.url,
      options.toolsConfig?.artifacts?.path,
    );
    if (!filePath) {
      options.logger?.warn(`Failed to add slop watermark: generated artifact URL did not resolve locally: ${artifactUrl}`);
      return;
    }

    await execFileAsync("convert", [
      filePath,
      "-gravity",
      "SouthEast",
      "-pointsize",
      "20",
      "-fill",
      "rgba(255,255,255,0.6)",
      "-stroke",
      "rgba(0,0,0,0.8)",
      "-strokewidth",
      "1",
      "-annotate",
      "+10+10",
      "🍌slop",
      filePath,
    ], {
      timeout: SLOP_WATERMARK_TIMEOUT_MS,
      maxBuffer: SLOP_WATERMARK_MAX_BUFFER,
    });
  } catch (error) {
    options.logger?.warn(`Failed to add slop watermark to ${artifactUrl}: ${stringifyError(error)}`);
  }
}

function execFileAsync(file: string, args: string[], options: ExecFileOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function parseJsonResponseBody(body: string): unknown {
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`Expected JSON response body, got: ${body.slice(0, 200)}`);
  }
}

function toResponseErrorDetail(parsedBody: unknown, rawBody: string): string {
  const fromParsed = extractErrorMessage(parsedBody);
  if (fromParsed) {
    return fromParsed;
  }

  if (rawBody) {
    return rawBody;
  }

  return "(empty response body)";
}

function extractErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const asRecord = value as Record<string, unknown>;
  const directError = asRecord.error;

  if (typeof directError === "string") {
    return directError;
  }

  if (directError && typeof directError === "object") {
    const message = (directError as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  return undefined;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

function extractUsageFromResponse(payload: unknown): Usage {
  const usage = emptyUsage();
  if (!payload || typeof payload !== "object") return usage;

  const raw = (payload as Record<string, unknown>).usage;
  if (!raw || typeof raw !== "object") return usage;

  const u = raw as Record<string, unknown>;
  if (typeof u.prompt_tokens === "number") usage.input = u.prompt_tokens;
  if (typeof u.completion_tokens === "number") usage.output = u.completion_tokens;
  if (typeof u.total_tokens === "number") usage.totalTokens = u.total_tokens;

  // OpenRouter reports USD cost via usage.cost (legacy: native_tokens_cost / total_cost).
  const nativeCost = u.native_tokens_cost;
  const totalCost = u.total_cost;
  const cost = u.cost;
  if (typeof cost === "number" && cost > 0) {
    usage.cost.total = cost;
  } else if (typeof nativeCost === "number" && nativeCost > 0) {
    usage.cost.total = nativeCost;
  } else if (typeof totalCost === "number" && totalCost > 0) {
    usage.cost.total = totalCost;
  }

  return usage;
}
