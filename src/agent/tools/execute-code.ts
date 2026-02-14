/**
 * Code execution tool using Fly.io Sprites sandbox.
 *
 * Architecture (matching Python parity):
 * - One Sprite per arc (persisted, reused across executor calls)
 * - Per-executor-call isolated workdir in /tmp/actor-{uuid}/
 * - Shared workspace in /workspace/ (persists across calls)
 * - Input artifacts downloaded into /artifacts/ inside the sprite
 * - Auto-detection of generated images (matplotlib etc.)
 * - Explicit output_files uploaded as artifacts
 */

import { createHash, randomUUID } from "node:crypto";
import { basename, extname, posix } from "node:path";

import { Type } from "@sinclair/typebox";

import { writeArtifactBytes } from "./artifact-storage.js";
import type { DefaultToolExecutorOptions, MuaddibTool } from "./types.js";
import type { VisitWebpageImageResult } from "./web.js";

export interface ExecuteCodeInput {
  code: string;
  language?: "python" | "bash";
  input_artifacts?: string[];
  output_files?: string[];
}

export type ExecuteCodeExecutor = (input: ExecuteCodeInput) => Promise<string>;

const DEFAULT_EXECUTE_TIMEOUT_MS = 600_000;
const DEFAULT_CAPTURE_LIMIT = 24_000;

// ---------------------------------------------------------------------------
// Sprite cache: one sprite per arc, reused across calls (matches Python)
// ---------------------------------------------------------------------------

import type { Sprite } from "@fly/sprites";

const spriteCache = new Map<string, Sprite>();
const spriteCacheLocks = new Map<string, Promise<Sprite>>();

function normalizeArcId(arc: string): string {
  return createHash("sha256").update(arc).digest("hex").slice(0, 16);
}

function getSpriteName(arc: string): string {
  return `arc-${normalizeArcId(arc)}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function createExecuteCodeTool(executors: { executeCode: ExecuteCodeExecutor }): MuaddibTool {
  return {
    name: "execute_code",
    persistType: "artifact",
    label: "Execute Code",
    description:
      "Execute code in a sandbox environment and return the output. The sandbox environment is persisted to follow-up calls of this tool within this thread. Use /workspace/ to store files that should persist across conversations. Use output_files to download any generated files from the sandbox.",
    parameters: Type.Object({
      code: Type.String({
        description:
          "The code to execute in the sandbox. Each execution is auto-saved to /tmp/_v{n}.py (or .sh for bash) - the exact path is returned in the response. You can re-run previous code with 'python /tmp/_v1.py' after fixing issues (e.g., pip install missing module).",
      }),
      language: Type.Optional(
        Type.Union([Type.Literal("python"), Type.Literal("bash")], {
          description: "The language to execute in (python or bash).",
          default: "python",
        }),
      ),
      input_artifacts: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional list of artifact URLs to download into the sandbox at /artifacts/ before execution (e.g., ['https://example.com/artifacts/?abc123.csv'] -> /artifacts/abc123.csv).",
        }),
      ),
      output_files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional list of file paths in the sandbox to download and share as artifacts (e.g., ['/tmp/report.csv']).",
        }),
      ),
    }),
    execute: async (_toolCallId, params: ExecuteCodeInput) => {
      const output = await executors.executeCode(params);
      return {
        content: [{ type: "text", text: output }],
        details: {
          language: params.language ?? "python",
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractFilenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const query = parsed.search.slice(1);
    if (query) {
      if (!query.includes("=")) {
        const decoded = decodeURIComponent(query.trim());
        return decoded || undefined;
      }
      const params = new URLSearchParams(query);
      const fromKey = params.get("file") ?? params.get("filename");
      if (fromKey?.trim()) return fromKey.trim();
    }
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (!decodedPath || decodedPath.endsWith("/")) return undefined;
    const leaf = decodedPath.split("/").pop();
    if (!leaf || leaf === "index.html") return undefined;
    return leaf;
  } catch {
    return undefined;
  }
}

function extractImageDataFromResult(result: VisitWebpageImageResult): Buffer | undefined {
  if (result.kind === "image" && result.data) {
    return Buffer.from(result.data, "base64");
  }
  return undefined;
}

function suffixFromFilename(filename: string): string {
  const ext = extname(filename);
  return ext || ".bin";
}

/**
 * Shell-quote a string for safe inclusion in a bash command.
 * Uses single-quote wrapping with proper escaping of embedded single quotes.
 */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export function createDefaultExecuteCodeExecutor(
  options: DefaultToolExecutorOptions,
): ExecuteCodeExecutor {
  const timeoutMs = options.executeCodeTimeoutMs ?? DEFAULT_EXECUTE_TIMEOUT_MS;
  const spritesToken = options.spritesToken;
  const arc = options.spritesArc ?? "default";

  let sprite: Sprite | null = null;
  let workdir: string | null = null;
  let versionCounter = 0;

  async function ensureSprite(): Promise<Sprite> {
    if (sprite) return sprite;

    const { SpritesClient } = await import("@fly/sprites");

    const spriteName = getSpriteName(arc);

    // Check cache first
    const cached = spriteCache.get(spriteName);
    if (cached) {
      sprite = cached;
      return sprite;
    }

    // Use lock to prevent concurrent creation of the same sprite
    const pending = spriteCacheLocks.get(spriteName);
    if (pending) {
      sprite = await pending;
      return sprite;
    }

    const createPromise = (async () => {
      const client = new SpritesClient(spritesToken!);
      let sp: Sprite;
      try {
        sp = await client.createSprite(spriteName);
        options.logger?.info(`Created new Sprite: ${spriteName}`);
      } catch {
        // Sprite may already exist
        sp = client.sprite(spriteName);
        options.logger?.info(`Connected to existing Sprite: ${spriteName}`);
      }
      spriteCache.set(spriteName, sp);
      return sp;
    })();

    spriteCacheLocks.set(spriteName, createPromise);
    try {
      sprite = await createPromise;
      return sprite;
    } finally {
      spriteCacheLocks.delete(spriteName);
    }
  }

  async function ensureWorkdir(sp: Sprite): Promise<string> {
    if (workdir) return workdir;

    const actorId = randomUUID().slice(0, 8);
    workdir = `/tmp/actor-${actorId}`;

    await spriteExec(sp, `mkdir -p ${shellQuote(workdir)} /workspace /artifacts`);
    options.logger?.info(`Created actor workdir: ${workdir}`);
    return workdir;
  }

  /**
   * Execute a command on the sprite, capturing stdout/stderr and exit code.
   * The JS SDK's exec() throws ExecError on non-zero exit which already
   * includes stdout/stderr — no need for the Python capture_on_error wrapper.
   */
  async function spriteExec(
    sp: Sprite,
    command: string,
    execOptions?: { cwd?: string; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const { ExecError } = await import("@fly/sprites");

    // Wrap with `timeout` command when a timeout is specified, so that
    // long-running sandbox commands are killed server-side.
    let cmd = command;
    if (execOptions?.timeoutMs) {
      const secs = Math.max(0.1, execOptions.timeoutMs / 1000);
      cmd = `timeout ${secs} bash -c ${shellQuote(command)}`;
    }

    try {
      const result = await sp.exec(cmd, {
        cwd: execOptions?.cwd,
      });
      return {
        exitCode: 0,
        stdout: truncateOutput(String(result.stdout ?? "")),
        stderr: truncateOutput(String(result.stderr ?? "")),
      };
    } catch (err) {
      if (err instanceof ExecError) {
        return {
          exitCode: err.exitCode ?? 1,
          stdout: truncateOutput(String(err.stdout ?? "")),
          stderr: truncateOutput(String(err.stderr ?? "")),
        };
      }
      throw err;
    }
  }

  function truncateOutput(s: string): string {
    if (s.length <= DEFAULT_CAPTURE_LIMIT) return s;
    const headSize = Math.floor(DEFAULT_CAPTURE_LIMIT * 0.3);
    const tailSize = DEFAULT_CAPTURE_LIMIT - headSize;
    return (
      s.slice(0, headSize) +
      `\n\n... [truncated ${s.length - headSize - tailSize} chars] ...\n\n` +
      s.slice(s.length - tailSize)
    );
  }

  async function downloadSpriteFile(
    sp: Sprite,
    path: string,
  ): Promise<{ data: Buffer; filename: string } | null> {
    const result = await spriteExec(sp, `base64 ${shellQuote(path)}`);
    if (result.exitCode !== 0) {
      options.logger?.info(`Failed to read file ${path}: ${result.stderr}`);
      return null;
    }
    // Decode the base64-encoded content back to binary
    const data = Buffer.from(result.stdout.trim(), "base64");
    return { data, filename: posix.basename(path) };
  }

  async function uploadInputArtifacts(
    sp: Sprite,
    artifactUrls: string[],
  ): Promise<string[]> {
    const { createDefaultVisitWebpageExecutor } = await import("./web.js");
    const visitWebpage = createDefaultVisitWebpageExecutor(options);
    const messages: string[] = [];

    for (const url of artifactUrls) {
      let filename = extractFilenameFromUrl(url);
      if (filename) filename = basename(filename);

      if (!filename) {
        messages.push(`**Error: Invalid artifact URL (no filename): ${url}**`);
        continue;
      }

      try {
        const content = await visitWebpage(url);
        const spritePath = `/artifacts/${filename}`;

        if (typeof content === "string") {
          const b64 = Buffer.from(content, "utf-8").toString("base64");
          await spriteExec(sp, `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(spritePath)}`);
          messages.push(`**Uploaded text: ${spritePath}**`);
        } else {
          const imageData = extractImageDataFromResult(content);
          if (!imageData) {
            messages.push(`**Error: Unsupported image format: ${url}**`);
            continue;
          }
          const b64 = imageData.toString("base64");
          await spriteExec(sp, `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(spritePath)}`);
          messages.push(`**Uploaded image: ${spritePath}**`);
        }

        options.logger?.info(`Uploaded artifact to sprite: ${url} -> /artifacts/${filename}`);
      } catch (err) {
        messages.push(`**Error: Failed to upload ${url}: ${err}**`);
      }
    }

    return messages;
  }

  async function detectGeneratedImages(
    sp: Sprite,
    wd: string,
  ): Promise<string[]> {
    if (!options.artifactsPath || !options.artifactsUrl) return [];

    const messages: string[] = [];

    for (const ext of ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp"]) {
      const findResult = await spriteExec(sp, `find ${shellQuote(wd)} -name '${ext}' -type f`);
      if (findResult.exitCode !== 0 || !findResult.stdout.trim()) continue;

      for (const imgPath of findResult.stdout.trim().split("\n")) {
        if (!imgPath) continue;

        const fileResult = await downloadSpriteFile(sp, imgPath);
        if (!fileResult) continue;

        try {
          const suffix = suffixFromFilename(fileResult.filename);
          const url = await writeArtifactBytes(options, fileResult.data, suffix);
          messages.push(`**Generated image:** ${url}`);
        } catch (err) {
          options.logger?.info(`Failed to upload generated image ${imgPath}: ${err}`);
        }
      }
    }

    return messages;
  }

  async function downloadOutputFiles(
    sp: Sprite,
    outputFiles: string[],
  ): Promise<string[]> {
    if (!options.artifactsPath || !options.artifactsUrl) {
      return ["**Warning:** output_files requested but artifact store not configured."];
    }

    const messages: string[] = [];

    for (const filePath of outputFiles) {
      const fileResult = await downloadSpriteFile(sp, filePath);
      if (!fileResult) {
        messages.push(`**Error:** Could not download ${filePath}`);
        continue;
      }

      try {
        const suffix = suffixFromFilename(fileResult.filename);
        const url = await writeArtifactBytes(options, fileResult.data, suffix);
        messages.push(`**Downloaded file (${fileResult.filename}):** ${url}`);
      } catch (err) {
        messages.push(`**Error uploading ${fileResult.filename}:** ${err}`);
      }
    }

    return messages;
  }

  // -------------------------------------------------------------------------
  // Main executor
  // -------------------------------------------------------------------------

  return async (input: ExecuteCodeInput): Promise<string> => {
    const language = input.language ?? "python";
    if (language !== "python" && language !== "bash") {
      throw new Error(`Unsupported execute_code language '${language}'.`);
    }

    const code = input.code.trim();
    if (!code) {
      throw new Error("execute_code.code must be non-empty.");
    }

    if (!spritesToken) {
      throw new Error(
        "execute_code requires tools.sprites.token configuration for sandboxed execution.",
      );
    }

    let sp: Sprite;
    try {
      sp = await ensureSprite();
    } catch (err) {
      return `Error initializing sandbox: ${err}`;
    }

    try {
      const wd = await ensureWorkdir(sp);
      const output: string[] = [];

      // Upload input artifacts
      if (input.input_artifacts && input.input_artifacts.length > 0) {
        const msgs = await uploadInputArtifacts(sp, input.input_artifacts);
        output.push(...msgs);
      }

      // Save code to file for re-runs
      versionCounter += 1;
      const ext = language === "python" ? ".py" : ".sh";
      const savedFile = `${wd}/_v${versionCounter}${ext}`;

      // Write code via base64 to avoid shell escaping issues
      const codeB64 = Buffer.from(input.code, "utf-8").toString("base64");
      await spriteExec(sp, `printf '%s' ${shellQuote(codeB64)} | base64 -d > ${shellQuote(savedFile)}`);

      // Execute with timeout
      const cmd = language === "python" ? `python3 ${shellQuote(savedFile)}` : `bash ${shellQuote(savedFile)}`;
      const execution = await spriteExec(sp, cmd, { cwd: wd, timeoutMs: timeoutMs });

      // Process results (matching Python output format exactly)
      if (execution.exitCode !== 0) {
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

      // Auto-detect generated images
      const imageMessages = await detectGeneratedImages(sp, wd);
      output.push(...imageMessages);

      // Download output files
      if (input.output_files && input.output_files.length > 0) {
        const fileMessages = await downloadOutputFiles(sp, input.output_files);
        output.push(...fileMessages);
      }

      if (output.length === 0) {
        output.push("Code executed successfully with no output.");
      }

      output.push(`_Code saved to \`${savedFile}\` for re-run._`);

      options.logger?.info(
        `Executed ${language} code in Sprite ${getSpriteName(arc)}: ${code.slice(0, 512)}...`,
      );

      return output.join("\n\n");
    } catch (err) {
      options.logger?.info(`Sprites execution failed: ${err}`);
      return `Error executing code: ${err}`;
    }
  };
}

// ---------------------------------------------------------------------------
// Exported for testing: reset sprite cache
// ---------------------------------------------------------------------------
export function resetSpriteCache(): void {
  spriteCache.clear();
  spriteCacheLocks.clear();
}
