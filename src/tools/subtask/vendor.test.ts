/**
 * Tests for subtask vendor helpers.
 */

import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_READ_LIMIT,
  formatFileContent,
  isBinaryFile,
  MAX_LINE_LENGTH,
} from './vendor';

describe('formatFileContent', () => {
  it('should format content with line numbers', () => {
    const content = 'line1\nline2\nline3';
    const result = formatFileContent('/path/to/file.ts', content);
    expect(result).toContain('1: line1');
    expect(result).toContain('2: line2');
    expect(result).toContain('3: line3');
    expect(result).toContain('<path>/path/to/file.ts</path>');
    expect(result).toContain('<type>file</type>');
    expect(result).toContain('<content>');
    expect(result).toContain('</content>');
  });

  it('should truncate lines exceeding MAX_LINE_LENGTH', () => {
    const longLine = 'a'.repeat(MAX_LINE_LENGTH + 100);
    const content = `short\n${longLine}\nshort2`;
    const result = formatFileContent('/path/to/file.ts', content);
    expect(result).toContain('...');
    expect(result).not.toContain(longLine);
  });

  it('should indicate when file has more lines', () => {
    const lines = Array(DEFAULT_READ_LIMIT + 10)
      .fill('line')
      .join('\n');
    const result = formatFileContent('/path/to/file.ts', lines);
    expect(result).toContain('Use offset=');
  });

  it('should show end of file message when all lines read', () => {
    const content = 'line1\nline2\nline3';
    const result = formatFileContent('/path/to/file.ts', content);
    expect(result).toContain('End of file');
    expect(result).toContain('total 3 lines');
  });

  it('should handle empty content', () => {
    const result = formatFileContent('/path/to/file.ts', '');
    expect(result).toContain('1: ');
    expect(result).toContain('End of file');
  });

  it('should handle single line content', () => {
    const result = formatFileContent('/path/to/file.ts', 'single line');
    expect(result).toContain('1: single line');
    expect(result).toContain('total 1 lines');
  });
});

describe('isBinaryFile', () => {
  it('should detect binary by extension', async () => {
    const binaryExtensions = [
      '/path/to/file.zip',
      '/path/to/file.exe',
      '/path/to/file.dll',
      '/path/to/file.pyc',
      '/path/to/file.wasm',
    ];

    for (const filepath of binaryExtensions) {
      const result = await isBinaryFile(filepath);
      expect(result).toBe(true);
    }
  });

  it('should not flag text file extensions as binary', async () => {
    // These don't exist, so they'll return false (not binary)
    const textExtensions = [
      '/path/to/file.ts',
      '/path/to/file.js',
      '/path/to/file.txt',
      '/path/to/file.md',
    ];

    for (const filepath of textExtensions) {
      const result = await isBinaryFile(filepath);
      expect(result).toBe(false);
    }
  });

  it('should handle case insensitive extensions', async () => {
    expect(await isBinaryFile('/path/to/file.ZIP')).toBe(true);
    expect(await isBinaryFile('/path/to/file.EXE')).toBe(true);
  });
});

describe('constants', () => {
  it('should have expected default values', () => {
    expect(DEFAULT_READ_LIMIT).toBe(2000);
    expect(MAX_LINE_LENGTH).toBe(2000);
  });
});
