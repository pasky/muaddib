import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const hasJq = spawnSync("jq", ["--version"]).status === 0;

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("scripts/cost-report.sh", () => {
  (hasJq ? it : it.skip)("attributes cost to role=user trigger nick and resolves matching log", async () => {
    const home = await mkdtemp(join(tmpdir(), "muaddib-cost-report-"));
    tempDirs.push(home);

    const arc = "libera##test";
    const today = new Date().toISOString().slice(0, 10);
    const runTs = `${today}T10:00:00.000Z`;

    await mkdir(join(home, "arcs", arc, "chat_history"), { recursive: true });
    await writeFile(
      join(home, "arcs", arc, "chat_history", `${today}.jsonl`),
      [
        JSON.stringify({ ts: runTs, n: "alice", r: "user", m: "MuaddibLLM: hi", run: runTs }),
        JSON.stringify({
          ts: `${today}T10:00:05.000Z`,
          n: "MuaddibLLM",
          r: "assistant",
          m: "alice: done",
          run: runTs,
          cost: 0.5,
          inTok: 123,
          outTok: 45,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await mkdir(join(home, "logs", today, arc), { recursive: true });
    await writeFile(join(home, "logs", today, arc, "10-00-00-alice-sanity_check.log"), "ok\n", "utf-8");

    const result = spawnSync("bash", ["scripts/cost-report.sh", home, "1", "0.2"], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--- Per User (total across channels) ---");
    expect(result.stdout).toContain("alice");
    expect(result.stdout).not.toContain("(no log found)");
    expect(result.stdout).toContain(`logs/${today}/${arc}/10-00-00-alice-sanity_check.log`);
  });

  (hasJq ? it : it.skip)("does not abort expensive sessions listing when multiple logs match", async () => {
    const home = await mkdtemp(join(tmpdir(), "muaddib-cost-report-"));
    tempDirs.push(home);

    const arc = "libera##test";
    const today = new Date().toISOString().slice(0, 10);
    const runA = `${today}T10:00:00.000Z`;
    const runB = `${today}T10:05:00.000Z`;

    await mkdir(join(home, "arcs", arc, "chat_history"), { recursive: true });
    await writeFile(
      join(home, "arcs", arc, "chat_history", `${today}.jsonl`),
      [
        JSON.stringify({ ts: runA, n: "alice", r: "user", m: "MuaddibLLM: run a", run: runA }),
        JSON.stringify({
          ts: `${today}T10:00:10.000Z`,
          n: "MuaddibLLM",
          r: "assistant",
          m: "alice: done",
          run: runA,
          cost: 0.6,
          inTok: 100,
          outTok: 20,
        }),
        JSON.stringify({ ts: runB, n: "bob", r: "user", m: "MuaddibLLM: run b", run: runB }),
        JSON.stringify({
          ts: `${today}T10:05:10.000Z`,
          n: "MuaddibLLM",
          r: "assistant",
          m: "bob: done",
          run: runB,
          cost: 0.7,
          inTok: 120,
          outTok: 30,
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    await mkdir(join(home, "logs", today, arc), { recursive: true });
    await writeFile(join(home, "logs", today, arc, "10-00-00-alice-first.log"), "ok\n", "utf-8");
    await writeFile(join(home, "logs", today, arc, "10-00-00-alice-second.log"), "ok\n", "utf-8");
    await writeFile(join(home, "logs", today, arc, "10-05-00-bob-only.log"), "ok\n", "utf-8");

    const result = spawnSync("bash", ["scripts/cost-report.sh", home, "1", "0.2"], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    const expensiveSection = result.stdout.split("--- Expensive Sessions (>$0.2) ---")[1] ?? "";
    const expensiveLines = expensiveSection.split("\n").filter((line) => line.startsWith("$"));
    expect(expensiveLines).toHaveLength(2);
    expect(expensiveSection).toContain("alice");
    expect(expensiveSection).toContain("bob");
  });
});
