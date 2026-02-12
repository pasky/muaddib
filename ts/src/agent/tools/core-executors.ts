import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ExecuteCodeInput {
  code: string;
  language?: "python" | "bash";
  input_artifacts?: string[];
  output_files?: string[];
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
}

export interface DefaultToolExecutorOptions {
  fetchImpl?: typeof fetch;
  jinaApiKey?: string;
  maxWebContentLength?: number;
  maxImageBytes?: number;
  executeCodeTimeoutMs?: number;
  executeCodeWorkingDirectory?: string;
}

const DEFAULT_WEB_CONTENT_LIMIT = 40_000;
const DEFAULT_IMAGE_LIMIT = 3_500_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 60_000;
const DEFAULT_CAPTURE_LIMIT = 24_000;

export function createDefaultToolExecutors(
  options: DefaultToolExecutorOptions = {},
): BaselineToolExecutors {
  return {
    webSearch: createDefaultWebSearchExecutor(options),
    visitWebpage: createDefaultVisitWebpageExecutor(options),
    executeCode: createDefaultExecuteCodeExecutor(options),
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
