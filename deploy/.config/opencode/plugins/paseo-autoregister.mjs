// paseo-autoregister: when a top-level OpenCode session is created,
// register it with the local Paseo daemon via `paseo import`.
//
// Why this exists: OpenCode migrated session storage to SQLite
// (~/.local/share/opencode/opencode.db). Paseo's persisted-agent scanner
// still reads ~/.local/share/opencode/storage/session/*.json, which no
// longer exists, so terminal-launched OpenCode sessions never appear in
// Paseo. Claude Code still writes JSONL into ~/.claude/projects/, which
// Paseo scans, which is why Claude "just works".
//
// This plugin closes the gap by calling `paseo import` once per new
// top-level session. Sub-sessions (subtasks with parentID) are skipped.
//
// Activation: add "./plugins/paseo-autoregister.mjs" to the "plugin"
// array in opencode.jsonc (or .opencode/plugins/ in a project root).
//
// Env vars:
//   PASEO_BIN                  override paseo binary path (default: "paseo")
//   PASEO_AUTOREGISTER_LOG     log file path (default: ~/.local/share/opencode/paseo-autoregister.log)
//   PASEO_AUTOREGISTER_QUIET   if set, disable logging entirely

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const PASEO_BIN = process.env.PASEO_BIN || "paseo";
const QUIET = !!process.env.PASEO_AUTOREGISTER_QUIET;
const LOG_FILE = process.env.PASEO_AUTOREGISTER_LOG || join(homedir(), ".local/share/opencode/paseo-autoregister.log");

function log(...args) {
  if (QUIET) return;
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
    appendFileSync(LOG_FILE, line);
  } catch {}
}

function paseoImport(sessionId, cwd) {
  return new Promise((resolve) => {
    const args = ["import", sessionId, "--provider", "opencode", "--cwd", cwd, "--json"];
    const child = spawn(PASEO_BIN, args, { stdio: ["ignore", "pipe", "pipe"], detached: false });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      log("spawn error:", err.message);
      resolve({ ok: false, reason: err.message });
    });
    child.on("exit", (code) => {
      if (code === 0) {
        log("registered", sessionId);
        resolve({ ok: true });
      } else {
        log("import failed", { sessionId, code, stderr: stderr.trim().slice(0, 300) });
        resolve({ ok: false });
      }
    });
  });
}

const seen = new Set();

export default async function PaseoAutoregister(input) {
  const { directory } = input;
  return {
    event: async ({ event }) => {
      if (event?.type !== "session.created") return;
      const info = event?.properties?.info;
      if (!info?.id) return;
      if (info.parentID) return; // skip subtasks
      if (seen.has(info.id)) return;
      seen.add(info.id);

      const cwd = info.directory || directory || process.cwd();
      paseoImport(info.id, cwd).catch((e) => log("unhandled:", e?.message));
    },
  };
}
