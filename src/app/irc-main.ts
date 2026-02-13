import { runMuaddibMain } from "./main.js";

/**
 * Compatibility wrapper kept for milestone continuity.
 * Main bootstrap now handles all enabled monitors; when config enables only IRC,
 * behavior matches previous runIrcMain flow.
 */
export async function runIrcMain(argv: string[] = process.argv.slice(2)): Promise<void> {
  await runMuaddibMain(argv);
}
