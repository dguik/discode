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

describe('readAssistantEntry toolUse', () => {
  it('extracts tool_use blocks from assistant entry', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Let me ask' },
          { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [] } },
        ],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.toolUse).toEqual([{ name: 'AskUserQuestion', input: { questions: [] } }]);
  });

  it('returns empty toolUse when no tool_use blocks', () => {
    const entry = {
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'Just text' }],
      },
    };
    const result = readAssistantEntry(entry);
    expect(result?.toolUse).toEqual([]);
  });
});

describe('parseTurnTexts promptText', () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  it('returns promptText for AskUserQuestion', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Which approach?' },
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                header: 'Approach',
                question: 'Which approach do you prefer?',
                options: [
                  { label: 'Fast', description: 'Quick but risky' },
                  { label: 'Safe', description: 'Slow but reliable' },
                ],
              }],
            },
          },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toContain('Which approach do you prefer?');
    expect(result.promptText).toContain('*Fast*');
    expect(result.promptText).toContain('*Safe*');
  });

  it('returns promptText for ExitPlanMode', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'tool_use', name: 'ExitPlanMode', input: {} },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toContain('Plan approval needed');
  });

  it('returns empty promptText for non-interactive tools', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Running command' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toBe('');
  });

  it('returns empty promptText when no tool_use blocks', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'Just text' }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptText).toBe('');
  });

  it('collects tool_use blocks across multiple messageIds in a turn', () => {
    // Tool_use in earlier messageId, text in later — both should contribute to promptText
    const tail = [
      line({
        type: 'assistant',
        message: {
          id: 'msg_A',
          content: [
            { type: 'text', text: 'Let me check something' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({
        type: 'assistant',
        message: {
          id: 'msg_B',
          content: [
            { type: 'text', text: 'Which approach?' },
            {
              type: 'tool_use',
              name: 'AskUserQuestion',
              input: {
                questions: [{
                  header: 'Approach',
                  question: 'Pick one?',
                  options: [{ label: 'A' }, { label: 'B' }],
                }],
              },
            },
          ],
        },
      }),
    ].join('\n');
    const result = parseTurnTexts(tail);
    // AskUserQuestion from msg_B should appear in promptText
    expect(result.promptText).toContain('Pick one?');
    expect(result.promptText).toContain('*A*');
    expect(result.promptText).toContain('*B*');
    expect(result.displayText).toBe('Which approach?');
  });

  it('does not carry promptText from previous turn', () => {
    const tail = [
      // Previous turn with AskUserQuestion
      line({
        type: 'assistant',
        message: {
          id: 'msg_old',
          content: [
            { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Old?' }] } },
          ],
        },
      }),
      // Turn boundary
      line({ type: 'user', message: { content: [{ type: 'text', text: 'User answered' }] } }),
      // Current turn — no tool_use
      line({
        type: 'assistant',
        message: { id: 'msg_new', content: [{ type: 'text', text: 'Thanks!' }] },
      }),
    ].join('\n');
    const result = parseTurnTexts(tail);
    expect(result.promptText).toBe('');
    expect(result.displayText).toBe('Thanks!');
  });

  it('formats both AskUserQuestion and ExitPlanMode in same turn', () => {
    const tail = [
      line({
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [
            { type: 'text', text: 'Here is my plan' },
            { type: 'tool_use', name: 'ExitPlanMode', input: {} },
          ],
        },
      }),
    ].join('\n');
    const result = parseTurnTexts(tail);
    expect(result.promptText).toContain('Plan approval needed');
  });
});

describe('parseTurnTexts promptQuestions', () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj);
  }

  it('extracts structured questions from AskUserQuestion', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'text', text: 'Which approach?' },
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                header: 'Approach',
                question: 'Which approach do you prefer?',
                options: [
                  { label: 'Fast', description: 'Quick but risky' },
                  { label: 'Safe', description: 'Slow but reliable' },
                ],
              }],
            },
          },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toHaveLength(1);
    expect(result.promptQuestions[0].question).toBe('Which approach do you prefer?');
    expect(result.promptQuestions[0].header).toBe('Approach');
    expect(result.promptQuestions[0].options).toHaveLength(2);
    expect(result.promptQuestions[0].options[0]).toEqual({ label: 'Fast', description: 'Quick but risky' });
    expect(result.promptQuestions[0].options[1]).toEqual({ label: 'Safe', description: 'Slow but reliable' });
  });

  it('returns empty promptQuestions for ExitPlanMode', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'tool_use', name: 'ExitPlanMode', input: {} },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toEqual([]);
  });

  it('returns empty promptQuestions for non-interactive tools', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toEqual([]);
  });

  it('returns empty promptQuestions when no tool_use blocks', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{ type: 'text', text: 'Just text' }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toEqual([]);
  });

  it('preserves multiSelect flag', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Select features',
              options: [{ label: 'Auth' }, { label: 'Logging' }],
              multiSelect: true,
            }],
          },
        }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toHaveLength(1);
    expect(result.promptQuestions[0].multiSelect).toBe(true);
  });

  it('omits header when not provided', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Yes or no?',
              options: [{ label: 'Yes' }, { label: 'No' }],
            }],
          },
        }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toHaveLength(1);
    expect(result.promptQuestions[0].header).toBeUndefined();
    expect(result.promptQuestions[0].multiSelect).toBeUndefined();
  });

  it('omits description from options when not provided', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Pick one',
              options: [{ label: 'A' }, { label: 'B' }],
            }],
          },
        }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions[0].options[0]).toEqual({ label: 'A' });
    expect(result.promptQuestions[0].options[0].description).toBeUndefined();
  });

  it('skips questions with empty options array', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: {
            questions: [
              { question: 'Empty options', options: [] },
              { question: 'Valid?', options: [{ label: 'Yes' }] },
            ],
          },
        }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toHaveLength(1);
    expect(result.promptQuestions[0].question).toBe('Valid?');
  });

  it('skips options with empty label', () => {
    const tail = line({
      type: 'assistant',
      message: {
        id: 'msg_1',
        content: [{
          type: 'tool_use',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Pick',
              options: [
                { label: '', description: 'Empty label' },
                { label: 'Good', description: 'Valid' },
              ],
            }],
          },
        }],
      },
    });
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toHaveLength(1);
    expect(result.promptQuestions[0].options).toHaveLength(1);
    expect(result.promptQuestions[0].options[0].label).toBe('Good');
  });

  it('extracts questions across multiple messageIds in a turn', () => {
    const tail = [
      line({
        type: 'assistant',
        message: {
          id: 'msg_A',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
      line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } }),
      line({
        type: 'assistant',
        message: {
          id: 'msg_B',
          content: [{
            type: 'tool_use',
            name: 'AskUserQuestion',
            input: {
              questions: [{ question: 'Pick?', options: [{ label: 'X' }, { label: 'Y' }] }],
            },
          }],
        },
      }),
    ].join('\n');
    const result = parseTurnTexts(tail);
    expect(result.promptQuestions).toHaveLength(1);
    expect(result.promptQuestions[0].question).toBe('Pick?');
  });
});
