/**
 * Unit tests for the Claude Code stop-hook script.
 *
 * The hook is a CJS script (not a module), so we load it into a VM
 * context and extract the pure functions for testing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Script, createContext } from 'vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dir, '../../src/claude/plugin/scripts');
const hookPath = join(scriptsDir, 'discode-stop-hook.js');

type ExtractTextBlocksFn = (node: unknown, depth?: number) => string[];
type ExtractThinkingBlocksFn = (node: unknown, depth?: number) => string[];
type ReadAssistantEntryFn = (entry: unknown) => { messageId: string; text: string; thinking: string; toolUse: Array<{ name: string; input: Record<string, unknown> }> } | null;

function loadLib(overrides: { process?: any; fetch?: any } = {}) {
  const realFs = require('fs');
  const libSrc = readFileSync(join(scriptsDir, 'discode-hook-lib.js'), 'utf-8');
  const libMod = { exports: {} as any };
  new Script(libSrc, { filename: 'discode-hook-lib.js' }).runInContext(createContext({
    require: (m: string) => m === 'fs' ? realFs : {},
    module: libMod, exports: libMod.exports,
    process: overrides.process || { env: {} },
    fetch: overrides.fetch || (async () => ({})),
    Buffer, Promise, setTimeout, JSON, Array, Object, Math, Number, String, parseInt, parseFloat,
  }));
  return libMod.exports;
}

function loadHookFunctions() {
  const raw = readFileSync(hookPath, 'utf-8');
  // Strip the self-executing main() so it doesn't run
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
    extractTextBlocks: (ctx as any).extractTextBlocks as ExtractTextBlocksFn,
    extractThinkingBlocks: (ctx as any).extractThinkingBlocks as ExtractThinkingBlocksFn,
    readAssistantEntry: (ctx as any).readAssistantEntry as ReadAssistantEntryFn,
  };
}

const { extractTextBlocks, extractThinkingBlocks, readAssistantEntry } = loadHookFunctions();

// ── extractTextBlocks ────────────────────────────────────────────────

describe('extractTextBlocks', () => {
  it('returns string in array for plain string', () => {
    expect(extractTextBlocks('hello')).toEqual(['hello']);
  });

  it('returns empty array for empty string', () => {
    expect(extractTextBlocks('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(extractTextBlocks('   ')).toEqual([]);
  });

  it('extracts text from { type: "text", text: "..." }', () => {
    expect(extractTextBlocks({ type: 'text', text: 'hello' })).toEqual(['hello']);
  });

  it('returns empty for text block with empty text', () => {
    expect(extractTextBlocks({ type: 'text', text: '   ' })).toEqual([]);
  });

  it('extracts text from array of text blocks', () => {
    const input = [
      { type: 'text', text: 'part1' },
      { type: 'text', text: 'part2' },
    ];
    expect(extractTextBlocks(input)).toEqual(['part1', 'part2']);
  });

  it('recurses into content arrays', () => {
    const input = {
      content: [
        { type: 'text', text: 'nested' },
      ],
    };
    expect(extractTextBlocks(input)).toEqual(['nested']);
  });

  it('recurses into content string', () => {
    const input = { content: 'direct string' };
    expect(extractTextBlocks(input)).toEqual(['direct string']);
  });

  it('returns empty for null', () => {
    expect(extractTextBlocks(null)).toEqual([]);
  });

  it('returns empty for undefined', () => {
    expect(extractTextBlocks(undefined)).toEqual([]);
  });

  it('returns empty for number', () => {
    expect(extractTextBlocks(42)).toEqual([]);
  });

  it('stops recursion at depth 10', () => {
    // Build deeply nested structure
    let node: any = { type: 'text', text: 'deep' };
    for (let i = 0; i < 12; i++) {
      node = { content: [node] };
    }
    expect(extractTextBlocks(node)).toEqual([]);
  });

  it('extracts from object with text property but no type', () => {
    expect(extractTextBlocks({ text: 'implicit' })).toEqual(['implicit']);
  });

  it('skips tool_use blocks', () => {
    const input = [
      { type: 'text', text: 'before' },
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: {} },
      { type: 'text', text: 'after' },
    ];
    expect(extractTextBlocks(input)).toEqual(['before', 'after']);
  });
});

// ── extractThinkingBlocks ─────────────────────────────────────────────

describe('extractThinkingBlocks', () => {
  it('extracts thinking from { type: "thinking", thinking: "..." }', () => {
    expect(extractThinkingBlocks({ type: 'thinking', thinking: 'Let me reason...' })).toEqual(['Let me reason...']);
  });

  it('returns empty for non-thinking blocks', () => {
    expect(extractThinkingBlocks({ type: 'text', text: 'hello' })).toEqual([]);
  });

  it('returns empty for empty thinking', () => {
    expect(extractThinkingBlocks({ type: 'thinking', thinking: '   ' })).toEqual([]);
  });

  it('extracts from arrays', () => {
    const input = [
      { type: 'thinking', thinking: 'Step 1' },
      { type: 'text', text: 'visible' },
      { type: 'thinking', thinking: 'Step 2' },
    ];
    expect(extractThinkingBlocks(input)).toEqual(['Step 1', 'Step 2']);
  });

  it('recurses into content arrays', () => {
    const input = {
      content: [
        { type: 'thinking', thinking: 'nested thinking' },
      ],
    };
    expect(extractThinkingBlocks(input)).toEqual(['nested thinking']);
  });

  it('returns empty for null/undefined', () => {
    expect(extractThinkingBlocks(null)).toEqual([]);
    expect(extractThinkingBlocks(undefined)).toEqual([]);
  });

  it('returns empty for strings and numbers', () => {
    expect(extractThinkingBlocks('hello')).toEqual([]);
    expect(extractThinkingBlocks(42)).toEqual([]);
  });

  it('stops recursion at depth 10', () => {
    let node: any = { type: 'thinking', thinking: 'deep' };
    for (let i = 0; i < 12; i++) {
      node = { content: [node] };
    }
    expect(extractThinkingBlocks(node)).toEqual([]);
  });

  it('extracts multiple thinking blocks from single content array', () => {
    const input = [
      { type: 'thinking', thinking: 'Step 1: analyze the code' },
      { type: 'text', text: 'visible response' },
      { type: 'thinking', thinking: 'Step 2: verify the fix' },
    ];
    expect(extractThinkingBlocks(input)).toEqual([
      'Step 1: analyze the code',
      'Step 2: verify the fix',
    ]);
  });

  it('ignores thinking property when type is not "thinking"', () => {
    // Some blocks might have a "thinking" property but not be thinking blocks
    expect(extractThinkingBlocks({ type: 'text', thinking: 'sneaky' })).toEqual([]);
  });

  it('ignores thinking when value is not a string', () => {
    expect(extractThinkingBlocks({ type: 'thinking', thinking: 42 })).toEqual([]);
    expect(extractThinkingBlocks({ type: 'thinking', thinking: ['array'] })).toEqual([]);
    expect(extractThinkingBlocks({ type: 'thinking', thinking: null })).toEqual([]);
  });
});

// ── readAssistantEntry ───────────────────────────────────────────────

describe('readAssistantEntry', () => {
  it('extracts text from assistant entry with message wrapper', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_123',
        content: [{ type: 'text', text: 'Hello!' }],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result).toEqual({ messageId: 'msg_123', text: 'Hello!', thinking: '', toolUse: [] });
  });

  it('returns null for non-assistant entry', () => {
    expect(readAssistantEntry({ type: 'user', message: {} })).toBeNull();
  });

  it('returns null for null input', () => {
    expect(readAssistantEntry(null)).toBeNull();
  });

  it('returns null for array input', () => {
    expect(readAssistantEntry([1, 2, 3])).toBeNull();
  });

  it('handles entry without message.id', () => {
    const entry = {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'no id' }],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result).toEqual({ messageId: '', text: 'no id', thinking: '', toolUse: [] });
  });

  it('joins multiple text blocks with newline', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.text).toBe('line1\nline2');
  });

  it('extracts thinking from assistant entry', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'Let me think...' },
          { type: 'text', text: 'The answer is 42' },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.text).toBe('The answer is 42');
    expect(result?.thinking).toBe('Let me think...');
  });

  it('returns empty text when content has no text blocks', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'bash' },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.text).toBe('');
  });
});
