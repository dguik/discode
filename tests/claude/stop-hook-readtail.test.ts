/**
 * Unit tests for readTail from the Claude Code stop-hook script.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dir, '../../src/claude/plugin/scripts');
const hookPath = join(scriptsDir, 'discode-stop-hook.js');

type ParseTurnTextsFn = (tail: string) => { displayText: string; intermediateText: string; turnText: string; thinking: string; promptText: string };
type ReadTailFn = (filePath: string, maxBytes: number) => string;

function loadLib() {
  const realFs = require('fs');
  const libSrc = readFileSync(join(scriptsDir, 'discode-hook-lib.js'), 'utf-8');
  const libMod = { exports: {} as any };
  new Script(libSrc, { filename: 'discode-hook-lib.js' }).runInContext(createContext({
    require: (m: string) => m === 'fs' ? realFs : {},
    module: libMod, exports: libMod.exports,
    process: { env: {} },
    Buffer, Promise, setTimeout, JSON, Array, Object, Math, Number, String, parseInt, parseFloat,
  }));
  return libMod.exports;
}

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  const src = raw.replace(/main\(\)\.catch[\s\S]*$/, '');

  const realFs = require('fs');
  const lib = loadLib();
  const ctx = createContext({
    require: (mod: string) => {
      if (mod === 'fs') return realFs;
      if (mod === './discode-hook-lib.js' || mod === './discode-hook-lib') return lib;
      return {};
    },
    process: { env: {}, stdin: { isTTY: true } },
    console: { error: () => {} },
    Promise,
    setTimeout,
    Buffer,
    fetch: async () => ({}),
    JSON,
    Array,
    Object,
    Math,
    Number,
    String,
    parseInt,
    parseFloat,
  });

  new Script(src, { filename: 'discode-stop-hook.js' }).runInContext(ctx);

  return {
    parseTurnTexts: (ctx as any).parseTurnTexts as ParseTurnTextsFn,
    readTail: (ctx as any).readTail as ReadTailFn,
  };
}

const { parseTurnTexts, readTail } = loadHookFunctions();

// ── readTail ──────────────────────────────────────────────────────────

describe('readTail', () => {
  let tempDir: string;

  function setup() {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-stophook-test-'));
  }

  function teardown() {
    rmSync(tempDir, { recursive: true, force: true });
  }

  it('reads the entire file when maxBytes >= file size', () => {
    setup();
    try {
      const filePath = join(tempDir, 'small.jsonl');
      writeFileSync(filePath, 'hello world');
      const result = readTail(filePath, 65536);
      expect(result).toBe('hello world');
    } finally {
      teardown();
    }
  });

  it('reads only the tail when maxBytes < file size', () => {
    setup();
    try {
      const filePath = join(tempDir, 'large.jsonl');
      writeFileSync(filePath, 'AAAA' + 'BBBB');
      const result = readTail(filePath, 4);
      expect(result).toBe('BBBB');
    } finally {
      teardown();
    }
  });

  it('returns empty string for empty file', () => {
    setup();
    try {
      const filePath = join(tempDir, 'empty.jsonl');
      writeFileSync(filePath, '');
      const result = readTail(filePath, 65536);
      expect(result).toBe('');
    } finally {
      teardown();
    }
  });

  it('returns empty string for non-existent file', () => {
    const result = readTail('/tmp/nonexistent-file-' + Date.now() + '.jsonl', 65536);
    expect(result).toBe('');
  });

  it('handles multi-line JSONL transcript', () => {
    setup();
    try {
      const filePath = join(tempDir, 'transcript.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'question' }] } }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'answer' }] } }),
      ];
      writeFileSync(filePath, lines.join('\n'));
      const tail = readTail(filePath, 65536);
      // Should be parseable by parseTurnTexts
      const result = parseTurnTexts(tail);
      expect(result.displayText).toBe('answer');
    } finally {
      teardown();
    }
  });

  it('reads tail of large transcript correctly', () => {
    setup();
    try {
      const filePath = join(tempDir, 'large-transcript.jsonl');
      // Write many lines, then check that tail captures the last entries
      const filler = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ type: 'progress', index: i })
      ).join('\n');
      const lastLine = JSON.stringify({ type: 'assistant', message: { id: 'final', content: [{ type: 'text', text: 'Final answer' }] } });
      writeFileSync(filePath, filler + '\n' + lastLine);

      // Read only last 512 bytes (should capture the last line)
      const tail = readTail(filePath, 512);
      expect(tail).toContain('Final answer');
    } finally {
      teardown();
    }
  });
});
