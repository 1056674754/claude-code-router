import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Must be imported before @ccr/core config modules: it redirects the runtime
// home so the gateway backup file lands in a temp directory.
export const fakeHome = mkdtempSync(path.join(tmpdir(), "ccr-gateway-backup-home-"));
process.env.CCR_INTERNAL_HOME_DIR = fakeHome;
export const backupFile = path.join(fakeHome, ".claude-code-router", "claude-app-gateway-backup.json");
