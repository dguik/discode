/**
 * Unit tests for the Claude Code stop-hook script.
 *
 * The hook is a CJS script (not a module), so we load it into a VM
 * context and extract the pure functions for testing.
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

type ExtractTextBlocksFn = (node: unknown, depth?: number) => string[];
type ExtractThinkingBlocksFn = (node: unknown, depth?: number) => string[];
type ExtractToolUseBlocksFn = (node: unknown, depth?: number) => Array<{ name: string; input: Record<string, unknown> }>;
type FormatPromptTextFn = (toolUseBlocks: Array<{ name: string; input: Record<string, unknown> }>) => string;
type ReadAssistantEntryFn = (entry: unknown) => { messageId: string; text: string; thinking: string; toolUse: Array<{ name: string; input: Record<string, unknown> }> } | null;
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
    extractToolUseBlocks: (ctx as any).extractToolUseBlocks as ExtractToolUseBlocksFn,
    formatPromptText: (ctx as any).formatPromptText as FormatPromptTextFn,
    readAssistantEntry: (ctx as any).readAssistantEntry as ReadAssistantEntryFn,
    parseTurnTexts: (ctx as any).parseTurnTexts as ParseTurnTextsFn,
    readTail: (ctx as any).readTail as ReadTailFn,
  };
}

const { parseTurnTexts } = loadHookFunctions();

describe('parseTurnTexts — thinking extraction', () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  it('extracts thinking from single-message turn', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'Let me reason about this...' },
          { type: 'text', text: 'The answer is 42' },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('The answer is 42');
    expect(result.thinking).toBe('Let me reason about this...');
  });

  it('collects thinking from ALL messageIds in the turn', () => {
    // In real transcripts, thinking appears in earlier messageIds (before tool calls)
    // but the final answer is in a different messageId. We must collect all thinking.
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'First reasoning' }, { type: 'text', text: 'Let me check' }] } }),
      line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'thinking', thinking: 'Second reasoning' }, { type: 'text', text: 'Final answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Final answer');
    expect(result.thinking).toBe('First reasoning\nSecond reasoning');
  });

  it('collects thinking from earlier messageIds across tool calls (real transcript pattern)', () => {
    // This mirrors real Claude Code transcripts where:
    // - msg_A has thinking + tool_use
    // - tool_result entry
    // - msg_B has thinking + tool_use
    // - tool_result entry
    // - msg_C has the final text (NO thinking)
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'Let me search for the file' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'text', text: 'Searching...' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'thinking', thinking: 'Found it, now analyzing' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'text', text: 'Here is the final answer.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Here is the final answer.');
    // Thinking should be collected from msg_A and msg_B even though displayText is from msg_C
    expect(result.thinking).toBe('Let me search for the file\nFound it, now analyzing');
    // turnText includes all text from the turn
    expect(result.turnText).toContain('Searching...');
    expect(result.turnText).toContain('Here is the final answer.');
  });

  it('returns empty thinking when no thinking blocks present', () => {
    const tail = line({
      type: 'assistant',
      message: { id: 'msg_1', content: [{ type: 'text', text: 'Just text' }] },
    });
    const result = parseTurnTexts(tail);
    expect(result.thinking).toBe('');
  });

  it('combines multiple thinking parts across entries', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Part A' }] } }),
      line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Part B' }, { type: 'text', text: 'Answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.thinking).toBe('Part A\nPart B');
    expect(result.displayText).toBe('Answer');
  });

  it('collects thinking from 3+ messageIds in a long multi-step turn', () => {
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'Step 1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'thinking', thinking: 'Step 2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_B', content: [{ type: 'tool_use', id: 'tu_2', name: 'read', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'thinking', thinking: 'Step 3' }] } }),
      line({ type: 'assistant', message: { id: 'msg_C', content: [{ type: 'tool_use', id: 'tu_3', name: 'write', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_3' }] } }),
      line({ type: 'assistant', message: { id: 'msg_D', content: [{ type: 'text', text: 'All done.' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('All done.');
    expect(result.thinking).toBe('Step 1\nStep 2\nStep 3');
  });

  it('returns empty thinking for whitespace-only thinking blocks', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: '   \n  ' },
          { type: 'text', text: 'Answer' },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('Answer');
    expect(result.thinking).toBe('');
  });

  it('handles thinking with special characters and unicode', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'thinking', thinking: 'Let me think about 한국어 and emoji 🤔...\nStep 2: verify "quotes" & <tags>' },
          { type: 'text', text: 'Done' },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.thinking).toBe('Let me think about 한국어 and emoji 🤔...\nStep 2: verify "quotes" & <tags>');
  });

  it('handles turn with only thinking blocks and no final text', () => {
    // Edge case: all entries are thinking + tool_use, no final text message
    const tail = [
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'Reasoning...' }] } }),
      line({ type: 'assistant', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] } }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('');
    expect(result.turnText).toBe('');
    expect(result.thinking).toBe('Reasoning...');
  });

  it('does not collect thinking from previous turn', () => {
    const tail = [
      // Previous turn
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'thinking', thinking: 'Old thinking' }] } }),
      line({ type: 'assistant', message: { id: 'msg_old', content: [{ type: 'text', text: 'Old answer' }] } }),
      // Turn boundary
      line({ type: 'user', message: { content: [{ type: 'text', text: 'New question' }] } }),
      // Current turn (no thinking)
      line({ type: 'assistant', message: { id: 'msg_new', content: [{ type: 'text', text: 'New answer' }] } }),
    ].join('\n');

    const result = parseTurnTexts(tail);
    expect(result.displayText).toBe('New answer');
    expect(result.thinking).toBe('');
  });
});
