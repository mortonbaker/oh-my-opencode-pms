/**
 * audit-chain.ts — append a chained row to runs/<run-id>/audit.jsonl.
 *
 * Ported from ~/pms/.opencode/plugins/_lib/audit.ts (Tier 3).
 *
 * Chain: HMAC-SHA256 with key = PMS_AUDIT_KEY env (UTF-8 bytes) if set
 * non-empty, else dev/CI fallback of 32 zero bytes. External verifier
 * accepts rows provided the same key is in effect.
 *
 * Atomicity: POSIX O_APPEND is atomic for writes < PIPE_BUF (4 KiB on Linux).
 * input_summary is truncated to 1 KiB so total row stays ≤ 2 KiB.
 */

import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { canonicalJsonStringify } from '../_lib/canonical-json.js';
import type { AuditRow, GovernanceDecision } from '../_lib/types.js';

const GENESIS_PREV = '0'.repeat(64);
const INPUT_SUMMARY_MAX_BYTES = 1024;

function hmacKey(): Buffer {
  const raw = process.env.PMS_AUDIT_KEY ?? '';
  if (raw.length > 0) return Buffer.from(raw, 'utf-8');
  return Buffer.alloc(32, 0);
}

/** Python datetime.isoformat()-shaped UTC timestamp with microsecond padding.
 *  JS Date has only millisecond precision; we pad with "000" for 6 digits. */
function isoNowMicroseconds(): string {
  const iso = new Date().toISOString(); // "2026-05-19T00:16:02.039Z"
  return iso.slice(0, -1) + '000+00:00'; // "2026-05-19T00:16:02.039000+00:00"
}

/** Truncate `s` to <= `maxBytes` UTF-8 bytes, then append "...(truncated)". */
function truncateUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.byteLength <= maxBytes) return s;
  const slice = buf.subarray(0, maxBytes).toString('utf-8');
  return slice.replace(/\uFFFD+$/u, '') + '...(truncated)';
}

/** Read the last chained row's `hash` from the tail of the file. */
async function readLastHash(auditPath: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(auditPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return GENESIS_PREV;
    throw e;
  }
  if (stat.size === 0) return GENESIS_PREV;
  const seekTo = Math.max(0, stat.size - 8192);
  const fd = await fs.open(auditPath, 'r');
  try {
    const len = stat.size - seekTo;
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, seekTo);
    const tail = buf.toString('utf-8');
    const lines = tail.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const row = JSON.parse(line) as { hash?: unknown };
        if (row && typeof row.hash === 'string') return row.hash;
        return GENESIS_PREV;
      } catch {
        continue;
      }
    }
    return GENESIS_PREV;
  } finally {
    await fd.close();
  }
}

/** What callers supply when appending a row: identifying fields + outcome.
 *  `ts`, `hash_prev`, and `hash` are computed here so the chain stays sound. */
export interface PartialAuditRow {
  subagent: string;
  tool: string;
  input_summary: string;
  session_id: string;
  decision: GovernanceDecision;
  reason?: string;
}

/** Module-level serialization tail. Every appendAuditRow call awaits the
 *  previous one before reading the last hash, eliminating the read-then-write
 *  race that would otherwise be possible. */
let _appendChain: Promise<void> = Promise.resolve();

/** Append a fully-chained row to runs/<runDir>/audit.jsonl. */
export async function appendAuditRow(
  runDir: string,
  row: PartialAuditRow,
): Promise<void> {
  const myTurn = _appendChain.then(() => _doAppend(runDir, row));
  _appendChain = myTurn.catch(() => {});
  return myTurn;
}

async function _doAppend(runDir: string, row: PartialAuditRow): Promise<void> {
  const auditPath = path.join(runDir, 'audit.jsonl');
  await fs.mkdir(runDir, { recursive: true });

  const hashPrev = await readLastHash(auditPath);
  const ts = isoNowMicroseconds();
  const inputSummary = truncateUtf8(row.input_summary ?? '', INPUT_SUMMARY_MAX_BYTES);

  const rowForHash: Omit<AuditRow, 'hash'> = {
    ts,
    subagent: row.subagent,
    tool: row.tool,
    input_summary: inputSummary,
    session_id: row.session_id,
    decision: row.decision,
    ...(row.reason !== undefined ? { reason: row.reason } : {}),
    hash_prev: hashPrev,
  };

  const canonical = canonicalJsonStringify(rowForHash);
  const hash = createHmac('sha256', hmacKey()).update(canonical, 'utf-8').digest('hex');

  const fullRow: AuditRow = { ...rowForHash, hash };
  const line = JSON.stringify(fullRow) + '\n';
  await fs.appendFile(auditPath, line, { encoding: 'utf-8' });
}

/** Verify the chain end-to-end. Returns null on success or the first error string. */
export async function verifyAuditChain(auditPath: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(auditPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // empty file = trivially valid
    throw e;
  }
  let prevHash = GENESIS_PREV;
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  for (let i = 0; i < lines.length; i++) {
    let row: AuditRow;
    try {
      row = JSON.parse(lines[i]!) as AuditRow;
    } catch (e) {
      return `line ${i + 1}: malformed JSON — ${(e as Error).message}`;
    }
    if (row.hash_prev !== prevHash) {
      return `line ${i + 1}: hash_prev mismatch — expected ${prevHash}, got ${row.hash_prev}`;
    }
    const { hash: _h, ...forHash } = row;
    const recomputed = createHmac('sha256', hmacKey())
      .update(canonicalJsonStringify(forHash), 'utf-8')
      .digest('hex');
    if (recomputed !== row.hash) {
      return `line ${i + 1}: hash mismatch — recomputed ${recomputed}, file has ${row.hash}`;
    }
    prevHash = row.hash;
  }
  return null;
}

export { GENESIS_PREV, INPUT_SUMMARY_MAX_BYTES, isoNowMicroseconds, truncateUtf8 };
