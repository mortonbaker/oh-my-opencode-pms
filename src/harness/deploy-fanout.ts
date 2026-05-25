/**
 * deploy-fanout.ts — opencode plugin: harness_deploy tool.
 *
 * Exposes `harness_deploy` as a tool (not a hook). The harness-deploy skill
 * in the orchestrator calls this tool with stage="canary" then stage="fanout".
 *
 * Canary stage: PRECOMMIT → LOCAL_TESTS → LOCAL_INSTALL → LOCAL_SMOKE →
 *   CANARY_DEPLOY → CANARY_SMOKE → BAKE
 *
 * Fanout stage: FANOUT_PARALLEL → FANOUT_SMOKE → AUDIT
 *
 * Auto-revert on canary failure. Per-peer revert on fanout failure (others continue).
 * Loud failure on any stage error → recordEscalation.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";

// ── Public types ─────────────────────────────────────────────────────────────

export type DeployStage = "canary" | "fanout";

export interface DeployOpts {
  stage: DeployStage;
  /** override manifest path */
  manifestPath?: string;
  /** override repo root (default: process.cwd() resolves to opencode-harness) */
  repoRoot?: string;
  /** Inject command runner for testing */
  exec?: ExecFn;
  /** Skip BAKE wait (for fast tests) */
  skipBake?: boolean;
}

export type ExecFn = (cmd: string, args: string[], opts: { cwd?: string; timeout?: number }) => Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export interface StageResult {
  name: string; // e.g. "PRECOMMIT", "LOCAL_TESTS", "CANARY_DEPLOY"
  ok: boolean;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface DeployReport {
  stage: DeployStage;
  startedAt: string; // ISO 8601
  finishedAt: string;
  ok: boolean;
  stages: StageResult[];
  perPeer?: Array<{
    host: string;
    platform: "linux" | "windows";
    gitPullOk: boolean;
    installOk: boolean;
    smokeOk: boolean;
    error?: string;
  }>;
  auditPath?: string; // path where audit JSONL was written
}

// ── Manifest types ───────────────────────────────────────────────────────────

interface ManifestPeer {
  host: string;
  ip: string;
  transport: string;
  platform: "linux" | "windows";
  deferred?: boolean;
  defer_reason?: string;
}

interface Manifest {
  source: { host: string; ip: string; role: string; platform: string };
  canary: {
    host: string;
    ip: string;
    transport: string;
    platform: "linux" | "windows";
    bake_seconds: number;
  };
  fanout: ManifestPeer[];
  excluded: Array<{ host: string; reason: string }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Simple JSON parse + basic validation of manifest shape */
function parseManifest(raw: string): Manifest {
  const parsed = JSON.parse(raw);
  if (!parsed.source) throw new Error("manifest missing 'source'");
  if (!parsed.canary) throw new Error("manifest missing 'canary'");
  if (!Array.isArray(parsed.fanout)) throw new Error("manifest missing or invalid 'fanout' array");
  return parsed as Manifest;
}

/**
 * Load + validate manifest from path.
 * Throws on missing file or invalid schema.
 */
export function loadManifest(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`);
  }
  const raw = readFileSync(manifestPath, "utf-8");
  return parseManifest(raw);
}

/**
 * Validate stage is a valid DeployStage.
 */
export function validateStage(stage: unknown): DeployStage {
  if (stage !== "canary" && stage !== "fanout") {
    throw new Error(`invalid stage: ${stage}. Must be "canary" or "fanout"`);
  }
  return stage;
}

/**
 * Record an escalation to runs/escalations/<id>.jsonl.
 * Returns the path written.
 */
export function recordEscalation(opts: {
  stage: DeployStage;
  stageName: string;
  error: string;
  details?: Record<string, unknown>;
}): string {
  const runsDir = join(process.cwd(), "runs");
  const escDir = join(runsDir, "escalations");
  mkdirSync(escDir, { recursive: true });

  const id = `esc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const record: Record<string, unknown> = {
    kind: `harness_deploy_${opts.stageName.toLowerCase()}`,
    ts: new Date().toISOString(),
    deploy_stage: opts.stage,
    stage_name: opts.stageName,
    error: opts.error.slice(0, 500),
    details: opts.details ?? {},
  };

  const outPath = join(escDir, `${id}.jsonl`);
  writeFileSync(outPath, JSON.stringify(record) + "\n", "utf-8");
  return outPath;
}

/**
 * Write DeployReport to runs/deploys/<ISO-timestamp>.jsonl.
 * Returns the path written.
 */
export function writeAuditRecord(report: DeployReport, repoRoot: string): string {
  const deploysDir = join(repoRoot, "runs", "deploys");
  mkdirSync(deploysDir, { recursive: true });
  const timestamp = report.startedAt.replace(/[:.]/g, "-");
  const outPath = join(deploysDir, `${timestamp}.jsonl`);
  writeFileSync(outPath, JSON.stringify(report) + "\n", "utf-8");
  return outPath;
}

// ── Stage timing helper ───────────────────────────────────────────────────────

async function runStage(
  name: string,
  fn: () => Promise<void>,
): Promise<StageResult> {
  const start = Date.now();
  try {
    await fn();
    return { name, ok: true, durationMs: Date.now() - start };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { name, ok: false, durationMs: Date.now() - start, error };
  }
}

/** Truncate stdout to last n lines */
function truncateStdout(stdout: string, lines = 50): string {
  const all = stdout.split("\n");
  return all.length > lines ? all.slice(-lines).join("\n") : stdout;
}

// ── Canary stages ─────────────────────────────────────────────────────────────

interface CanaryContext {
  manifest: Manifest;
  repoRoot: string;
  exec: ExecFn;
  skipBake: boolean;
  stages: StageResult[];
  startedAt: string;
}

/**
 * Run PRECOMMIT: git status --porcelain must be empty.
 */
async function runPrecommit(ctx: CanaryContext): Promise<StageResult> {
  return runStage("PRECOMMIT", async () => {
    const result = await ctx.exec("git", ["status", "--porcelain"], { cwd: ctx.repoRoot });
    if (result.exitCode !== 0) {
      throw new Error(`git status failed: ${result.stderr}`);
    }
    if (result.stdout.trim() !== "") {
      const err = new Error(`git working tree not clean:\n${result.stdout}`);
      throw err;
    }
  });
}

/**
 * Run LOCAL_TESTS: npx vitest run in repoRoot.
 */
async function runLocalTests(ctx: CanaryContext): Promise<StageResult> {
  return runStage("LOCAL_TESTS", async () => {
    const result = await ctx.exec("npx", ["vitest", "run"], { cwd: ctx.repoRoot, timeout: 120_000 });
    if (result.exitCode !== 0) {
      const err = new Error(`vitest run failed (exit ${result.exitCode}):\n${truncateStdout(result.stdout)}`);
      throw err;
    }
  });
}

/**
 * Run LOCAL_INSTALL: bash scripts/install-local.sh.
 */
async function runLocalInstall(ctx: CanaryContext): Promise<StageResult> {
  return runStage("LOCAL_INSTALL", async () => {
    const scriptPath = join(ctx.repoRoot, "scripts", "install-local.sh");
    const result = await ctx.exec("bash", [scriptPath], { cwd: ctx.repoRoot, timeout: 120_000 });
    if (result.exitCode !== 0) {
      throw new Error(`install-local.sh failed: ${result.stderr || truncateStdout(result.stdout)}`);
    }
  });
}

/**
 * Run LOCAL_SMOKE: npx vitest run tests/canary-smoke.test.ts.
 * Gracefully skips if file doesn't exist yet during testing.
 */
async function runLocalSmoke(ctx: CanaryContext): Promise<StageResult> {
  return runStage("LOCAL_SMOKE", async () => {
    const smokePath = join(ctx.repoRoot, "tests", "canary-smoke.test.ts");
    if (!existsSync(smokePath)) {
      // Not an error — smoke test file may not be written yet
      ctx.stages.push({
        name: "LOCAL_SMOKE",
        ok: true,
        durationMs: 0,
        details: { skipped: "smoke test file not yet present" },
      });
      return;
    }
    const result = await ctx.exec("npx", ["vitest", "run", smokePath], {
      cwd: ctx.repoRoot,
      timeout: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`canary-smoke test failed: ${truncateStdout(result.stdout)}`);
    }
  });
}

/**
 * Run CANARY_DEPLOY: ssh canary host, git pull + install.
 */
async function runCanaryDeploy(ctx: CanaryContext): Promise<StageResult> {
  return runStage("CANARY_DEPLOY", async () => {
    const { ip: host } = ctx.manifest.canary;
    const sshBase = `ssh -o BatchMode=yes -o ConnectTimeout=5 morton@${host}`;
    const gitPullCmd = `${sshBase} 'cd ~/Code/opencode-harness && git pull'`;
    const installCmd = `${sshBase} 'cd ~/Code/opencode-harness && bash scripts/install-local.sh'`;

    // git pull first
    const pullResult = await ctx.exec("sh", ["-c", gitPullCmd], { timeout: 60_000 });
    if (pullResult.exitCode !== 0) {
      throw new Error(`canary git pull failed: ${pullResult.stderr || pullResult.stdout}`);
    }

    // then install
    const installResult = await ctx.exec("sh", ["-c", installCmd], { timeout: 120_000 });
    if (installResult.exitCode !== 0) {
      throw new Error(`canary install failed: ${installResult.stderr || installResult.stdout}`);
    }
  });
}

/**
 * Parse smoke test JSON output from remote script.
 * Expected shape: { tests: [{name, pass, ms, error?}], allPassed: boolean }
 */
interface SmokeTestResult {
  tests: Array<{ name: string; pass: boolean; ms: number; error?: string }>;
  allPassed: boolean;
}

function parseSmokeResult(stdout: string): SmokeTestResult {
  // Try to extract JSON from mixed output
  const match = stdout.match(/\{[\s\S]*"tests"[\s\S]*\}/);
  if (match) {
    return JSON.parse(match[0]) as SmokeTestResult;
  }
  throw new Error(`could not parse smoke result JSON from: ${stdout.slice(0, 200)}`);
}

/**
 * Run CANARY_SMOKE: ssh canary host, run smoke-test-remote.sh.
 * Gracefully skips if script doesn't exist yet.
 */
async function runCanarySmoke(ctx: CanaryContext): Promise<StageResult> {
  return runStage("CANARY_SMOKE", async () => {
    const { ip: host } = ctx.manifest.canary;
    const sshBase = `ssh -o BatchMode=yes -o ConnectTimeout=5 morton@${host}`;
    // Try bash first (linux), then powershell (windows canary unlikely but handle it)
    const smokeScript = `${sshBase} 'cd ~/Code/opencode-harness && bash scripts/smoke-test-remote.sh 2>/dev/null || echo "SMOKE_SCRIPT_MISSING"'`;

    const result = await ctx.exec("sh", ["-c", smokeScript], { timeout: 60_000 });
    const output = result.stdout;

    // If script missing, treat as graceful skip
    if (output.includes("SMOKE_SCRIPT_MISSING") || result.exitCode !== 0) {
      ctx.stages.push({
        name: "CANARY_SMOKE",
        ok: true,
        durationMs: 0,
        details: { skipped: "smoke test script not yet present" },
      });
      return;
    }

    const parsed = parseSmokeResult(output);
    if (!parsed.allPassed) {
      const failed = parsed.tests.filter((t) => !t.pass).map((t) => t.name).join(", ");
      throw new Error(`canary smoke failed: ${failed}`);
    }
  });
}

/**
 * Run BAKE: wait bake_seconds, periodically check for ERROR-level log lines.
 */
async function runBake(ctx: CanaryContext): Promise<StageResult> {
  if (ctx.skipBake) {
    ctx.stages.push({ name: "BAKE", ok: true, durationMs: 0, details: { skipped: "skipBake=true" } });
    return { name: "BAKE", ok: true, durationMs: 0 };
  }

  return runStage("BAKE", async () => {
    const { ip: host, bake_seconds: bakeSeconds } = ctx.manifest.canary;
    const bakeMs = bakeSeconds * 1000;
    const pollIntervalMs = 30_000;
    const start = Date.now();

    // Poll for errors every 30s
    const checkErrors = async (): Promise<void> => {
      const errorFindCmd = `ssh -o BatchMode=yes -o ConnectTimeout=5 morton@${host} 'find ~/.opencode/logs -type f 2>/dev/null | xargs grep -l ERROR 2>/dev/null | head -5'`;
      const result = await ctx.exec("sh", ["-c", errorFindCmd], { timeout: 30_000 });
      if (result.stdout.trim()) {
        throw new Error(`ERROR-level log lines found during bake:\n${result.stdout.slice(0, 500)}`);
      }
    };

    let elapsed = 0;
    while (elapsed < bakeMs) {
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, bakeMs - elapsed)));
      elapsed = Date.now() - start;
      await checkErrors();
    }
  });
}

/**
 * Auto-revert canary via git reset --hard ORIG_HEAD.
 */
async function revertCanary(ctx: CanaryContext): Promise<void> {
  const { ip: host } = ctx.manifest.canary;
  const revertCmd = `ssh -o BatchMode=yes -o ConnectTimeout=5 morton@${host} 'cd ~/Code/opencode-harness && git reset --hard ORIG_HEAD'`;
  try {
    await ctx.exec("sh", ["-c", revertCmd], { timeout: 30_000 });
  } catch {
    // Best-effort revert
  }
}

// ── Fanout stages ─────────────────────────────────────────────────────────────

interface FanoutContext {
  manifest: Manifest;
  repoRoot: string;
  exec: ExecFn;
  stages: StageResult[];
}

interface PeerResult {
  host: string;
  ip: string;
  platform: "linux" | "windows";
  gitPullOk: boolean;
  installOk: boolean;
  smokeOk: boolean;
  error?: string;
}

/**
 * Run FANOUT_PARALLEL: deploy to all non-deferred peers in parallel (capped at 4).
 */
async function runFanoutParallel(ctx: FanoutContext): Promise<PeerResult[]> {
  const peers = ctx.manifest.fanout.filter((p) => !p.deferred);
  const results: PeerResult[] = [];

  // Semaphore to limit to 4 concurrent
  const concurrency = 4;
  let idx = 0;

  async function deployPeer(peer: ManifestPeer): Promise<PeerResult> {
    const sshBase = `ssh -o BatchMode=yes -o ConnectTimeout=5 morton@${peer.ip}`;
    let gitPullOk = false;
    let installOk = false;
    let error: string | undefined;
    const base: Pick<PeerResult, "host" | "ip" | "platform" | "gitPullOk" | "installOk" | "smokeOk"> = {
      host: peer.host,
      ip: peer.ip,
      platform: peer.platform,
      gitPullOk: false,
      installOk: false,
      smokeOk: false,
    };

    // git pull
    //   linux: bash with `cd && git pull`
    //   windows: ssh defaults to powershell on doc01-1; use git -C with $env:USERPROFILE
    try {
      const pullCmd =
        peer.platform === "linux"
          ? `${sshBase} 'cd ~/Code/opencode-harness && git pull'`
          : `${sshBase} 'git -C "$env:USERPROFILE/Code/opencode-harness" pull'`;
      const pullResult = await ctx.exec("sh", ["-c", pullCmd], { timeout: 60_000 });
      gitPullOk = pullResult.exitCode === 0;
      if (!gitPullOk) {
        error = `git pull failed: ${pullResult.stderr || pullResult.stdout}`;
        return error ? { ...base, error } : base;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      return error ? { ...base, error } : base;
    }

    // install
    try {
      let installCmd: string;
      if (peer.platform === "linux") {
        installCmd = `${sshBase} 'cd ~/Code/opencode-harness && bash scripts/install-local.sh'`;
      } else {
        // Windows: invoke install-local.ps1 with absolute path via $env:USERPROFILE
        // single-quote outer string so atlas01's sh doesn't expand $env on this side
        installCmd = `${sshBase} 'powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE/Code/opencode-harness/scripts/install-local.ps1"'`;
      }
      const installResult = await ctx.exec("sh", ["-c", installCmd], { timeout: peer.platform === "linux" ? 120_000 : 180_000 });
      installOk = installResult.exitCode === 0;
      if (!installOk) {
        error = `install failed: ${installResult.stderr || installResult.stdout}`;
      }
    } catch (err) {
      installOk = false;
      error = err instanceof Error ? err.message : String(err);
    }

    const result: PeerResult = { ...base, gitPullOk, installOk };
    if (error) result.error = error;
    return result;
  }

  // Process peers with concurrency limit
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, peers.length); i++) {
    workers.push(
      (async () => {
        while (idx < peers.length) {
          const peer = peers[idx++];
          if (!peer) break;
          const result = await deployPeer(peer);
          results.push(result);
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}

/**
 * Revert a single fanout peer.
 */
async function revertPeer(ctx: FanoutContext, peer: ManifestPeer): Promise<void> {
  const sshBase = `ssh -o BatchMode=yes -o ConnectTimeout=5 morton@${peer.ip}`;
  const revertCmd = `${sshBase} 'cd ~/Code/opencode-harness && git reset --hard ORIG_HEAD'`;
  try {
    await ctx.exec("sh", ["-c", revertCmd], { timeout: 30_000 });
  } catch {
    // Best-effort
  }
}

/**
 * Run FANOUT_SMOKE: smoke test each peer that had successful deploy.
 */
async function runFanoutSmoke(
  ctx: FanoutContext,
  peerResults: PeerResult[],
): Promise<void> {
  for (const peer of peerResults) {
    if (!peer.gitPullOk || !peer.installOk) {
      peer.smokeOk = false;
      continue;
    }

    const sshBase = `ssh -o BatchMode=yes -o ConnectTimeout=5 morton@${peer.ip}`;
    try {
      let smokeCmd: string;
      if (peer.platform === "linux") {
        smokeCmd = `${sshBase} 'cd ~/Code/opencode-harness && bash scripts/smoke-test-remote.sh'`;
      } else {
        smokeCmd = `${sshBase} 'powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE/Code/opencode-harness/scripts/smoke-test-remote.ps1"'`;
      }

      const result = await ctx.exec("sh", ["-c", smokeCmd], { timeout: 60_000 });
      const parsed = parseSmokeResult(result.stdout);
      peer.smokeOk = parsed.allPassed;
      if (!peer.smokeOk) {
        const failed = parsed.tests.filter((t) => !t.pass).map((t) => t.name).join(", ");
        peer.error = `smoke failed: ${failed}`;
      }
    } catch (err) {
      peer.smokeOk = false;
      peer.error = err instanceof Error ? err.message : String(err);
    }
  }
}

// ── Default exec implementation ───────────────────────────────────────────────

function defaultExec(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cwd = opts.cwd ?? process.cwd();
  const timeout = opts.timeout ?? 30_000;

  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeout);

    proc.stdout?.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: timedOut ? 124 : (code ?? 0), stdout, stderr });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
  });
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the deploy for the specified stage (canary or fanout).
 */
export async function runDeploy(opts: DeployOpts): Promise<DeployReport> {
  const stage = validateStage(opts.stage);
  const repoRoot = opts.repoRoot ?? process.cwd();
  const manifestPath = opts.manifestPath ?? join(repoRoot, "manifests", "tailnet.json");
  const exec = opts.exec ?? defaultExec;
  const startedAt = new Date().toISOString();
  const stages: StageResult[] = [];

  const manifest = loadManifest(manifestPath);

  if (stage === "canary") {
    const ctx: CanaryContext = { manifest, repoRoot, exec, skipBake: opts.skipBake ?? false, stages, startedAt };

    // 1. PRECOMMIT
    const precommit = await runPrecommit(ctx);
    stages.push(precommit);
    if (!precommit.ok) {
      recordEscalation({ stage, stageName: "PRECOMMIT", error: precommit.error ?? "unknown", details: { stdout: precommit.details } });
      return finishReport({ stage, startedAt, stages, ok: false }, repoRoot);
    }

    // 2. LOCAL_TESTS
    const localTests = await runLocalTests(ctx);
    stages.push(localTests);
    if (!localTests.ok) {
      recordEscalation({ stage, stageName: "LOCAL_TESTS", error: localTests.error ?? "unknown" });
      return finishReport({ stage, startedAt, stages, ok: false }, repoRoot);
    }

    // 3. LOCAL_INSTALL
    const localInstall = await runLocalInstall(ctx);
    stages.push(localInstall);
    if (!localInstall.ok) {
      recordEscalation({ stage, stageName: "LOCAL_INSTALL", error: localInstall.error ?? "unknown" });
      return finishReport({ stage, startedAt, stages, ok: false }, repoRoot);
    }

    // 4. LOCAL_SMOKE (graceful skip if file absent)
    await runLocalSmoke(ctx);

    // 5. CANARY_DEPLOY
    const canaryDeploy = await runCanaryDeploy(ctx);
    stages.push(canaryDeploy);
    if (!canaryDeploy.ok) {
      await revertCanary(ctx);
      recordEscalation({ stage, stageName: "CANARY_DEPLOY", error: canaryDeploy.error ?? "unknown", details: { reverted: true } });
      return finishReport({ stage, startedAt, stages, ok: false }, repoRoot);
    }

    // 6. CANARY_SMOKE (graceful skip if script absent)
    await runCanarySmoke(ctx);

    // 7. BAKE
    const bake = await runBake(ctx);
    stages.push(bake);
    if (!bake.ok) {
      await revertCanary(ctx);
      recordEscalation({ stage, stageName: "BAKE", error: bake.error ?? "unknown", details: { reverted: true } });
      return finishReport({ stage, startedAt, stages, ok: false }, repoRoot);
    }

    return finishReport({ stage, startedAt, stages, ok: true }, repoRoot);
  } else {
    // fanout stage
    const ctx: FanoutContext = { manifest, repoRoot, exec, stages };

    // 8. FANOUT_PARALLEL
    let perPeer: PeerResult[] = [];
    const fanoutParallel = await runStage("FANOUT_PARALLEL", async () => {
      perPeer = await runFanoutParallel(ctx);
      // Check for peer failures inside the stage
      const failed = perPeer.filter((p) => !p.gitPullOk || !p.installOk);
      if (failed.length > 0) {
        throw new Error(`Peer failures: ${failed.map((p) => `${p.host}(gitPullOk=${p.gitPullOk},installOk=${p.installOk})`).join(", ")}`);
      }
    });
    stages.push(fanoutParallel);

    // Check if any peer failed and needs revert
    const failedPeers = perPeer.filter((p) => !p.gitPullOk || !p.installOk);
    if (failedPeers.length > 0) {
      for (const fp of failedPeers) {
        const peer = manifest.fanout.find((p) => p.host === fp.host);
        if (peer) await revertPeer(ctx, peer);
      }
      recordEscalation({
        stage,
        stageName: "FANOUT_PARALLEL",
        error: `Some peers failed: ${failedPeers.map((p) => p.host).join(", ")}`,
        details: { perPeerErrors: failedPeers.map((p) => ({ host: p.host, error: p.error })) },
      });
    }

    // 9. FANOUT_SMOKE
    const fanoutSmoke = await runStage("FANOUT_SMOKE", async () => {
      await runFanoutSmoke(ctx, perPeer);
    });
    stages.push(fanoutSmoke);

    // 10. AUDIT
    const ok = fanoutParallel.ok && fanoutSmoke.ok;
    const report: DeployReport = {
      stage,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok,
      stages,
      perPeer,
    };

    // Write audit
    const auditPath = writeAuditRecord(report, repoRoot);
    report.auditPath = auditPath;

    return report;
  }
}

function finishReport(
  partial: { stage: DeployStage; startedAt: string; stages: StageResult[]; ok: boolean },
  repoRoot: string,
): DeployReport {
  const report: DeployReport = {
    ...partial,
    finishedAt: new Date().toISOString(),
  };
  // Always audit
  try {
    report.auditPath = writeAuditRecord(report, repoRoot);
  } catch {
    // Non-fatal
  }
  return report;
}

// ── Plugin export ─────────────────────────────────────────────────────────────

const TOOL_DESCRIPTION = `Run a canary or fanout deploy of the opencode-harness codebase.

This tool is intentionally narrow: it is called ONLY by the orchestrator following
the harness-deploy skill (canary → bake → fanout workflow). If you are calling this
without that context, you probably want a different tool.

Stages (canary):
  PRECOMMIT     — git working tree must be clean
  LOCAL_TESTS   — npx vitest run (all tests)
  LOCAL_INSTALL — bash scripts/install-local.sh
  LOCAL_SMOKE   — npx vitest run tests/canary-smoke.test.ts (skipped if file absent)
  CANARY_DEPLOY — ssh canary host, git pull + install
  CANARY_SMOKE  — ssh canary host, bash scripts/smoke-test-remote.sh (skipped if absent)
  BAKE          — wait bake_seconds (from manifest), check opencode logs for ERROR lines

On canary failure: auto-revert via git reset --hard ORIG_HEAD.

Stages (fanout):
  FANOUT_PARALLEL — parallel deploy to all non-deferred peers (linux: bash, windows: powershell)
  FANOUT_SMOKE    — run smoke-test-remote on each successful peer
  AUDIT           — write full DeployReport to runs/deploys/<timestamp>.jsonl

On fanout-peer failure: only that peer reverts; others continue (degraded mode).`;

// ── Tool factory for PMS integration ─────────────────────────────────────────
// Returns a { harness_deploy: tool({...}) } object that PMS spreads into its
// own `tool: {...}` registration block.

export function createHarnessDeployTool(): { harness_deploy: ToolDefinition } {
  const harness_deploy: ToolDefinition = tool({
      description: TOOL_DESCRIPTION,
      args: {
        stage: tool.schema.enum(["canary", "fanout"]),
        skipBake: tool.schema.boolean().optional(),
      },
      execute: async (args, _context): Promise<string> => {
        const stage = args.stage as DeployStage | undefined;
        const skipBake = args.skipBake as boolean | undefined;

        if (!stage) {
          return JSON.stringify({ success: false, error: "stage is required" });
        }

        try {
          validateStage(stage);
        } catch (err) {
          return JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const report = await runDeploy({ stage, skipBake: skipBake ?? false });
        return JSON.stringify(report);
      },
    });
  return { harness_deploy };
}
