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

const { extractToolUseBlocks, formatPromptText, readAssistantEntry, parseTurnTexts } = loadHookFunctions();

describe('extractToolUseBlocks', () => {
  it('extracts tool_use block from content array', () => {
    const input = [
      { type: 'text', text: 'hello' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    ];
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'Bash', input: { command: 'ls' } }]);
  });

  it('extracts multiple tool_use blocks', () => {
    const input = [
      { type: 'tool_use', name: 'Read', input: { file: 'a.ts' } },
      { type: 'text', text: 'between' },
      { type: 'tool_use', name: 'Edit', input: { file: 'b.ts' } },
    ];
    const result = extractToolUseBlocks(input);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Read');
    expect(result[1].name).toBe('Edit');
  });

  it('recurses into content arrays', () => {
    const input = {
      content: [
        { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } },
      ],
    };
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'AskUserQuestion', input: { questions: [] } }]);
  });

  it('returns empty for null/undefined', () => {
    expect(extractToolUseBlocks(null)).toEqual([]);
    expect(extractToolUseBlocks(undefined)).toEqual([]);
  });

  it('returns empty for strings and numbers', () => {
    expect(extractToolUseBlocks('hello')).toEqual([]);
    expect(extractToolUseBlocks(42)).toEqual([]);
  });

  it('stops recursion at depth 10', () => {
    let node: any = { type: 'tool_use', name: 'Bash', input: {} };
    for (let i = 0; i < 12; i++) {
      node = { content: [node] };
    }
    expect(extractToolUseBlocks(node)).toEqual([]);
  });

  it('defaults input to {} when missing', () => {
    const input = [{ type: 'tool_use', name: 'ExitPlanMode' }];
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'ExitPlanMode', input: {} }]);
  });

  it('defaults input to {} when not an object', () => {
    const input = [{ type: 'tool_use', name: 'Bash', input: 'invalid' }];
    expect(extractToolUseBlocks(input)).toEqual([{ name: 'Bash', input: {} }]);
  });

  it('ignores tool_use without name', () => {
    const input = [{ type: 'tool_use', input: {} }];
    expect(extractToolUseBlocks(input)).toEqual([]);
  });
});

describe('formatPromptText', () => {
  it('formats AskUserQuestion with header and options', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          header: 'Approach',
          question: 'Which approach?',
          options: [
            { label: 'Option A', description: 'Fast' },
            { label: 'Option B', description: 'Safe' },
          ],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('❓');
    expect(result).toContain('*Approach*');
    expect(result).toContain('Which approach?');
    expect(result).toContain('*Option A*');
    expect(result).toContain('Fast');
    expect(result).toContain('*Option B*');
    expect(result).toContain('Safe');
  });

  it('formats AskUserQuestion without descriptions', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          header: 'Choice',
          question: 'Pick one?',
          options: [
            { label: 'Yes' },
            { label: 'No' },
          ],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('*Yes*');
    expect(result).toContain('*No*');
    expect(result).not.toContain('—');
  });

  it('formats AskUserQuestion without header', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Which one?',
          options: [{ label: 'A' }],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('❓ Which one?');
    // Should NOT have *header* format when header is missing
    expect(result).not.toMatch(/\*\w+\*\nWhich/);
  });

  it('formats ExitPlanMode', () => {
    const blocks = [{ name: 'ExitPlanMode', input: {} }];
    const result = formatPromptText(blocks);
    expect(result).toContain('Plan approval needed');
  });

  it('returns empty for non-interactive tools', () => {
    const blocks = [
      { name: 'Bash', input: { command: 'ls' } },
      { name: 'Read', input: { file: 'a.ts' } },
      { name: 'Edit', input: {} },
    ];
    expect(formatPromptText(blocks)).toBe('');
  });

  it('returns empty for empty array', () => {
    expect(formatPromptText([])).toBe('');
  });

  it('formats multiple questions', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [
          { header: 'Q1', question: 'First?', options: [{ label: 'A' }] },
          { header: 'Q2', question: 'Second?', options: [{ label: 'B' }] },
        ],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).toContain('First?');
    expect(result).toContain('Second?');
  });

  it('handles AskUserQuestion with missing questions array', () => {
    const blocks = [{ name: 'AskUserQuestion', input: {} }];
    expect(formatPromptText(blocks)).toBe('');
  });

  it('combines AskUserQuestion and ExitPlanMode in same array', () => {
    const blocks = [
      {
        name: 'AskUserQuestion',
        input: {
          questions: [{
            header: 'Choice',
            question: 'Pick?',
            options: [{ label: 'Yes' }],
          }],
        },
      },
      { name: 'ExitPlanMode', input: {} },
    ];
    const result = formatPromptText(blocks);
    expect(result).toContain('Pick?');
    expect(result).toContain('Plan approval needed');
  });

  it('ignores questions with empty question text', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [
          { header: 'H1', question: '', options: [{ label: 'A' }] },
          { header: 'H2', question: 'Real question?', options: [{ label: 'B' }] },
        ],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).not.toContain('H1');
    expect(result).toContain('Real question?');
  });

  it('ignores options with empty label', () => {
    const blocks = [{
      name: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Pick?',
          options: [
            { label: '', description: 'hidden' },
            { label: 'Visible', description: 'shown' },
          ],
        }],
      },
    }];
    const result = formatPromptText(blocks);
    expect(result).not.toContain('hidden');
    expect(result).toContain('*Visible*');
  });
});
