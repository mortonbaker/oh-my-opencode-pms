#!/usr/bin/env bun
/**
 * tts-bridge.mjs — exposes opencode-tts mp3 output over the tailnet so the
 * operator can listen on any tailscale-connected device (laptop, phone,
 * Studio_PC headphones, etc.) without SSH audio forwarding.
 *
 * Pattern: piface (Mar 2026) — cached audio served via stable URLs with
 * an auto-refreshing browser frontend. Reduced to ~80 LOC.
 *
 * How it works:
 *   1. fs.watch /tmp for new opencode-tts-*.mp3 files (written by the
 *      opencode-tts plugin before it calls ffplay locally)
 *   2. Maintain an in-memory queue of recent mp3 paths (last 20)
 *   3. Bun.serve() exposes:
 *        GET /            → HTML page with auto-playing <audio> element
 *        GET /api/latest  → JSON {path, mtime, idx} for polling
 *        GET /audio/<idx> → the mp3 file at queue index <idx>
 *   4. tailscale serve fronts it on https://atlas01.tail00ae77.ts.net:8445
 *
 * Run:
 *   bun ~/Code/oh-my-opencode-pms/scripts/tts-bridge.mjs &
 *   tailscale serve --bg --https=8445 --set-path=/ http://localhost:8445
 *
 * Stop:
 *   pkill -f tts-bridge.mjs
 *   tailscale serve --https=8445 off
 */

import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const TMP_DIR = '/tmp';
const PATTERN = /^opencode-tts-.*\.mp3$/;
const PORT = Number(process.env.TTS_BRIDGE_PORT ?? 8445);
const MAX_QUEUE = 20;
// edge-tts is a Python wrapper that streams audio from Azure in chunks
// with multi-hundred-ms network pauses. Size polling alone is unreliable
// because flat windows mid-stream are indistinguishable from "done".
//
// Empirical write pattern observed on atlas01:
//   t=1000ms: size=0, lsof shows holder
//   t=1100ms: size=18000, lsof=0 (transient close-between-writes gap)
//   t=1200ms: size=35712, lsof=0 (final, buffer flushed by Python on exit)
//
// Robust signal: require `lsof <path>` to return empty AND size to be
// unchanged for SETTLE_AFTER_CLOSE_MS, with a hard ceiling of MAX_WAIT_MS
// so a runaway writer can't wedge the bridge.
const POLL_INTERVAL_MS = 100;
const SETTLE_AFTER_CLOSE_MS = 600;
const STABILIZE_MAX_WAIT_MS = 30000;

/**
 * Per-path lock so concurrent fs.watch events (rename + change + change
 * + ...) don't all spawn a loadBytes() race where the first racer to
 * stumble into a transient flat window wins with a truncated buffer.
 */
const inFlightLoads = new Set();

/**
 * Queue of {path, mtime, idx, bytes}.
 *
 * Why we cache bytes in memory:
 *   The opencode-tts plugin (dist/index.js line 276) calls unlinkSync on
 *   its output mp3 in a `finally` block after attempting local playback.
 *   On a headless server that playback fails silently and the file is
 *   deleted within milliseconds of being written. The bridge would then
 *   serve HTTP 410 Gone when the browser fetched /audio/<idx>.
 *
 *   Reading the file into a Buffer the moment fs.watch fires divorces
 *   the HTTP lifetime from the on-disk lifetime. RAM ceiling is bounded:
 *   MAX_QUEUE (20) * ~200KB typical mp3 = ~4 MB.
 *
 * See: ~/.local/share/agent-memory/decisions/2026-05-25-never-assume-tts-debug.md
 */
const queue = [];
let nextIdx = 1;

/** Return true if any process currently has fullPath open (lsof -t). */
function hasOpenHolders(fullPath) {
  return new Promise((resolve) => {
    const proc = spawn('lsof', ['-t', fullPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => resolve(out.trim().length > 0));
    proc.on('error', () => resolve(false)); // lsof missing → assume closed
  });
}

async function loadBytes(fullPath) {
  let lastSize = -1;
  let lastSizeChangedAt = Date.now();
  const deadline = Date.now() + STABILIZE_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let size;
    try {
      size = (await stat(fullPath)).size;
    } catch {
      return Buffer.alloc(0); // unlinked mid-stabilize
    }
    if (size !== lastSize) {
      lastSize = size;
      lastSizeChangedAt = Date.now();
      continue;
    }
    if (size === 0) continue; // wait for first write
    // Size hasn't changed since lastSizeChangedAt. Are writers gone?
    if (Date.now() - lastSizeChangedAt < SETTLE_AFTER_CLOSE_MS) continue;
    const open = await hasOpenHolders(fullPath);
    if (open) {
      // Reset settle timer — writer is still attached even though size paused.
      lastSizeChangedAt = Date.now();
      continue;
    }
    return await readFile(fullPath);
  }
  try { return await readFile(fullPath); } catch { return Buffer.alloc(0); }
}

async function rescan() {
  try {
    const entries = await readdir(TMP_DIR);
    const candidates = entries.filter((e) => PATTERN.test(e));
    for (const name of candidates) {
      const fullPath = join(TMP_DIR, name);
      if (queue.some((q) => q.path === fullPath)) continue;
      if (inFlightLoads.has(fullPath)) continue; // another rescan owns it
      inFlightLoads.add(fullPath);
      try {
        const bytes = await loadBytes(fullPath);
        if (bytes.byteLength === 0) continue; // file vanished or stayed empty
        // Re-stat AFTER stabilize so mtime reflects the final write.
        const st = await stat(fullPath).catch(() => null);
        const mtime = st?.mtimeMs ?? Date.now();
        // Double-check no concurrent rescan beat us to push.
        if (queue.some((q) => q.path === fullPath)) continue;
        queue.push({ path: fullPath, mtime, idx: nextIdx++, bytes });
      } catch {} finally {
        inFlightLoads.delete(fullPath);
      }
    }
    queue.sort((a, b) => a.mtime - b.mtime);
    while (queue.length > MAX_QUEUE) queue.shift();
  } catch (err) {
    console.error('[tts-bridge] rescan error:', err.message);
  }
}

// Seed + start watching
await rescan();
console.log(`[tts-bridge] queue seeded with ${queue.length} mp3(s)`);

/** SSE subscribers — pushed-to whenever fs.watch fires a new mp3 */
const sseClients = new Set();

function broadcast(event) {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(payload);
    } catch {
      sseClients.delete(c);
    }
  }
}

watch(TMP_DIR, async (eventType, filename) => {
  if (filename && PATTERN.test(filename)) {
    const before = queue.length;
    await rescan();
    const latest = queue[queue.length - 1];
    if (latest && queue.length !== before) {
      console.log(`[tts-bridge] queued: ${latest.path} (idx=${latest.idx})`);
      broadcast({ type: 'new-audio', idx: latest.idx, mtime: latest.mtime });
    }
  }
});

const HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode TTS — listen</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 system-ui, sans-serif; background: #111; color: #eee;
         margin: 0; padding: 20px; max-width: 600px; }
  h1 { font-size: 16px; margin: 0 0 12px 0; font-weight: 600; color: #aaa; }
  .status { font-size: 12px; color: #888; margin-bottom: 16px; font-family: ui-monospace, monospace; }
  audio { width: 100%; margin: 8px 0; }
  .row { display: flex; gap: 8px; align-items: center; padding: 6px 0;
         border-bottom: 1px solid #222; font-family: ui-monospace, monospace; font-size: 12px; }
  .row.current { background: #1a3a1a; padding-left: 8px; }
  .idx { color: #6c6; min-width: 30px; }
  .age { color: #888; min-width: 60px; }
  .controls { margin-top: 16px; display: flex; gap: 8px; }
  button { background: #2a2a2a; color: #eee; border: 1px solid #444;
           padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit; }
  button:hover { background: #3a3a3a; }
  button.on { background: #2a4a2a; border-color: #4a8a4a; }
</style>
</head>
<body>
<h1>opencode TTS bridge — listening to atlas01</h1>
<div class="status" id="status">connecting…</div>
<audio id="player" controls></audio>
<div class="controls">
  <button id="autoplay" class="on">auto-play new = on</button>
  <button id="repeat">replay current</button>
</div>
<h1 style="margin-top: 24px;">queue (last 20)</h1>
<div id="queue"></div>

<script>
const player = document.getElementById('player');
const status = document.getElementById('status');
const queueEl = document.getElementById('queue');
const autoplayBtn = document.getElementById('autoplay');
const repeatBtn = document.getElementById('repeat');

let autoplay = true;
let currentIdx = 0;
let sseConnected = false;

autoplayBtn.onclick = () => {
  autoplay = !autoplay;
  autoplayBtn.textContent = 'auto-play new = ' + (autoplay ? 'on' : 'off');
  autoplayBtn.className = autoplay ? 'on' : '';
};

repeatBtn.onclick = () => {
  if (currentIdx) { player.currentTime = 0; player.play(); }
};

// Unlock autoplay on first user gesture (any click anywhere)
let unlocked = false;
function unlock() {
  if (unlocked) return;
  unlocked = true;
  // Silent prime: load + briefly play a 0-volume sample to unlock the audio context
  player.volume = 1.0;
  document.body.removeEventListener('click', unlock);
}
document.body.addEventListener('click', unlock, { once: true });

function playIdx(idx) {
  if (idx === currentIdx) return;
  currentIdx = idx;
  player.src = '/audio/' + idx;
  if (autoplay) {
    player.play().catch(e => {
      console.warn('autoplay blocked — click anywhere to unlock:', e.message);
      status.textContent = '⚠ click "replay current" once to unlock autoplay';
    });
  }
}

async function refreshQueue() {
  try {
    const r = await fetch('/api/latest');
    const j = await r.json();
    status.textContent = (sseConnected ? '● live' : '○ polling')
      + ' · queue: ' + j.queue.length
      + ' · latest idx: ' + (j.latest?.idx ?? '-')
      + ' · ' + new Date().toLocaleTimeString();
    queueEl.innerHTML = j.queue.slice().reverse().map(q =>
      '<div class="row' + (q.idx === currentIdx ? ' current' : '') + '">'
      + '<span class="idx">#' + q.idx + '</span>'
      + '<span class="age">' + Math.round((Date.now() - q.mtime) / 1000) + 's ago</span>'
      + '<a href="/audio/' + q.idx + '" style="color: #6ac;" onclick="event.preventDefault(); playIdx(' + q.idx + ');">play</a>'
      + '</div>'
    ).join('');
    // First-load: auto-load the latest so a manual play tap actually plays something
    if (j.latest && currentIdx === 0) {
      currentIdx = j.latest.idx;
      player.src = '/audio/' + currentIdx;
    }
  } catch (e) {
    status.textContent = 'fetch error: ' + e.message;
  }
}

// Server-Sent Events: instant push on new audio, no 2s polling lag
function connectSSE() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { sseConnected = true; refreshQueue(); };
  es.onerror = () => { sseConnected = false; setTimeout(connectSSE, 3000); es.close(); };
  es.addEventListener('new-audio', (msg) => {
    const data = JSON.parse(msg.data);
    playIdx(data.idx);
    refreshQueue();
  });
}

// Initial load + start SSE + fallback poll every 10s
refreshQueue();
connectSSE();
setInterval(refreshQueue, 10000);

// expose for inline onclick handler
window.playIdx = playIdx;
</script>
</body>
</html>`;

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  // Max allowed by Bun (255s). Required for the SSE stream at /api/stream —
  // without this, Bun kills the EventSource at 10s, the browser enters a
  // reconnect loop, and any new-audio broadcast that lands during the dead
  // window is silently dropped. The 5s heartbeat above keeps non-SSE proxies
  // happy too.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname === '/api/latest') {
      const latest = queue[queue.length - 1] ?? null;
      return Response.json({
        queue: queue.map(({ idx, mtime, path }) => ({
          idx,
          mtime,
          name: path.split('/').pop(),
        })),
        latest: latest ? { idx: latest.idx, mtime: latest.mtime } : null,
      });
    }
    if (url.pathname === '/api/stream') {
      // Server-Sent Events: push on every new mp3 (fs.watch trigger).
      // The browser auto-plays the moment the file lands — no 2s poll lag.
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const writeFn = {
            write(chunk) {
              controller.enqueue(encoder.encode(chunk));
            },
          };
          // hello + initial state
          controller.enqueue(encoder.encode(': connected\n\n'));
          const latest = queue[queue.length - 1];
          if (latest) {
            controller.enqueue(encoder.encode(
              `event: hello\ndata: ${JSON.stringify({ idx: latest.idx, mtime: latest.mtime })}\n\n`,
            ));
          }
          sseClients.add(writeFn);
          // heartbeat every 5s — must beat Bun.serve idleTimeout (default 10s)
          // and any upstream proxy idle limits. Belt-and-suspenders with the
          // idleTimeout: 255 below.
          const hb = setInterval(() => {
            try { controller.enqueue(encoder.encode(': hb\n\n')); }
            catch { clearInterval(hb); sseClients.delete(writeFn); }
          }, 5000);
          req.signal?.addEventListener('abort', () => {
            clearInterval(hb);
            sseClients.delete(writeFn);
            try { controller.close(); } catch {}
          });
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }
    const m = url.pathname.match(/^\/audio\/(\d+)$/);
    if (m) {
      const idx = Number(m[1]);
      const item = queue.find((q) => q.idx === idx);
      if (!item) return new Response('not found', { status: 404 });
      // Serve from in-memory buffer — the on-disk file may have been
      // unlinked by the opencode-tts plugin's `finally` cleanup (see queue
      // comment above). The Buffer is the authoritative copy.
      return new Response(item.bytes, {
        headers: {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(item.bytes.byteLength),
          'Cache-Control': 'max-age=3600',
        },
      });
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`[tts-bridge] serving on http://127.0.0.1:${PORT}`);
console.log(`[tts-bridge] next: \`tailscale serve --bg --https=${PORT} --set-path=/ http://localhost:${PORT}\``);
