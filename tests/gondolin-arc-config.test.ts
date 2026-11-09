/**
 * Per-arc Gondolin configuration (`agent.tools.gondolin.profiles` / `.arcs`): how matching
 * fragments resolve into the VM's env, HTTP secret placeholders, URL allow rules and SSH
 * egress. No VM is booted; see ./gondolin-mock.ts.
 */

import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { resolveUrlAllowRegexes } from "../src/agent/gondolin/env.js";
import { resetGondolinVmCache } from "../src/agent/gondolin/vm.js";
import { createGondolinTools } from "../src/agent/tools/gondolin-tools.js";
import { AuthStore } from "../src/auth/auth-store.js";
import { buildArc } from "../src/rooms/message.js";
import {
  ARC,
  fakeSshPublicKey,
  getLastCreateHttpHooksOptions,
  getLastVmOptions,
  gondolinConfig,
  makeFakeVm,
  makeLogger,
  registerFakeVm,
  resetGondolinMock,
  warmVm,
} from "./gondolin-mock.js";

vi.mock("@earendil-works/gondolin", async (importOriginal) =>
  (await import("./gondolin-mock.js")).buildGondolinMock(importOriginal));

beforeEach(async () => {
  resetGondolinVmCache();
  vi.clearAllMocks();
  await resetGondolinMock();
});

describe("gondolin per-arc env injection", () => {
  it("matches human arc globs and applies fragments from broad to specific", async () => {
    const serverTag = "slack:Corp/EMEA";
    const channelName = "#release";
    const fakeVm = makeFakeVm();
    await registerFakeVm(fakeVm);

    const { tools } = createGondolinTools({
      arc: buildArc(serverTag, channelName),
      serverTag,
      channelName,
      authStorage: AuthStore.inMemory(),
      config: {
        ...gondolinConfig,
        profiles: {
          workspaceDefaults: {
            env: {
              FROM_PROFILE: "workspace-profile",
              ORDER: "workspace-profile",
            },
          },
          releaseDefaults: {
            env: {
              ORDER: "release-profile",
              PROFILE_ONLY: "1",
            },
          },
        },
        arcs: {
          "*": {
            env: {
              GLOBAL: "1",
              ORDER: "global",
            },
          },
          "slack:*#*": {
            env: {
              ORDER: "slack-any",
            },
          },
          "slack:Corp/EMEA#*": {
            use: ["workspaceDefaults"],
            env: {
              ORDER: "workspace-inline",
              WORKSPACE: "1",
            },
          },
          "slack:Corp/EMEA##release": {
            use: ["releaseDefaults"],
            env: {
              CHANNEL: "1",
              HUMAN_MATCH: "1",
              ORDER: "release-inline",
            },
          },
        },
      },
    });

    await warmVm(tools);

    const vmOptions = await getLastVmOptions<{ env?: Record<string, string> }>();
    expect(vmOptions.env).toMatchObject({
      GLOBAL: "1",
      FROM_PROFILE: "workspace-profile",
      WORKSPACE: "1",
      PROFILE_ONLY: "1",
      CHANNEL: "1",
      HUMAN_MATCH: "1",
      ORDER: "release-inline",
    });
    // HOME, PATH, VIRTUAL_ENV are set by the image's /etc/profile.d script,
    // not via VMOptions.env — only arc-level config vars should appear here.
    expect(vmOptions.env!.PATH).toBeUndefined();
    // SSH egress stays off (and the guest untouched) unless ssh hosts are configured.
    expect((vmOptions as { ssh?: unknown }).ssh).toBeUndefined();
    expect(JSON.stringify(fakeVm.exec.mock.calls)).not.toContain("ssh_known_hosts");
  });

  it("resolves urlAllowRegexes from gondolin profiles and arc fragments", () => {
    const regexes = resolveUrlAllowRegexes({
      config: {
        ...gondolinConfig,
        profiles: {
          corp: {
            urlAllowRegexes: ["^https://corp\\.example/.*$"],
          },
        },
        arcs: {
          "*": {
            urlAllowRegexes: ["^https://global\\.example/.*$"],
          },
          "slack:Corp##release": {
            use: ["corp"],
            urlAllowRegexes: ["^https://release\\.example/.*$"],
          },
        },
      },
      serverTag: "slack:Corp",
      channelName: "#release",
    });

    expect(regexes.some((regex) => regex.test("https://global.example/docs"))).toBe(true);
    expect(regexes.some((regex) => regex.test("https://corp.example/api"))).toBe(true);
    expect(regexes.some((regex) => regex.test("https://release.example/runbook"))).toBe(true);
    expect(regexes.some((regex) => regex.test("https://blocked.example/"))).toBe(false);
  });

  it("passes resolved secrets to createHttpHooks and injects only placeholders into VM env", async () => {
    const serverTag = "slack:Corp";
    const channelName = "#release";
    const fakeVm = makeFakeVm();
    await registerFakeVm(fakeVm);

    const { tools } = createGondolinTools({
      arc: buildArc(serverTag, channelName),
      serverTag,
      channelName,
      authStorage: AuthStore.inMemory({
        "gitlab-corp": { type: "api_key", key: "glpat-secret" },
        "atlassian-corp": { type: "api_key", key: "atl-secret" },
      }),
      config: {
        ...gondolinConfig,
        profiles: {
          corp: {
            env: {
              CONFLUENCE_EMAIL: "muaddib@example.com",
              CONFLUENCE_API_TOKEN: {
                provider: "atlassian-corp",
                hosts: ["api.atlassian.com"],
              },
              GITLAB_TOKEN: {
                provider: "gitlab-corp",
                hosts: ["gitlab.com"],
              },
            },
          },
        },
        arcs: {
          "slack:Corp##release": {
            use: ["corp"],
          },
        },
      },
    });

    await warmVm(tools);

    const createHttpHooksOptions = await getLastCreateHttpHooksOptions<{
      allowedHosts: string[];
      secrets?: Record<string, { value: string; hosts: string[] }>;
    }>();
    expect(createHttpHooksOptions.allowedHosts).toEqual(["*"]);
    expect(createHttpHooksOptions.secrets).toEqual({
      CONFLUENCE_API_TOKEN: {
        value: "atl-secret",
        hosts: ["api.atlassian.com"],
      },
      GITLAB_TOKEN: {
        value: "glpat-secret",
        hosts: ["gitlab.com"],
      },
    });

    const vmOptions = await getLastVmOptions<{ env?: Record<string, string> }>();
    expect(vmOptions.env?.CONFLUENCE_EMAIL).toBe("muaddib@example.com");
    expect(vmOptions.env?.CONFLUENCE_API_TOKEN).toMatch(/^GONDOLIN_SECRET_/);
    expect(vmOptions.env?.GITLAB_TOKEN).toMatch(/^GONDOLIN_SECRET_/);
    expect(vmOptions.env?.CONFLUENCE_API_TOKEN).not.toBe("atl-secret");
    expect(vmOptions.env?.GITLAB_TOKEN).not.toBe("glpat-secret");
    expect(Object.values(vmOptions.env ?? {})).not.toContain("atl-secret");
    expect(Object.values(vmOptions.env ?? {})).not.toContain("glpat-secret");
  });

  it("throws a clear error when a configured auth provider is missing", async () => {
    const serverTag = "slack:Corp";
    const channelName = "#release";
    const { tools } = createGondolinTools({
      arc: buildArc(serverTag, channelName),
      serverTag,
      channelName,
      authStorage: AuthStore.inMemory(),
      config: {
        ...gondolinConfig,
        arcs: {
          "*": {
            env: {
              GITLAB_TOKEN: {
                provider: "gitlab-corp",
                hosts: ["gitlab.com"],
              },
            },
          },
        },
      },
    });

    const bashTool = tools.find((tool) => tool.name === "bash")!;
    await expect(
      bashTool.execute("missing-auth", { command: "echo hi" }, new AbortController().signal, () => {}),
    ).rejects.toThrow("Gondolin env var GITLAB_TOKEN references auth provider 'gitlab-corp'");
    await expect(
      bashTool.execute("missing-auth", { command: "echo hi" }, new AbortController().signal, () => {}),
    ).rejects.toThrow("auth.json");
  });

  it("proxies ssh to configured hosts with host-side credentials and pinned host keys", async () => {
    const serverTag = "libera";
    const channelName = "##hplusroadmap";
    const fakeVm = makeFakeVm();
    await registerFakeVm(fakeVm);
    const logger = makeLogger();
    const pinned = fakeSshPublicKey(1);
    const other = fakeSshPublicKey(2);

    const { tools, systemPromptSuffix } = createGondolinTools({
      arc: buildArc(serverTag, channelName),
      serverTag,
      channelName,
      logger,
      authStorage: AuthStore.inMemory({
        "gnusha-ssh": { type: "api_key", key: "PRIVATE-KEY-PEM" },
        "git-ssh": { type: "api_key", key: "OTHER-PRIVATE-KEY-PEM" },
      }),
      config: {
        ...gondolinConfig,
        profiles: {
          gnusha: {
            ssh: {
              // Explicit default port collapses onto the same target as the arc-level override.
              "gnusha.org:22": { provider: "overridden", username: "overridden", hostKeys: [other.line] },
              "git.example.com:2222": { provider: "git-ssh", username: "git", hostKeys: [other.line] },
            },
          },
        },
        arcs: {
          "libera###hplusroadmap": {
            use: ["gnusha"],
            ssh: {
              "gnusha.org": { provider: "gnusha-ssh", username: "muaddib", hostKeys: [`${pinned.line} some comment`] },
            },
          },
        },
      },
    });

    expect(systemPromptSuffix).toContain("gnusha.org, git.example.com:2222");

    await warmVm(tools);

    const { ssh, env } = await getLastVmOptions<{
      env?: Record<string, string>;
      ssh: {
        allowedHosts: string[];
        credentials: Record<string, { username: string; privateKey: string }>;
        hostKey: string;
        hostVerifier: (hostname: string, key: Buffer, port: number) => boolean;
        execPolicy: (request: Record<string, unknown>) => { allow: boolean };
      };
    }>();
    expect(ssh.allowedHosts).toEqual(["gnusha.org", "git.example.com:2222"]);
    expect(ssh.credentials).toEqual({
      "gnusha.org": { username: "muaddib", privateKey: "PRIVATE-KEY-PEM" },
      "git.example.com:2222": { username: "git", privateKey: "OTHER-PRIVATE-KEY-PEM" },
    });
    // The private key never reaches the guest.
    expect(JSON.stringify(env ?? {})).not.toContain("PRIVATE-KEY-PEM");
    expect(JSON.stringify(fakeVm.exec.mock.calls)).not.toContain("PRIVATE-KEY-PEM");

    // Upstream host keys are pinned per target.
    expect(ssh.hostVerifier("GNUSHA.org", pinned.blob, 22)).toBe(true);
    expect(ssh.hostVerifier("gnusha.org", other.blob, 22)).toBe(false);
    expect(ssh.hostVerifier("gnusha.org", pinned.blob, 2222)).toBe(false);
    expect(ssh.hostVerifier("git.example.com", other.blob, 2222)).toBe(true);
    expect(ssh.hostVerifier("git.example.com", other.blob, 22)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("host key mismatch for gnusha.org:22"));

    // The guest trusts the proxy's own (guest-facing) host key for every host.
    const proxyPublicKey = createPublicKey(ssh.hostKey).export({ format: "jwk" });
    const knownHostsCommand = (fakeVm.exec.mock.calls as unknown as string[][][])
      .map(([argv]) => argv.at(-1)!)
      .find((command) => command.includes("/etc/ssh/ssh_known_hosts"))!;
    const knownHostsBlob = Buffer.from(/'\* ssh-rsa ([A-Za-z0-9+/=]+)\n'/u.exec(knownHostsCommand)![1], "base64");
    expect(knownHostsBlob.includes(Buffer.from(proxyPublicKey.n!, "base64url"))).toBe(true);

    // Every proxied command is allowed, and logged for audit on a single line whatever the sandbox put in it.
    expect(ssh.execPolicy({ hostname: "gnusha.org", port: 22, guestUsername: "root", command: "wiki-put page\nINFO forged" }))
      .toEqual({ allow: true });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining(String.raw`ssh exec gnusha.org:22: "wiki-put page\nINFO forged"`),
    );
  });

  it.each([
    [
      "an IP address target",
      { "198.145.64.73": { provider: "gnusha-ssh", username: "muaddib", hostKeys: [fakeSshPublicKey(1).line] } },
      "lowercase hostname",
    ],
    [
      "a wildcard target",
      { "*.gnusha.org": { provider: "gnusha-ssh", username: "muaddib", hostKeys: [fakeSshPublicKey(1).line] } },
      "lowercase hostname",
    ],
    [
      "a missing username",
      { "gnusha.org": { provider: "gnusha-ssh", hostKeys: [fakeSshPublicKey(1).line] } },
      "ssh.gnusha.org.username must be a non-empty string",
    ],
    [
      "unpinned host keys",
      { "gnusha.org": { provider: "gnusha-ssh", username: "muaddib", hostKeys: [] } },
      "ssh.gnusha.org.hostKeys must be a non-empty array",
    ],
    [
      "a known_hosts line instead of a bare public key",
      { "gnusha.org": { provider: "gnusha-ssh", username: "muaddib", hostKeys: [`gnusha.org ${fakeSshPublicKey(1).line}`] } },
      "ssh.gnusha.org.hostKeys[0] must be an SSH public key",
    ],
    [
      "a host key cut short in pasting",
      { "gnusha.org": { provider: "gnusha-ssh", username: "muaddib", hostKeys: [fakeSshPublicKey(1).line.slice(0, -8)] } },
      "ssh.gnusha.org.hostKeys[0] must be an SSH public key",
    ],
    [
      "a host key that names its type but carries no key",
      { "gnusha.org": { provider: "gnusha-ssh", username: "muaddib", hostKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5"] } },
      "ssh.gnusha.org.hostKeys[0] must be an SSH public key",
    ],
  ])("rejects ssh config with %s", (_label, ssh, message) => {
    expect(() =>
      createGondolinTools({
        arc: ARC,
        config: { ...gondolinConfig, arcs: { "*": { ssh: ssh as never } } },
      }),
    ).toThrow(message);
  });

  it("refuses to start a VM when ssh hosts cannot be served", async () => {
    const ssh = { "gnusha.org": { provider: "gnusha-ssh", username: "muaddib", hostKeys: [fakeSshPublicKey(1).line] } };
    const run = async (config: Parameters<typeof createGondolinTools>[0]["config"], authStorage: AuthStore) => {
      const { tools } = createGondolinTools({ arc: ARC, authStorage, config: { ...config, arcs: { "*": { ssh } } } });
      await warmVm(tools);
    };

    await expect(run(gondolinConfig, AuthStore.inMemory()))
      .rejects.toThrow("Gondolin ssh host gnusha.org references auth provider 'gnusha-ssh', but no API key is configured in auth.json.");
    // Must fail before touching the VM/checkpoint: gondolin cannot map SSH flows to hostnames without synthetic DNS.
    await expect(run({ ...gondolinConfig, dnsMode: "open" }, AuthStore.inMemory({ "gnusha-ssh": { type: "api_key", key: "k" } })))
      .rejects.toThrow("ssh hosts require agent.tools.gondolin.dnsMode \"synthetic\"");
  });

  it("config.json.example defaults arc '*' to allowing all canonical URLs", () => {
    const example = JSON.parse(readFileSync(join(process.cwd(), "config.json.example"), "utf-8")) as {
      agent?: {
        tools?: {
          gondolin?: {
            arcs?: Record<string, { urlAllowRegexes?: string[] }>;
          };
        };
      };
    };

    expect(example.agent?.tools?.gondolin?.arcs?.["*"]?.urlAllowRegexes).toEqual([".*"]);
  });
});
