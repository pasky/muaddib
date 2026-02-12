import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  completeSimple,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type UserMessage,
} from "@mariozechner/pi-ai";

import type { ChronicleStore } from "../../chronicle/chronicle-store.js";
import { parseModelSpec } from "../../models/model-spec.js";
import { PiAiModelAdapter } from "../../models/pi-ai-model-adapter.js";

export interface ExecuteCodeInput {
  code: string;
  language?: "python" | "bash";
  input_artifacts?: string[];
  output_files?: string[];
}

export interface EditArtifactInput {
  artifact_url: string;
  old_string: string;
  new_string: string;
}

export interface OracleInput {
  query: string;
}

export interface GenerateImageInput {
  prompt: string;
  image_urls?: string[];
}

export interface ChronicleReadInput {
  relative_chapter_id: number;
}

export interface ChronicleAppendInput {
  text: string;
}

export interface QuestStartInput {
  id: string;
  goal: string;
  success_criteria: string;
}

export interface SubquestStartInput {
  id: string;
  goal: string;
  success_criteria: string;
}

export interface QuestSnoozeInput {
  until: string;
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

export interface VisitWebpageImageResult {
  kind: "image";
  data: string;
  mimeType: string;
}

export type VisitWebpageResult = string | VisitWebpageImageResult;

type CompleteSimpleFn = (
  model: Model<any>,
  context: { messages: UserMessage[]; systemPrompt?: string },
  options?: SimpleStreamOptions,
) => Promise<AssistantMessage>;

export interface BaselineToolExecutors {
  webSearch: (query: string) => Promise<string>;
  visitWebpage: (url: string) => Promise<VisitWebpageResult>;
  executeCode: (input: ExecuteCodeInput) => Promise<string>;
  shareArtifact: (content: string) => Promise<string>;
  editArtifact: (input: EditArtifactInput) => Promise<string>;
  oracle: (input: OracleInput) => Promise<string>;
  generateImage: (input: GenerateImageInput) => Promise<GenerateImageResult>;
  chronicleRead: (input: ChronicleReadInput) => Promise<string>;
  chronicleAppend: (input: ChronicleAppendInput) => Promise<string>;
  questStart: (input: QuestStartInput) => Promise<string>;
  subquestStart: (input: SubquestStartInput) => Promise<string>;
  questSnooze: (input: QuestSnoozeInput) => Promise<string>;
}

export interface DefaultToolExecutorOptions {
  fetchImpl?: typeof fetch;
  jinaApiKey?: string;
  maxWebContentLength?: number;
  maxImageBytes?: number;
  executeCodeTimeoutMs?: number;
  executeCodeWorkingDirectory?: string;
  artifactsPath?: string;
  artifactsUrl?: string;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  modelAdapter?: PiAiModelAdapter;
  completeSimpleFn?: CompleteSimpleFn;
  oracleModel?: string;
  oraclePrompt?: string;
  imageGenModel?: string;
  openRouterBaseUrl?: string;
  imageGenTimeoutMs?: number;
  chronicleStore?: ChronicleStore;
  chronicleArc?: string;
  currentQuestId?: string | null;
}

const DEFAULT_WEB_CONTENT_LIMIT = 40_000;
const DEFAULT_IMAGE_LIMIT = 3_500_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 60_000;
const DEFAULT_CAPTURE_LIMIT = 24_000;
const DEFAULT_IMAGE_GEN_TIMEOUT_MS = 30_000;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_ORACLE_SYSTEM_PROMPT =
  "You are an oracle - a powerful reasoning entity consulted for complex analysis.";
const DEFERRED_QUEST_TOOL_MESSAGE =
  "REJECTED: quests runtime is deferred in the TypeScript runtime (parity v1).";
const ARTIFACT_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const IMAGE_SUFFIX_BY_MIME_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};
const ARTIFACT_VIEWER_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Muaddib Artifact Viewer</title>
  </head>
  <body>
    <pre id="artifact"></pre>
    <script>
      const filename = decodeURIComponent(window.location.search.slice(1));
      if (filename) {
        fetch(filename)
          .then((response) => response.text())
          .then((text) => {
            document.getElementById('artifact').textContent = text;
          })
          .catch(() => {
            document.getElementById('artifact').textContent = 'Failed to load artifact.';
          });
      } else {
        document.getElementById('artifact').textContent = 'No artifact selected.';
      }
    </script>
  </body>
</html>
`;

export function createDefaultToolExecutors(
  options: DefaultToolExecutorOptions = {},
): BaselineToolExecutors {
  return {
    webSearch: createDefaultWebSearchExecutor(options),
    visitWebpage: createDefaultVisitWebpageExecutor(options),
    executeCode: createDefaultExecuteCodeExecutor(options),
    shareArtifact: createDefaultShareArtifactExecutor(options),
    editArtifact: createDefaultEditArtifactExecutor(options),
    oracle: createDefaultOracleExecutor(options),
    generateImage: createDefaultGenerateImageExecutor(options),
    chronicleRead: createDefaultChronicleReadExecutor(options),
    chronicleAppend: createDefaultChronicleAppendExecutor(options),
    questStart: createDefaultQuestStartExecutor(options),
    subquestStart: createDefaultSubquestStartExecutor(options),
    questSnooze: createDefaultQuestSnoozeExecutor(options),
  };
}

function createDefaultWebSearchExecutor(options: DefaultToolExecutorOptions): BaselineToolExecutors["webSearch"] {
  const fetchImpl = getFetch(options);

  return async (query: string): Promise<string> => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new Error("web_search.query must be non-empty.");
    }

    const url = `https://s.jina.ai/?q=${encodeURIComponent(trimmedQuery)}`;
    const response = await fetchImpl(url, {
      headers: buildJinaHeaders(options.jinaApiKey, {
        "X-Respond-With": "no-content",
      }),
    });

    const body = (await response.text()).trim();
    if (response.status === 422 && body.includes("No search results available for query")) {
      return "No search results found. Try a different query.";
    }

    if (!response.ok) {
      throw new Error(`Search failed: Jina HTTP ${response.status}: ${body}`);
    }

    if (!body) {
      return "No search results found. Try a different query.";
    }

    return `## Search Results\n\n${body}`;
  };
}

function createDefaultVisitWebpageExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["visitWebpage"] {
  const fetchImpl = getFetch(options);
  const maxWebContentLength = options.maxWebContentLength ?? DEFAULT_WEB_CONTENT_LIMIT;
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;

  return async (url: string): Promise<VisitWebpageResult> => {
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Invalid URL. Must start with http:// or https://");
    }

    const directHeaders = {
      "User-Agent": "muaddib-ts/1.0",
    };

    let contentType = "";
    try {
      const headResponse = await fetchImpl(url, {
        method: "HEAD",
        headers: directHeaders,
      });
      if (headResponse.ok) {
        contentType = (headResponse.headers.get("content-type") ?? "").toLowerCase();
      }
    } catch {
      // Recovery strategy: some sites disallow HEAD; continue with reader fallback.
    }

    if (contentType.startsWith("image/") || looksLikeImageUrl(url)) {
      const imageResponse = await fetchImpl(url, {
        headers: directHeaders,
      });
      if (!imageResponse.ok) {
        throw new Error(`Failed to download image: HTTP ${imageResponse.status}`);
      }

      const imageMimeType =
        (imageResponse.headers.get("content-type") ?? "image/png").split(";")[0].trim();
      const imageBytes = Buffer.from(await imageResponse.arrayBuffer());
      if (imageBytes.length > maxImageBytes) {
        throw new Error(
          `Image too large (${imageBytes.length} bytes). Maximum allowed: ${maxImageBytes} bytes`,
        );
      }

      return {
        kind: "image",
        data: imageBytes.toString("base64"),
        mimeType: imageMimeType,
      };
    }

    const readerUrl = `https://r.jina.ai/${url}`;
    const response = await fetchImpl(readerUrl, {
      headers: buildJinaHeaders(options.jinaApiKey),
    });

    const body = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`visit_webpage failed: Jina HTTP ${response.status}: ${body}`);
    }

    if (!body) {
      return `## Content from ${url}\n\n(Empty response)`;
    }

    const limitedBody =
      body.length > maxWebContentLength
        ? `${body.slice(0, maxWebContentLength)}\n\n..._Content truncated_...`
        : body;

    return `## Content from ${url}\n\n${limitedBody}`;
  };
}

function createDefaultExecuteCodeExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["executeCode"] {
  const timeoutMs = options.executeCodeTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;
  let workDirPromise: Promise<string> | null = null;
  let versionCounter = 0;

  async function ensureWorkDir(): Promise<string> {
    if (!workDirPromise) {
      workDirPromise = (async () => {
        if (options.executeCodeWorkingDirectory) {
          const fixedDir = resolve(options.executeCodeWorkingDirectory);
          await mkdir(fixedDir, { recursive: true });
          return fixedDir;
        }

        return await mkdtemp(join(tmpdir(), "muaddib-ts-exec-"));
      })();
    }

    return await workDirPromise;
  }

  return async (input: ExecuteCodeInput): Promise<string> => {
    const language = input.language ?? "python";
    if (language !== "python" && language !== "bash") {
      throw new Error(`Unsupported execute_code language '${language}'.`);
    }

    const code = input.code.trim();
    if (!code) {
      throw new Error("execute_code.code must be non-empty.");
    }

    const workDir = await ensureWorkDir();
    versionCounter += 1;

    const extension = language === "python" ? ".py" : ".sh";
    const savedFile = join(workDir, `_v${versionCounter}${extension}`);
    await writeFile(savedFile, input.code, "utf-8");

    const command = language === "python" ? "python3" : "bash";
    const args = [savedFile];

    const execution = await runCommand(command, args, {
      cwd: workDir,
      timeoutMs,
      captureLimit: DEFAULT_CAPTURE_LIMIT,
    });

    const output: string[] = [];

    if (input.input_artifacts && input.input_artifacts.length > 0) {
      output.push("**Warning:** input_artifacts are not yet supported in the TypeScript runtime.");
    }

    if (execution.timedOut) {
      output.push(`**Execution error:** Timed out after ${timeoutMs}ms.`);
    } else if (execution.exitCode !== 0) {
      const stderr = execution.stderr.trim();
      output.push(
        stderr
          ? `**Execution error (exit ${execution.exitCode}):**\n\`\`\`\n${stderr}\n\`\`\``
          : `**Execution error:** Exit code ${execution.exitCode}`,
      );
    }

    if (execution.stdout.trim()) {
      output.push(`**Output:**\n\`\`\`\n${execution.stdout.trim()}\n\`\`\``);
    }

    if (execution.exitCode === 0 && execution.stderr.trim()) {
      output.push(`**Warnings:**\n\`\`\`\n${execution.stderr.trim()}\n\`\`\``);
    }

    if (input.output_files && input.output_files.length > 0) {
      output.push("**Warning:** output_files are not yet supported in the TypeScript runtime.");
    }

    if (output.length === 0) {
      output.push("Code executed successfully with no output.");
    }

    output.push(`_Code saved to \`${savedFile}\` for re-run._`);

    return output.join("\n\n");
  };
}

function createDefaultOracleExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["oracle"] {
  const modelAdapter = options.modelAdapter ?? new PiAiModelAdapter();
  const completeFn = options.completeSimpleFn ?? completeSimple;

  return async (input: OracleInput): Promise<string> => {
    const query = input.query.trim();
    if (!query) {
      throw new Error("oracle.query must be non-empty.");
    }

    const configuredModel = toConfiguredString(options.oracleModel);
    if (!configuredModel) {
      throw new Error("oracle tool requires tools.oracle.model configuration.");
    }

    const resolvedModel = modelAdapter.resolve(configuredModel);
    const systemPrompt = toConfiguredString(options.oraclePrompt) ?? DEFAULT_ORACLE_SYSTEM_PROMPT;

    const response = await completeFn(
      resolvedModel.model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: query,
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: await resolveProviderApiKey(options, String(resolvedModel.model.provider)),
        reasoning: "high",
      },
    );

    const output = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!output) {
      throw new Error("oracle returned empty response.");
    }

    return output;
  };
}

function createDefaultGenerateImageExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["generateImage"] {
  const fetchImpl = getFetch(options);
  const openRouterBaseUrl = (toConfiguredString(options.openRouterBaseUrl) ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_IMAGE_LIMIT;
  const timeoutMs = options.imageGenTimeoutMs ?? DEFAULT_IMAGE_GEN_TIMEOUT_MS;

  return async (input: GenerateImageInput): Promise<GenerateImageResult> => {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error("generate_image.prompt must be non-empty.");
    }

    const configuredModel = toConfiguredString(options.imageGenModel);
    if (!configuredModel) {
      throw new Error("generate_image tool requires tools.image_gen.model configuration.");
    }

    const modelSpec = parseModelSpec(configuredModel);
    if (modelSpec.provider !== "openrouter") {
      throw new Error(`tools.image_gen.model must use openrouter provider, got: ${modelSpec.provider}`);
    }

    const apiKey = await resolveOpenRouterApiKey(options);
    if (!apiKey) {
      throw new Error(
        "generate_image requires OpenRouter API key via providers.openrouter.key or OPENROUTER_API_KEY.",
      );
    }

    const contentBlocks: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
    const imageUrls = input.image_urls ?? [];

    for (const rawImageUrl of imageUrls) {
      const imageUrl = rawImageUrl.trim();
      if (!imageUrl) {
        throw new Error("generate_image.image_urls entries must be non-empty URLs.");
      }

      const dataUrl = await fetchImageAsDataUrl(fetchImpl, imageUrl, maxImageBytes);
      contentBlocks.push({
        type: "image_url",
        image_url: {
          url: dataUrl,
        },
      });
    }

    const responsePayload = await callOpenRouterImageGeneration(fetchImpl, {
      baseUrl: openRouterBaseUrl,
      apiKey,
      modelId: modelSpec.modelId,
      timeoutMs,
      contentBlocks,
    });

    const dataUrls = extractGeneratedImageDataUrls(responsePayload);
    if (dataUrls.length === 0) {
      throw new Error("Image generation failed: No images generated by model.");
    }

    const images: GeneratedImageResultItem[] = [];
    for (const dataUrl of dataUrls) {
      const parsedImage = parseDataUrlImage(dataUrl);
      const imageBytes = Buffer.from(parsedImage.data, "base64");

      if (imageBytes.length > maxImageBytes) {
        throw new Error(
          `Generated image too large (${imageBytes.length} bytes). Maximum allowed: ${maxImageBytes} bytes`,
        );
      }

      const suffix = IMAGE_SUFFIX_BY_MIME_TYPE[parsedImage.mimeType.toLowerCase()] ?? ".png";
      const artifactUrl = await writeArtifactBytes(options, imageBytes, suffix);
      images.push({
        data: parsedImage.data,
        mimeType: parsedImage.mimeType,
        artifactUrl,
      });
    }

    const summaryText = images.map((entry) => `Generated image: ${entry.artifactUrl}`).join("\n");

    return {
      summaryText,
      images,
    };
  };
}

function createDefaultChronicleReadExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["chronicleRead"] {
  return async (input: ChronicleReadInput): Promise<string> => {
    if (!Number.isInteger(input.relative_chapter_id)) {
      throw new Error("chronicle_read.relative_chapter_id must be an integer.");
    }

    const chronicleStore = options.chronicleStore;
    const arc = toConfiguredString(options.chronicleArc);

    if (!chronicleStore || !arc) {
      return "Error: chronicle_read is unavailable because chronicler runtime is deferred in the TypeScript runtime.";
    }

    return await chronicleStore.renderChapterRelative(arc, input.relative_chapter_id);
  };
}

function createDefaultChronicleAppendExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["chronicleAppend"] {
  return async (input: ChronicleAppendInput): Promise<string> => {
    const text = input.text.trim();
    if (!text) {
      throw new Error("chronicle_append.text must be non-empty.");
    }

    const chronicleStore = options.chronicleStore;
    const arc = toConfiguredString(options.chronicleArc);

    if (!chronicleStore || !arc) {
      return "Error: chronicle_append is unavailable because chronicler runtime is deferred in the TypeScript runtime.";
    }

    await chronicleStore.appendParagraph(arc, text);
    return "OK";
  };
}

function createDefaultQuestStartExecutor(
  _options: DefaultToolExecutorOptions,
): BaselineToolExecutors["questStart"] {
  return async (input: QuestStartInput): Promise<string> => {
    if (!toConfiguredString(input.id)) {
      throw new Error("quest_start.id must be non-empty.");
    }

    if (!toConfiguredString(input.goal)) {
      throw new Error("quest_start.goal must be non-empty.");
    }

    if (!toConfiguredString(input.success_criteria)) {
      throw new Error("quest_start.success_criteria must be non-empty.");
    }

    return DEFERRED_QUEST_TOOL_MESSAGE;
  };
}

function createDefaultSubquestStartExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["subquestStart"] {
  return async (input: SubquestStartInput): Promise<string> => {
    if (!toConfiguredString(options.currentQuestId)) {
      return "Error: subquest_start requires an active quest context.";
    }

    if (!toConfiguredString(input.id)) {
      throw new Error("subquest_start.id must be non-empty.");
    }

    if (!toConfiguredString(input.goal)) {
      throw new Error("subquest_start.goal must be non-empty.");
    }

    if (!toConfiguredString(input.success_criteria)) {
      throw new Error("subquest_start.success_criteria must be non-empty.");
    }

    return DEFERRED_QUEST_TOOL_MESSAGE;
  };
}

function createDefaultQuestSnoozeExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["questSnooze"] {
  return async (input: QuestSnoozeInput): Promise<string> => {
    if (!toConfiguredString(options.currentQuestId)) {
      return "Error: quest_snooze requires an active quest context.";
    }

    const until = input.until.trim();
    const match = until.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      return "Error: Invalid time format. Use HH:MM (e.g., 14:30)";
    }

    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
      return "Error: Invalid time. Hours must be 0-23, minutes 0-59";
    }

    return DEFERRED_QUEST_TOOL_MESSAGE;
  };
}

function createDefaultShareArtifactExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["shareArtifact"] {
  return async (content: string): Promise<string> => {
    if (!content.trim()) {
      throw new Error("share_artifact.content must be non-empty.");
    }

    const artifactUrl = await writeArtifactText(options, content, ".txt");
    return `Artifact shared: ${artifactUrl}`;
  };
}

function createDefaultEditArtifactExecutor(
  options: DefaultToolExecutorOptions,
): BaselineToolExecutors["editArtifact"] {
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
      const message = toErrorMessage(error);
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
  options: DefaultToolExecutorOptions,
  artifactUrl: string,
  visitWebpage: BaselineToolExecutors["visitWebpage"],
): Promise<string> {
  const localArtifactPath = extractLocalArtifactPath(artifactUrl, options.artifactsUrl);
  if (localArtifactPath && options.artifactsPath) {
    if (looksLikeImageUrl(localArtifactPath)) {
      throw new Error("Cannot edit binary artifacts (images).");
    }

    return await readLocalArtifact(options.artifactsPath, localArtifactPath);
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

async function writeArtifactText(
  options: DefaultToolExecutorOptions,
  content: string,
  suffix: string,
): Promise<string> {
  const artifactsPath = options.artifactsPath;
  const artifactsUrl = options.artifactsUrl;

  if (!artifactsPath || !artifactsUrl) {
    throw new Error("Artifact tools require tools.artifacts.path and tools.artifacts.url configuration.");
  }

  await ensureArtifactsDirectory(artifactsPath);

  const artifactId = generateArtifactId();
  const normalizedSuffix = suffix.startsWith(".") ? suffix : `.${suffix}`;
  const filename = `${artifactId}${normalizedSuffix}`;
  const filePath = join(artifactsPath, filename);

  await writeFile(filePath, content, "utf-8");

  return toArtifactViewerUrl(artifactsUrl, filename);
}

async function writeArtifactBytes(
  options: DefaultToolExecutorOptions,
  data: Buffer,
  suffix: string,
): Promise<string> {
  const artifactsPath = options.artifactsPath;
  const artifactsUrl = options.artifactsUrl;

  if (!artifactsPath || !artifactsUrl) {
    throw new Error("Artifact tools require tools.artifacts.path and tools.artifacts.url configuration.");
  }

  await ensureArtifactsDirectory(artifactsPath);

  const artifactId = generateArtifactId();
  const normalizedSuffix = suffix.startsWith(".") ? suffix : `.${suffix}`;
  const filename = `${artifactId}${normalizedSuffix}`;
  const filePath = join(artifactsPath, filename);

  await writeFile(filePath, data);

  return toArtifactViewerUrl(artifactsUrl, filename);
}

async function ensureArtifactsDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });

  const indexPath = join(path, "index.html");
  let currentIndex: string | null = null;

  try {
    currentIndex = await readFile(indexPath, "utf-8");
  } catch {
    // Recovery strategy: index file may not exist yet.
  }

  if (currentIndex !== ARTIFACT_VIEWER_HTML) {
    await writeFile(indexPath, ARTIFACT_VIEWER_HTML, "utf-8");
  }
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

function toArtifactViewerUrl(baseUrl: string, filename: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/?${encodeURIComponent(filename)}`;
}

function generateArtifactId(length = 8): string {
  const bytes = randomBytes(length);
  let id = "";

  for (let i = 0; i < length; i += 1) {
    id += ARTIFACT_ID_ALPHABET[bytes[i] % ARTIFACT_ID_ALPHABET.length];
  }

  return id;
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

interface OpenRouterImageGenerationRequest {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  timeoutMs: number;
  contentBlocks: Array<Record<string, unknown>>;
}

async function callOpenRouterImageGeneration(
  fetchImpl: typeof fetch,
  request: OpenRouterImageGenerationRequest,
): Promise<unknown> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, request.timeoutMs);

  try {
    const response = await fetchImpl(`${request.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: [
          {
            role: "user",
            content: request.contentBlocks,
          },
        ],
        modalities: ["image", "text"],
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
      throw new Error(`generate_image request timed out after ${request.timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractGeneratedImageDataUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const response = payload as {
    choices?: Array<{ message?: { images?: unknown[]; content?: unknown } }>;
  };

  const dataUrls: string[] = [];

  const choices = response.choices ?? [];
  for (const choice of choices) {
    const message = choice?.message;
    if (!message || typeof message !== "object") {
      continue;
    }

    const images = Array.isArray(message.images) ? message.images : [];
    for (const imageEntry of images) {
      const url = extractImageUrlFromPayloadEntry(imageEntry);
      if (url && url.startsWith("data:")) {
        dataUrls.push(url);
      }
    }

    if (Array.isArray(message.content)) {
      for (const contentEntry of message.content) {
        if (!contentEntry || typeof contentEntry !== "object") {
          continue;
        }

        const asRecord = contentEntry as Record<string, unknown>;
        const type = asRecord.type;
        if (type !== "image_url") {
          continue;
        }

        const imageUrlPayload = asRecord.image_url;
        if (!imageUrlPayload || typeof imageUrlPayload !== "object") {
          continue;
        }

        const imageUrl = (imageUrlPayload as { url?: unknown }).url;
        if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
          dataUrls.push(imageUrl);
        }
      }
    }
  }

  return dataUrls;
}

function extractImageUrlFromPayloadEntry(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }

  if (!entry || typeof entry !== "object") {
    return undefined;
  }

  const asRecord = entry as {
    url?: unknown;
    image_url?: {
      url?: unknown;
    };
  };

  if (typeof asRecord.url === "string") {
    return asRecord.url;
  }

  if (typeof asRecord.image_url?.url === "string") {
    return asRecord.image_url.url;
  }

  return undefined;
}

interface ParsedDataUrlImage {
  mimeType: string;
  data: string;
}

function parseDataUrlImage(dataUrl: string): ParsedDataUrlImage {
  const match = dataUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match) {
    throw new Error("Image generation returned unsupported image payload format.");
  }

  const mimeType = match[1].trim().toLowerCase();
  const data = match[2].trim();
  if (!mimeType || !data) {
    throw new Error("Image generation returned empty image payload.");
  }

  return {
    mimeType,
    data,
  };
}

async function fetchImageAsDataUrl(
  fetchImpl: typeof fetch,
  imageUrl: string,
  maxImageBytes: number,
): Promise<string> {
  const parsedUrl = new URL(imageUrl);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`Failed to fetch reference image ${imageUrl}: URL must use http:// or https://.`);
  }

  const response = await fetchImpl(imageUrl, {
    headers: {
      "User-Agent": "muaddib-ts/1.0",
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

async function resolveProviderApiKey(
  options: DefaultToolExecutorOptions,
  provider: string,
): Promise<string | undefined> {
  if (!options.getApiKey) {
    return undefined;
  }

  const key = await options.getApiKey(provider);
  return toConfiguredString(key);
}

async function resolveOpenRouterApiKey(options: DefaultToolExecutorOptions): Promise<string | undefined> {
  const fromConfig = await resolveProviderApiKey(options, "openrouter");
  if (fromConfig) {
    return fromConfig;
  }

  return toConfiguredString(process.env.OPENROUTER_API_KEY);
}

function toConfiguredString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonResponseBody(body: string): unknown {
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return {
      raw: body,
    };
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

function getFetch(options: DefaultToolExecutorOptions): typeof fetch {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error("Global fetch API is unavailable.");
  }
  return fetchImpl;
}

function buildJinaHeaders(apiKey?: string, extras: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "muaddib-ts/1.0",
    Accept: "text/plain",
    ...extras,
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function looksLikeImageUrl(url: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(url);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
  captureLimit: number;
}

interface RunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<RunCommandResult> {
  return await new Promise<RunCommandResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout = appendCapturedOutput(stdout, chunk.toString(), options.captureLimit);
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr = appendCapturedOutput(stderr, chunk.toString(), options.captureLimit);
    });

    child.once("error", (error) => {
      clearTimeout(timeoutId);
      rejectPromise(error);
    });

    child.once("close", (code) => {
      clearTimeout(timeoutId);
      resolvePromise({
        exitCode: code ?? (timedOut ? 124 : 1),
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

function appendCapturedOutput(current: string, chunk: string, captureLimit: number): string {
  const combined = current + chunk;
  if (combined.length <= captureLimit) {
    return combined;
  }

  return combined.slice(combined.length - captureLimit);
}
