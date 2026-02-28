import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ArcEventsWatcher,
  type ArcEventsWatcherOptions,
  _parseEventFile,
  _buildEventMessage,
  _isHeartbeatContentEmpty,
  getArcEventsDir,
} from "../src/events/watcher.js";
import type { RoomGateway } from "../src/rooms/room-gateway.js";

// Mock getMuaddibHome to use a temp dir
let muaddibHome: string;

vi.mock("../src/config/paths.js", () => ({
  getMuaddibHome: () => muaddibHome,
}));

function createTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "muaddib-events-test-"));
  return dir;
}

/** Default options: 30min min period, heartbeat disabled. */
const defaultOpts: ArcEventsWatcherOptions = { minPeriodMs: 30 * 60 * 1000, heartbeatIntervalMs: 0 };

function createMockGateway(): RoomGateway & { injected: Array<{ arc: string; content: string }> } {
  const injected: Array<{ arc: string; content: string }> = [];
  return {
    injected,
    register: vi.fn(),
    inject: vi.fn(async (arc: string, content: string) => {
      injected.push({ arc, content });
    }),
    send: vi.fn(async () => {}),
  } as unknown as RoomGateway & { injected: Array<{ arc: string; content: string }> };
}

beforeEach(() => {
  muaddibHome = createTempHome();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
  if (muaddibHome) {
    rmSync(muaddibHome, { recursive: true, force: true });
  }
});

describe("parseEventFile", () => {
  it("parses a one-shot event", () => {
    const raw = JSON.stringify({
      type: "one-shot",
      text: "Remind me",
      at: "2026-03-01T09:00:00+01:00",
    });
    const event = _parseEventFile(raw, "test.json");
    expect(event.type).toBe("one-shot");
    expect(event.text).toBe("Remind me");
    if (event.type === "one-shot") {
      expect(event.at).toBe("2026-03-01T09:00:00+01:00");
    }
  });

  it("parses a periodic event", () => {
    const raw = JSON.stringify({
      type: "periodic",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
      timezone: "Europe/Prague",
    });
    const event = _parseEventFile(raw, "test.json");
    expect(event.type).toBe("periodic");
    expect(event.text).toBe("Check inbox");
    if (event.type === "periodic") {
      expect(event.schedule).toBe("0 9 * * 1-5");
      expect(event.timezone).toBe("Europe/Prague");
    }
  });

  it("rejects unknown event type", () => {
    const raw = JSON.stringify({ type: "unknown", text: "hello" });
    expect(() => _parseEventFile(raw, "test.json")).toThrow("unknown event type");
  });

  it("rejects one-shot without text", () => {
    const raw = JSON.stringify({ type: "one-shot", at: "2026-03-01T09:00:00Z" });
    expect(() => _parseEventFile(raw, "test.json")).toThrow('missing "text"');
  });

  it("rejects periodic without schedule", () => {
    const raw = JSON.stringify({ type: "periodic", text: "hello" });
    expect(() => _parseEventFile(raw, "test.json")).toThrow('missing "schedule"');
  });

  it("rejects invalid cron schedule", () => {
    const raw = JSON.stringify({ type: "periodic", text: "hello", schedule: "not-a-cron" });
    expect(() => _parseEventFile(raw, "test.json")).toThrow("invalid cron schedule");
  });

  it("rejects invalid date in one-shot", () => {
    const raw = JSON.stringify({ type: "one-shot", text: "hello", at: "not-a-date" });
    expect(() => _parseEventFile(raw, "test.json")).toThrow('invalid "at" date');
  });
});

describe("buildEventMessage", () => {
  it("builds one-shot message with correct format", () => {
    const msg = _buildEventMessage("/events/remind.json", {
      type: "one-shot",
      text: "Remind me",
      at: "2026-03-01T09:00:00+01:00",
    });
    expect(msg).toContain("----------\n");
    expect(msg).toContain("<meta>");
    expect(msg).toContain("speak accordingly.</meta>");
    expect(msg).toContain("[EVENT:/events/remind.json:one-shot:2026-03-01T09:00:00+01:00] Remind me");
  });

  it("builds periodic message with NULL guidance", () => {
    const msg = _buildEventMessage("/events/check.json", {
      type: "periodic",
      text: "Check inbox",
      schedule: "0 9 * * 1-5",
    });
    expect(msg).toContain("----------\n");
    expect(msg).toContain("Finish with string NULL");
    expect(msg).toContain("[EVENT:/events/check.json:periodic:0 9 * * 1-5] Check inbox");
  });
});

describe("ArcEventsWatcher", () => {
  it("fires a one-shot event after timeout", async () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, defaultOpts);

    const arc = "test-arc";
    const eventsDir = getArcEventsDir(arc);
    mkdirSync(eventsDir, { recursive: true });

    // One-shot 5 seconds in the future
    const futureDate = new Date(Date.now() + 5000).toISOString();
    const eventFile = join(eventsDir, "remind.json");
    writeFileSync(eventFile, JSON.stringify({
      type: "one-shot",
      text: "Test reminder",
      at: futureDate,
    }));

    watcher.onFileWritten(arc, "remind.json");

    // Advance time past the scheduled fire time
    vi.advanceTimersByTime(6000);

    // Wait for the async inject call
    await vi.waitFor(() => {
      expect(gateway.injected.length).toBe(1);
    });

    expect(gateway.injected[0]!.arc).toBe(arc);
    expect(gateway.injected[0]!.content).toContain("[EVENT:/events/remind.json:one-shot:");
    expect(gateway.injected[0]!.content).toContain("Test reminder");

    // File should have been auto-deleted
    expect(existsSync(eventFile)).toBe(false);

    watcher.stop();
  });

  it("discards stale one-shot events on startup", () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, defaultOpts);

    const arc = "test-arc";
    const eventsDir = getArcEventsDir(arc);
    mkdirSync(eventsDir, { recursive: true });

    // One-shot in the past
    const pastDate = new Date(Date.now() - 60000).toISOString();
    const eventFile = join(eventsDir, "stale.json");
    writeFileSync(eventFile, JSON.stringify({
      type: "one-shot",
      text: "Stale reminder",
      at: pastDate,
    }));

    watcher.scanArc(arc);

    // File should have been deleted without firing
    expect(existsSync(eventFile)).toBe(false);
    expect(gateway.injected.length).toBe(0);

    watcher.stop();
  });

  it("cancels a job when the file is deleted", () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, defaultOpts);

    const arc = "test-arc";
    const eventsDir = getArcEventsDir(arc);
    mkdirSync(eventsDir, { recursive: true });

    const futureDate = new Date(Date.now() + 60000).toISOString();
    writeFileSync(join(eventsDir, "cancel-me.json"), JSON.stringify({
      type: "one-shot",
      text: "Will be cancelled",
      at: futureDate,
    }));

    watcher.onFileWritten(arc, "cancel-me.json");
    watcher.onFileDeleted(arc, "cancel-me.json");

    // Advance past the would-have-fired time
    vi.advanceTimersByTime(70000);

    // Should not have fired
    expect(gateway.injected.length).toBe(0);

    watcher.stop();
  });

  it("re-schedules when a file is overwritten", async () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, defaultOpts);

    const arc = "test-arc";
    const eventsDir = getArcEventsDir(arc);
    mkdirSync(eventsDir, { recursive: true });

    // First write: 10 seconds from now
    const firstDate = new Date(Date.now() + 10000).toISOString();
    writeFileSync(join(eventsDir, "reschedule.json"), JSON.stringify({
      type: "one-shot",
      text: "First schedule",
      at: firstDate,
    }));
    watcher.onFileWritten(arc, "reschedule.json");

    // Overwrite: 20 seconds from now
    const secondDate = new Date(Date.now() + 20000).toISOString();
    writeFileSync(join(eventsDir, "reschedule.json"), JSON.stringify({
      type: "one-shot",
      text: "Second schedule",
      at: secondDate,
    }));
    watcher.onFileWritten(arc, "reschedule.json");

    // Advance 15 seconds — first schedule would fire, but second hasn't yet
    vi.advanceTimersByTime(15000);
    expect(gateway.injected.length).toBe(0);

    // Advance to 25 seconds — second schedule fires
    vi.advanceTimersByTime(10000);

    await vi.waitFor(() => {
      expect(gateway.injected.length).toBe(1);
    });

    expect(gateway.injected[0]!.content).toContain("Second schedule");

    watcher.stop();
  });

  it("scans all arcs on start()", () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, defaultOpts);

    // Create two arcs with events
    for (const arcName of ["arc1", "arc2"]) {
      const eventsDir = getArcEventsDir(arcName);
      mkdirSync(eventsDir, { recursive: true });
      writeFileSync(join(eventsDir, "check.json"), JSON.stringify({
        type: "periodic",
        text: `Check ${arcName}`,
        schedule: "0 9 * * *",
      }));
    }

    watcher.start();

    // Both should be scheduled (we can't directly inspect jobs, but stop should work)
    watcher.stop();
  });

  it("ignores non-json files", () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, defaultOpts);

    // This should not throw or schedule anything
    watcher.onFileWritten("arc", "readme.txt");
    watcher.onFileDeleted("arc", "readme.txt");

    watcher.stop();
  });

  it("handles malformed event files gracefully", () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, defaultOpts);

    const arc = "test-arc";
    const eventsDir = getArcEventsDir(arc);
    mkdirSync(eventsDir, { recursive: true });

    writeFileSync(join(eventsDir, "bad.json"), "not json");

    // Should not throw
    watcher.onFileWritten(arc, "bad.json");
    expect(gateway.injected.length).toBe(0);

    watcher.stop();
  });

  it("uses configurable minPeriodMs for rate limiting", async () => {
    const gateway = createMockGateway();
    // Use a 3-second min period with a cron that fires every second
    const watcher = new ArcEventsWatcher(gateway, undefined, { minPeriodMs: 3000, heartbeatIntervalMs: 0 });

    const arc = "test-arc";
    const eventsDir = getArcEventsDir(arc);
    mkdirSync(eventsDir, { recursive: true });

    writeFileSync(join(eventsDir, "periodic.json"), JSON.stringify({
      type: "periodic",
      text: "Check stuff",
      schedule: "* * * * * *", // every second
    }));

    watcher.onFileWritten(arc, "periodic.json");

    // First tick fires at t=1s
    vi.advanceTimersByTime(1000);
    await vi.waitFor(() => {
      expect(gateway.injected.length).toBe(1);
    });

    // t=2s: rate-limited (2s - 1s = 1s < 3s)
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    expect(gateway.injected.length).toBe(1);

    // t=5s: fires again (5s - 1s = 4s >= 3s)
    vi.advanceTimersByTime(3000);
    await vi.waitFor(() => {
      expect(gateway.injected.length).toBe(2);
    });

    watcher.stop();
  });
});

describe("isHeartbeatContentEmpty", () => {
  it("returns true for empty string", () => {
    expect(_isHeartbeatContentEmpty("")).toBe(true);
  });

  it("returns true for whitespace-only", () => {
    expect(_isHeartbeatContentEmpty("  \n\t\n  ")).toBe(true);
  });

  it("returns true for headers-only", () => {
    expect(_isHeartbeatContentEmpty("# Heartbeat\n## Section\n")).toBe(true);
  });

  it("returns true for HTML comments only", () => {
    expect(_isHeartbeatContentEmpty("<!-- placeholder -->\n<!-- another -->")).toBe(true);
  });

  it("returns true for empty checklist items only", () => {
    expect(_isHeartbeatContentEmpty("- [ ]\n- [ ]\n")).toBe(true);
  });

  it("returns true for headers + comments + empty checklists combined", () => {
    expect(_isHeartbeatContentEmpty("# Heartbeat\n<!-- note -->\n- [ ]\n")).toBe(true);
  });

  it("returns false for real content", () => {
    expect(_isHeartbeatContentEmpty("Check email inbox")).toBe(false);
  });

  it("returns false for checked checklist items", () => {
    expect(_isHeartbeatContentEmpty("- [x] Done task")).toBe(false);
  });

  it("returns false for content mixed with headers", () => {
    expect(_isHeartbeatContentEmpty("# Heartbeat\nCheck email")).toBe(false);
  });
});

describe("ArcEventsWatcher heartbeat", () => {
  it("fires heartbeat for arc with non-empty HEARTBEAT.md", async () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, {
      heartbeatIntervalMs: 5000,
      minPeriodMs: 1000,
    });

    // Create arc with HEARTBEAT.md
    const workspaceDir = join(muaddibHome, "arcs", "test-arc", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "HEARTBEAT.md"), "Check email inbox");

    watcher.start();

    // Advance past the heartbeat interval
    vi.advanceTimersByTime(5000);

    await vi.waitFor(() => {
      expect(gateway.injected.length).toBe(1);
    });

    expect(gateway.injected[0]!.arc).toBe("test-arc");
    expect(gateway.injected[0]!.content).toContain("[EVENT:/workspace/HEARTBEAT.md:periodic:");
    expect(gateway.injected[0]!.content).toContain("/workspace/HEARTBEAT.md:\nCheck email inbox");

    watcher.stop();
  });

  it("skips arcs without HEARTBEAT.md", async () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, {
      heartbeatIntervalMs: 5000,
      minPeriodMs: 1000,
    });

    // Create arc without HEARTBEAT.md
    const workspaceDir = join(muaddibHome, "arcs", "test-arc", "workspace");
    mkdirSync(workspaceDir, { recursive: true });

    watcher.start();
    vi.advanceTimersByTime(5000);

    // Give async a chance to settle
    await Promise.resolve();
    expect(gateway.injected.length).toBe(0);

    watcher.stop();
  });

  it("skips arcs with empty/header-only HEARTBEAT.md", async () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, {
      heartbeatIntervalMs: 5000,
      minPeriodMs: 1000,
    });

    const workspaceDir = join(muaddibHome, "arcs", "test-arc", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "HEARTBEAT.md"), "# Heartbeat\n<!-- empty -->\n");

    watcher.start();
    vi.advanceTimersByTime(5000);

    await Promise.resolve();
    expect(gateway.injected.length).toBe(0);

    watcher.stop();
  });

  it("heartbeat respects rate limiting", async () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, {
      heartbeatIntervalMs: 2000,
      minPeriodMs: 5000,
    });

    const workspaceDir = join(muaddibHome, "arcs", "test-arc", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "HEARTBEAT.md"), "Check stuff");

    watcher.start();

    // First heartbeat fires at t=2s
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => {
      expect(gateway.injected.length).toBe(1);
    });

    // Second heartbeat at t=4s is rate-limited (4s - 2s = 2s < 5s minPeriod)
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(gateway.injected.length).toBe(1);

    // Third heartbeat at t=6s is still rate-limited (6s - 2s = 4s < 5s minPeriod)
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(gateway.injected.length).toBe(1);

    // Fourth heartbeat at t=8s fires (8s - 2s = 6s >= 5s minPeriod)
    vi.advanceTimersByTime(2000);
    await vi.waitFor(() => {
      expect(gateway.injected.length).toBe(2);
    });

    watcher.stop();
  });

  it("heartbeatIntervalMs: 0 disables heartbeat", () => {
    const gateway = createMockGateway();
    const watcher = new ArcEventsWatcher(gateway, undefined, {
      heartbeatIntervalMs: 0,
      minPeriodMs: 1000,
    });

    const workspaceDir = join(muaddibHome, "arcs", "test-arc", "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(join(workspaceDir, "HEARTBEAT.md"), "Check stuff");

    watcher.start();
    vi.advanceTimersByTime(60000);

    expect(gateway.injected.length).toBe(0);

    watcher.stop();
  });
});
