import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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

export interface VisitWebpageImageResult {
  kind: "image";
  data: string;
  mimeType: string;
}

export type VisitWebpageResult = string | VisitWebpageImageResult;

export interface BaselineToolExecutors {
  webSearch: (query: string) => Promise<string>;
  visitWebpage: (url: string) => Promise<VisitWebpageResult>;
  executeCode: (input: ExecuteCodeInput) => Promise<string>;
  shareArtifact: (content: string) => Promise<string>;
  editArtifact: (input: EditArtifactInput) => Promise<string>;
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
}

const DEFAULT_WEB_CONTENT_LIMIT = 40_000;
const DEFAULT_IMAGE_LIMIT = 3_500_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 60_000;
const DEFAULT_CAPTURE_LIMIT = 24_000;
const ARTIFACT_ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
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
