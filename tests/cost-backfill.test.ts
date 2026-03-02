import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const hasPython = spawnSync("python3", ["--version"]).status === 0;

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatLocalTimeDash(date: Date): string {
  return `${pad2(date.getHours())}-${pad2(date.getMinutes())}-${pad2(date.getSeconds())}`;
}

function formatLocalTimeColon(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

describe("scripts/cost-backfill.sh", () => {
  (hasPython ? it : it.skip)("dry-run previews and write mode patches existing lines only", async () => {
    const home = await mkdtemp(join(tmpdir(), "muaddib-cost-backfill-"));
    tempDirs.push(home);

    const arc = "libera##test";
    const triggerLocal = new Date(2026, 2, 2, 10, 0, 0); // local time
    const triggerTs = triggerLocal.toISOString();
    const assistantTs = new Date(triggerLocal.getTime() + 1_000).toISOString();
    const historyDay = triggerTs.slice(0, 10); // JSONL file is keyed by UTC day
    const logDay = formatLocalDate(triggerLocal); // logs are keyed by local day
    const logTimeDash = formatLocalTimeDash(triggerLocal);
    const logTimeColon = formatLocalTimeColon(triggerLocal);

    const historyPath = join(home, "arcs", arc, "chat_history", `${historyDay}.jsonl`);
    await mkdir(join(home, "arcs", arc, "chat_history"), { recursive: true });

    const userLine = JSON.stringify({
      ts: triggerTs,
      n: "alice",
      r: "user",
      m: "Muaddib: !s hi",
      run: triggerTs,
    });

    const assistantLine = JSON.stringify({
      ts: assistantTs,
      n: "Muaddib",
      r: "assistant",
      m: "alice: hi",
      run: triggerTs,
    });

    const originalHistory = `${userLine}\n${assistantLine}\n`;
    await writeFile(historyPath, originalHistory, "utf-8");

    const logDir = join(home, "logs", logDay, arc);
    await mkdir(logDir, { recursive: true });

    const usageBlock = JSON.stringify({
      role: "assistant",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 10,
        cacheWrite: 0,
        cost: {
          total: 0.0032,
        },
      },
    }, null, 2);

    const logText = [
      `${logDay} ${logTimeColon},000 - muaddib.rooms.command.irc - INFO - Received command arc=${arc} nick=alice content=!s hi`,
      `${logDay} ${logTimeColon},050 - muaddib.rooms.command.irc - DEBUG - llm_io response agent_stream ${usageBlock}`,
      `${logDay} ${logTimeColon},100 - muaddib.rooms.command.irc - INFO - Agent run complete arc=${arc} mode=!s trigger=!s ctx=1k/200k(1%) cost=$0.0032`,
    ].join("\n") + "\n";

    await writeFile(join(logDir, `${logTimeDash}-alice-muaddib_s_hi.log`), logText, "utf-8");

    const dryRun = spawnSync(
      "bash",
      ["scripts/cost-backfill.sh", home, "--since", "2026-02-27", "--arc", arc],
      { cwd: process.cwd(), encoding: "utf-8" },
    );

    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("DRY-RUN");
    expect(await readFile(historyPath, "utf-8")).toBe(originalHistory);

    const writeRun = spawnSync(
      "bash",
      ["scripts/cost-backfill.sh", home, "--since", "2026-02-27", "--arc", arc, "--write"],
      { cwd: process.cwd(), encoding: "utf-8" },
    );

    expect(writeRun.status).toBe(0);
    expect(writeRun.stdout).toContain("WRITE");

    const updated = await readFile(historyPath, "utf-8");
    const updatedLines = updated.trim().split("\n");
    expect(updatedLines).toHaveLength(2);

    const updatedUser = JSON.parse(updatedLines[0]);
    const updatedAssistant = JSON.parse(updatedLines[1]);

    expect(updatedUser).toEqual(JSON.parse(userLine));
    expect(updatedAssistant.cost).toBe(0.0032);
    expect(updatedAssistant.inTok).toBe(110);
    expect(updatedAssistant.outTok).toBe(20);

    // Compact JSON key formatting should remain compact on touched lines.
    expect(updatedLines[1].startsWith('{"ts":"')).toBe(true);

    const backup = await readFile(`${historyPath}~`, "utf-8");
    expect(backup).toBe(originalHistory);
  });
});
