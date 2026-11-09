// Fixes applied to installed dependencies (postinstall), for defects we cannot wait on
// upstream for. Each entry replaces one exact block of a pinned version's built output and
// says when it can go; a block that no longer matches fails the install loudly, so a
// dependency bump cannot silently drop a fix.
//
// Files are located through the package's own exports rather than a node_modules layout
// (npm can hoist). Installs using --ignore-scripts must run this script explicitly.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const patches = [
  // pi-ai 1.5.0 (still) discards OpenRouter's native_finish_reason. Keep it in the
  // errorMessage already persisted/logged/delivered by Muaddib. Remove this patch
  // once the upstream adapter preserves it; the streaming regression tests guard it.
  // Upstream: https://github.com/earendil-works/pi/issues/11931
  {
    name: "pi-ai native_finish_reason",
    path: new URL(import.meta.resolve("@earendil-works/pi-ai/api/openai-completions")),
    before: `                    if (finishReasonResult.errorMessage) {
                        output.errorMessage = finishReasonResult.errorMessage;
                    }`,
    // Keep an earlier diagnostic when a trailing usage chunk repeats only the
    // generic finish_reason, without the native detail.
    after: `                    if (finishReasonResult.errorMessage) {
                        const nativeReason = choice.native_finish_reason;
                        output.errorMessage = typeof nativeReason === "string" && nativeReason && nativeReason !== choice.finish_reason
                            ? \`\${finishReasonResult.errorMessage} (native_finish_reason: \${nativeReason})\`
                            : (output.errorMessage?.startsWith(\`\${finishReasonResult.errorMessage} (native_finish_reason: \`) ? output.errorMessage : finishReasonResult.errorMessage);
                    }`,
  },
  // Gondolin 0.14.0's SSH egress proxy relays an exec channel between guest and upstream
  // with bare `source.on("data", (d) => destination.write(d))` handlers, which is wrong in
  // three ways that matter as soon as real data moves through `ssh host cmd`:
  //
  // 1. Stdout is truncated. When upstream closes, the guest channel is close()d at once and
  //    ssh2 drops whatever it still had queued for the guest. A command whose output outruns
  //    the guest by more than one channel window (2 MiB) arrives cut short, with exit code 0.
  // 2. Memory is unbounded. Nothing honours write() returning false, so a reader that stalls
  //    on either side makes the host process queue everything the other side sends, outside
  //    the VM's memory limit and at a pace the sandbox controls.
  // 3. Guest stdin EOF never reaches upstream. The bridge waits for "eof" on the guest exec
  //    channel, but ssh2 emits that only on the Session; the channel just ends as a stream.
  //    `ssh host 'cat > file' < file` hangs forever.
  //
  // NOT fixed here, because the defect is in ssh2 (1.17.0) rather than in the bridge: its
  // server side cannot flow-control stdout and stderr together. Once stdout has stalled on
  // the channel window, a stderr write that stalls too is never resumed, and the next window
  // adjust re-sends a stale stdout chunk instead. So a command producing more than a window
  // of stderr towards a guest that is not keeping up still loses stderr (and can corrupt
  // stdout). That is why the guest channel is ended without waiting for queued stderr: the
  // wait would never end. Small stderr output, the normal case, is unaffected.
  //
  // Remove this patch once upstream handles all three; the "ssh exec bridge" tests in
  // tests/gondolin-checkpoint.test.ts run the real bridge and guard the behavior either way.
  {
    name: "gondolin ssh exec bridge",
    // Not an export itself, so located relative to the exported package.json.
    path: new URL("./dist/src/qemu/ssh.js", import.meta.resolve("@earendil-works/gondolin/package.json")),
    before: `    upstreamChannel.on("data", (data) => {
        guestChannel.write(data);
    });
    upstreamChannel.stderr.on("data", (data) => {
        guestChannel.stderr.write(data);
    });
    upstreamChannel.on("exit", (code, signal) => {
        if (typeof code === "number") {
            guestChannel.exit(code);
        }
        else if (signal) {
            guestChannel.exit(signal);
        }
    });
    upstreamChannel.on("close", () => {
        try {
            guestChannel.close();
        }
        catch {
            // ignore
        }
        removeUpstream();
        try {
            upstream.end();
        }
        catch {
            // ignore
        }
    });
    guestChannel.on("data", (data) => {
        upstreamChannel.write(data);
    });
    guestChannel.on("eof", () => {
        upstreamChannel.end();
    });
`,
    after: `    // [muaddib patch, see scripts/patch-deps.mjs]
    // Relay with backpressure: a saturated destination pauses its source, which makes ssh2
    // stop granting window to the sender, so each direction holds a few windows at most.
    const forward = (source, destination) => {
        source.on("data", (data) => {
            // The far side is gone (e.g. the command exited without reading its stdin).
            if (!destination.writable) {
                return;
            }
            if (destination.write(data) === false) {
                const resume = () => {
                    destination.off("drain", resume);
                    destination.off("close", resume);
                    source.resume();
                };
                destination.once("drain", resume);
                destination.once("close", resume);
                source.pause();
            }
        });
    };
    forward(upstreamChannel, guestChannel);
    forward(upstreamChannel.stderr, guestChannel.stderr);
    upstreamChannel.on("exit", (code, signal) => {
        if (typeof code === "number") {
            guestChannel.exit(code);
        }
        else if (signal) {
            guestChannel.exit(signal);
        }
    });
    // ssh2 emits "close" once stdout has been read to its end, i.e. fully handed to the guest
    // channel. End that channel rather than close it: ssh2 then sends what is still queued
    // before closing, where close() makes it drop that. Stderr is not waited for; see the
    // patch script for why ssh2 cannot be trusted to ever flush it.
    upstreamChannel.on("close", () => {
        try {
            guestChannel.end();
        }
        catch {
            // ignore
        }
        removeUpstream();
        try {
            upstream.end();
        }
        catch {
            // ignore
        }
    });
    forward(guestChannel, upstreamChannel);
    guestChannel.on("end", () => {
        upstreamChannel.end();
    });
    // ssh2 withholds "close" from a channel whose readable side is paused, as the guest's is
    // while upstream is not taking its stdin. Its writable side still finishes when the guest
    // closes the channel, so release upstream on that as well.
    guestChannel.once("finish", () => {
        try {
            upstreamChannel.close();
            upstream.end();
        }
        catch {
            // ignore
        }
    });
`,
  },
];

for (const { name, path, before, after } of patches) {
  const source = readFileSync(path, "utf8");
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2) {
    throw new Error(`${name} patch no longer matches ${path.pathname}; review scripts/patch-deps.mjs before upgrading the dependency`);
  }
  // Replace rather than mutate a potentially hard-linked package-store file. The
  // replacement is passed as a function so "$" in the patched code is taken literally.
  const temporaryPath = new URL(`${path.href}.${process.pid}.tmp`);
  writeFileSync(temporaryPath, source.replace(before, () => after));
  renameSync(temporaryPath, path);
}
