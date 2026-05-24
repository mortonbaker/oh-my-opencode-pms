import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(repoRoot, 'src', 'divoom');
const outputDir = path.join(repoRoot, 'dist', 'divoom');

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

let copied = 0;
for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.gif')) continue;
  copyFileSync(
    path.join(sourceDir, entry.name),
    path.join(outputDir, entry.name),
  );
  copied += 1;
}

console.log(`✅ Copied ${copied} Divoom GIF assets to ${outputDir}`);
