import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type {
  BaselineToolExecutors,
  DefaultToolExecutorOptions,
  ExecuteCodeInput,
} from "./types.js";

const DEFAULT_EXECUTE_TIMEOUT_MS = 60_000;
const DEFAULT_CAPTURE_LIMIT = 24_000;

export function createExecuteCodeTool(executors: Pick<BaselineToolExecutors, "executeCode">): AgentTool<any> {
  return {
    name: "execute_code",
    label: "Execute Code",
    description:
      "Execute code and return output. Supports python and bash. Input/output artifact features are incremental in TS.",
    parameters: Type.Object({
      code: Type.String({
        description: "The code to execute.",
      }),
      language: Type.Optional(
        Type.Union([Type.Literal("python"), Type.Literal("bash")], {
          description: "The language to execute in (python or bash).",
          default: "python",
        }),
      ),
      input_artifacts: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional list of artifact URLs to preload.",
        }),
      ),
      output_files: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional list of output files to export.",
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

export function createDefaultExecuteCodeExecutor(
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
