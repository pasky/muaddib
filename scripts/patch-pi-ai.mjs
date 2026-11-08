// pi-ai 0.87.1 discards OpenRouter's native_finish_reason. Keep it in the
// errorMessage already persisted/logged/delivered by Muaddib. Remove this patch
// once the upstream adapter preserves it; the streaming regression tests guard it.
// Upstream: https://github.com/earendil-works/pi/issues/11931
// Resolve the dependency instead of assuming node_modules layout (npm can hoist it).
// Installs using --ignore-scripts must run this script explicitly.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const path = new URL(import.meta.resolve("@earendil-works/pi-ai/api/openai-completions"));
const before = `                    if (finishReasonResult.errorMessage) {
                        output.errorMessage = finishReasonResult.errorMessage;
                    }`;
// Keep an earlier diagnostic when a trailing usage chunk repeats only the
// generic finish_reason, without the native detail.
const after = `                    if (finishReasonResult.errorMessage) {
                        const nativeReason = choice.native_finish_reason;
                        output.errorMessage = typeof nativeReason === "string" && nativeReason && nativeReason !== choice.finish_reason
                            ? \`\${finishReasonResult.errorMessage} (native_finish_reason: \${nativeReason})\`
                            : (output.errorMessage?.startsWith(\`\${finishReasonResult.errorMessage} (native_finish_reason: \`) ? output.errorMessage : finishReasonResult.errorMessage);
                    }`;
const source = readFileSync(path, "utf8");
if (!source.includes(after)) {
  if (source.split(before).length !== 2) {
    throw new Error("pi-ai native_finish_reason patch no longer matches; review scripts/patch-pi-ai.mjs before upgrading pi-ai");
  }
  // Replace rather than mutate a potentially hard-linked package-store file.
  const temporaryPath = new URL(`${path.href}.${process.pid}.tmp`);
  writeFileSync(temporaryPath, source.replace(before, after));
  renameSync(temporaryPath, path);
}
