/**
 * /tts-speak — synthesize arbitrary text directly to the TTS bridge.
 *
 * Short-circuits BEFORE the LLM (mirrors src/commands/remember.ts).
 * The user types `/tts-speak <text>` and the text lands in their headphones
 * via tailscale within <100 ms of pressing enter. No LLM hop. No summary.
 * No auto-on-idle delay.
 *
 * Flow:
 *   /tts-speak Operator wants tabs not spaces
 *      → handleCommandExecuteBefore(args="Operator wants tabs not spaces")
 *      → spawn edge-tts --write-media /tmp/opencode-tts-{ts}-speak.mp3
 *      → tts-bridge.mjs fs.watch fires
 *      → SSE broadcast 'new-audio'
 *      → Studio_PC browser auto-plays
 *      → output.parts = ['✓ speaking ... (N chars)']
 *
 * Why override opencode-tts's built-in /tts-speak (which is just a prompt
 * template "$ARGUMENTS"):
 *   - The built-in routes through the LLM (two hops, summary then synth)
 *   - This direct path is one synth call, ~200 ms total
 *   - Matches the operator's intent: "trigger the same path every time"
 *
 * Voice / rate match the opencode-tts plugin config so the experience is
 * consistent whether the audio comes from auto-on-idle or /tts-speak.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COMMAND_NAME = 'tts-speak';

const TMP_DIR = '/tmp';
const VOICE = process.env.TTS_SPEAK_VOICE ?? 'en-US-AvaNeural';
const RATE = process.env.TTS_SPEAK_RATE ?? '+15%';
const VOLUME = process.env.TTS_SPEAK_VOLUME ?? '+0%';

const EDGE_TTS_BIN_CANDIDATES = [
  join(homedir(), '.config', 'opencode', 'tts-venv', 'bin', 'edge-tts'),
  join(homedir(), '.local', 'bin', 'edge-tts'),
  '/usr/local/bin/edge-tts',
  '/usr/bin/edge-tts',
];

function findEdgeTts(): string | null {
  for (const path of EDGE_TTS_BIN_CANDIDATES) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Pure logic: build the output path for the mp3.
 * Exported for testing.
 */
export function buildOutputPath(now: number = Date.now()): string {
  return join(TMP_DIR, `opencode-tts-${now}-speak.mp3`);
}

/**
 * Spawn edge-tts and resolve when the mp3 is on disk.
 * Returns the output path.
 */
export async function speak(text: string): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('text is required');

  const binary = findEdgeTts();
  if (!binary) {
    throw new Error(
      'edge-tts not found. Install via: python3 -m venv ~/.config/opencode/tts-venv && ' +
        '~/.config/opencode/tts-venv/bin/pip install edge-tts',
    );
  }

  const outputPath = buildOutputPath();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [
      '--voice', VOICE,
      '--rate', RATE,
      '--volume', VOLUME,
      '--text', trimmed,
      '--write-media', outputPath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve(outputPath);
      } else {
        reject(new Error(`edge-tts exit=${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

interface OpencodeConfig {
  command?: Record<string, unknown>;
}

interface CommandExecuteBeforeInput {
  command: string;
  sessionID: string;
  arguments: string;
}

interface CommandExecuteBeforeOutput {
  parts: Array<{ type: string; text?: string }>;
}

export function createTtsSpeakCommand(): {
  registerCommand: (config: OpencodeConfig) => void;
  handleCommandExecuteBefore: (
    input: CommandExecuteBeforeInput,
    output: CommandExecuteBeforeOutput,
  ) => Promise<void>;
} {
  return {
    registerCommand: (opencodeConfig) => {
      if (!opencodeConfig.command) opencodeConfig.command = {};
      const cmd = opencodeConfig.command as Record<string, unknown>;
      // Override unconditionally — pms version takes precedence over the
      // opencode-tts plugin's template-only registration. Both call into
      // edge-tts, but ours skips the LLM hop and writes directly to /tmp
      // where the tts-bridge fs.watch picks it up.
      cmd[COMMAND_NAME] = {
        template: 'Speak the provided text directly to the TTS bridge (no LLM hop)',
        description:
          'Synthesize arbitrary text to mp3 → /tmp → tts-bridge → Studio_PC headphones (instant)',
      };
    },

    handleCommandExecuteBefore: async (input, output) => {
      if (input.command !== COMMAND_NAME) return;

      // Short-circuit: clear and replace
      output.parts.length = 0;

      const text = input.arguments.trim();
      if (!text) {
        output.parts.push({
          type: 'text',
          text:
            '/tts-speak: provide text to speak.\n' +
            'Usage: /tts-speak <text>\n' +
            'Example: /tts-speak Build succeeded. Ready for review.',
        });
        return;
      }

      try {
        const outputPath = await speak(text);
        const filename = outputPath.split('/').pop();
        output.parts.push({
          type: 'text',
          text: [
            `✓ speaking (${text.length} chars) — ${filename}`,
            `  bridge auto-plays in <100 ms via SSE`,
            `  URL: https://atlas01.tail00ae77.ts.net:8445/`,
          ].join('\n'),
        });
      } catch (err) {
        output.parts.push({
          type: 'text',
          text:
            `/tts-speak: ${err instanceof Error ? err.message : String(err)}\n` +
            `Check: pgrep -af tts-bridge.mjs · ls /tmp/opencode-tts-*.mp3`,
        });
      }
    },
  };
}

export const __testing = {
  COMMAND_NAME,
  buildOutputPath,
  findEdgeTts,
  EDGE_TTS_BIN_CANDIDATES,
};
