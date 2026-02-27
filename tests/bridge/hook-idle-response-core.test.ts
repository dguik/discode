/**
 * Tests for hook-idle-response.ts — text, files, thinking, usage, prompt choices.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  buildFinalizeHeader,
  postUsageToChannel,
  postIntermediateTextToChannel,
  postThinkingToChannel,
  postResponseText,
  postResponseFiles,
  postPromptChoices,
  validateFilePaths,
  splitAndSendToChannel,
} from '../../src/bridge/hook-idle-response.js';
import { createMockMessaging } from './hook-server-helpers.js';
import { existsSync, realpathSync } from 'fs';

// Mock fs for validateFilePaths in postResponseText / postResponseFiles
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    realpathSync: vi.fn((p: string) => p),
  };
});

const mockedExistsSync = vi.mocked(existsSync);
const mockedRealpathSync = vi.mocked(realpathSync);

afterEach(() => {
  delete process.env.DISCODE_SHOW_USAGE;
  delete process.env.DISCODE_SHOW_THINKING;
});

function mockMessaging(platform: 'slack' | 'discord' = 'slack') {
  const m = createMockMessaging();
  return { ...m, platform } as any;
}

function makeCtx(overrides: Record<string, any> = {}) {
  return {
    event: {},
    projectName: 'test-project',
    channelId: 'ch-1',
    agentType: 'claude',
    instanceId: 'claude',
    instanceKey: 'claude',
    text: undefined as string | undefined,
    projectPath: '/tmp/test-project',
    pendingSnapshot: undefined,
    ...overrides,
  };
}

// ── buildFinalizeHeader ──────────────────────────────────────────────

describe('buildFinalizeHeader', () => {
  it('returns undefined for undefined usage', () => {
    expect(buildFinalizeHeader(undefined)).toBeUndefined();
  });

  it('returns undefined for non-object usage', () => {
    expect(buildFinalizeHeader('bad' as any)).toBeUndefined();
  });

  it('builds header with tokens only', () => {
    const result = buildFinalizeHeader({ inputTokens: 1000, outputTokens: 500 });
    expect(result).toContain('Done');
    expect(result).toContain('1,500');
    expect(result).not.toContain('$');
  });

  it('builds header with tokens and cost', () => {
    const result = buildFinalizeHeader({ inputTokens: 2000, outputTokens: 800, totalCostUsd: 0.05 });
    expect(result).toContain('2,800');
    expect(result).toContain('$0.05');
  });

  it('returns just Done for zero tokens', () => {
    const result = buildFinalizeHeader({ inputTokens: 0, outputTokens: 0 });
    expect(result).toBe('\u2705 Done');
  });
});

// ── postUsageToChannel ───────────────────────────────────────────────

describe('postUsageToChannel', () => {
  beforeEach(() => { process.env.DISCODE_SHOW_USAGE = '1'; });

  it('does nothing for undefined usage', async () => {
    const m = mockMessaging();
    await postUsageToChannel(m, 'ch-1', undefined);
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing for zero tokens', async () => {
    const m = mockMessaging();
    await postUsageToChannel(m, 'ch-1', { inputTokens: 0, outputTokens: 0 });
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends usage line when tokens exist', async () => {
    const m = mockMessaging();
    await postUsageToChannel(m, 'ch-1', { inputTokens: 100, outputTokens: 50 });
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('100'));
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('50'));
  });

  it('includes cost when totalCostUsd is provided', async () => {
    const m = mockMessaging();
    await postUsageToChannel(m, 'ch-1', { inputTokens: 100, outputTokens: 50, totalCostUsd: 0.12 });
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', expect.stringContaining('$0.12'));
  });

  it('swallows sendToChannel errors silently', async () => {
    const m = mockMessaging();
    m.sendToChannel.mockRejectedValueOnce(new Error('API down'));
    await expect(postUsageToChannel(m, 'ch-1', { inputTokens: 10, outputTokens: 5 })).resolves.toBeUndefined();
  });
});

// ── postIntermediateTextToChannel ────────────────────────────────────

describe('postIntermediateTextToChannel', () => {
  it('does nothing for empty intermediateText', async () => {
    const m = mockMessaging();
    await postIntermediateTextToChannel(m, 'ch-1', { intermediateText: '' });
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing for missing intermediateText', async () => {
    const m = mockMessaging();
    await postIntermediateTextToChannel(m, 'ch-1', {});
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends intermediateText to channel', async () => {
    const m = mockMessaging();
    await postIntermediateTextToChannel(m, 'ch-1', { intermediateText: 'Checking files...' });
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', 'Checking files...');
  });

  it('warns on error instead of throwing', async () => {
    const m = mockMessaging();
    m.sendToChannel.mockRejectedValueOnce(new Error('fail'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await postIntermediateTextToChannel(m, 'ch-1', { intermediateText: 'test' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── postThinkingToChannel ────────────────────────────────────────────

describe('postThinkingToChannel', () => {
  beforeEach(() => { process.env.DISCODE_SHOW_THINKING = '1'; });

  it('does nothing for empty thinking', async () => {
    const m = mockMessaging();
    await postThinkingToChannel(m, 'ch-1', { thinking: '' });
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing for missing thinking', async () => {
    const m = mockMessaging();
    await postThinkingToChannel(m, 'ch-1', {});
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends thinking wrapped in code block', async () => {
    const m = mockMessaging();
    await postThinkingToChannel(m, 'ch-1', { thinking: 'Analyzing...' });
    const sent = m.sendToChannel.mock.calls[0][1];
    expect(sent).toContain(':brain: *Reasoning*');
    expect(sent).toContain('```\nAnalyzing...\n```');
  });

  it('truncates thinking over 12000 characters', async () => {
    const m = mockMessaging();
    const longThinking = 'x'.repeat(15000);
    await postThinkingToChannel(m, 'ch-1', { thinking: longThinking });
    // The thinking may be split across multiple chunks by splitAndSendToChannel
    const allSent = m.sendToChannel.mock.calls.map((c: any[]) => c[1]).join('');
    expect(allSent).toContain('_(truncated)_');
    // Should not contain the full 15000 chars
    expect(allSent).not.toContain('x'.repeat(15000));
  });

  it('warns on error instead of throwing', async () => {
    const m = mockMessaging();
    m.sendToChannel.mockRejectedValueOnce(new Error('fail'));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await postThinkingToChannel(m, 'ch-1', { thinking: 'test' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── postResponseText ─────────────────────────────────────────────────

describe('postResponseText', () => {
  it('does nothing for empty text', async () => {
    const m = mockMessaging();
    await postResponseText(m, makeCtx({ text: '' }));
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('does nothing for undefined text', async () => {
    const m = mockMessaging();
    await postResponseText(m, makeCtx({ text: undefined }));
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });

  it('sends text to channel', async () => {
    const m = mockMessaging();
    await postResponseText(m, makeCtx({ text: 'Done fixing the bug.' }));
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', 'Done fixing the bug.');
  });
});

// ── postResponseFiles ────────────────────────────────────────────────

describe('postResponseFiles', () => {
  it('does nothing for empty text', async () => {
    const m = mockMessaging();
    await postResponseFiles(m, makeCtx({ text: '' }));
    expect(m.sendToChannelWithFiles).not.toHaveBeenCalled();
  });

  it('does nothing when no valid file paths found', async () => {
    const m = mockMessaging();
    // existsSync is mocked to return false by default
    await postResponseFiles(m, makeCtx({ text: 'Some text without files' }));
    expect(m.sendToChannelWithFiles).not.toHaveBeenCalled();
  });
});

// ── postPromptChoices ────────────────────────────────────────────────

describe('postPromptChoices', () => {
  it('does nothing when no promptText or promptQuestions', async () => {
    const m = mockMessaging();
    await postPromptChoices(m, makeCtx({ event: {} }));
    expect(m.sendToChannel).not.toHaveBeenCalled();
    expect(m.sendQuestionWithButtons).not.toHaveBeenCalled();
  });

  it('sends promptText to channel', async () => {
    const m = mockMessaging();
    await postPromptChoices(m, makeCtx({ event: { promptText: 'Pick an option' } }));
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', 'Pick an option');
  });

  it('fires sendQuestionWithButtons for structured questions', async () => {
    const m = mockMessaging();
    const questions = [
      { question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] },
    ];
    await postPromptChoices(m, makeCtx({ event: { promptQuestions: questions } }));
    expect(m.sendQuestionWithButtons).toHaveBeenCalledWith('ch-1', questions);
  });

  it('ignores invalid entries in promptQuestions', async () => {
    const m = mockMessaging();
    const questions = [
      null,
      { question: 'missing options' },
      { question: 'Valid', options: [{ label: 'X' }] },
    ];
    await postPromptChoices(m, makeCtx({ event: { promptQuestions: questions } }));
    expect(m.sendQuestionWithButtons).toHaveBeenCalledWith('ch-1', [
      { question: 'Valid', options: [{ label: 'X' }] },
    ]);
  });

  it('falls back to promptText when promptQuestions has no valid entries', async () => {
    const m = mockMessaging();
    await postPromptChoices(m, makeCtx({
      event: { promptQuestions: [null], promptText: 'Fallback text' },
    }));
    expect(m.sendQuestionWithButtons).not.toHaveBeenCalled();
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', 'Fallback text');
  });
});

// ── validateFilePaths ────────────────────────────────────────────────

describe('validateFilePaths', () => {
  it('returns empty array when projectPath is empty', () => {
    expect(validateFilePaths(['/some/path'], '')).toEqual([]);
  });

  it('returns empty array when existsSync returns false', () => {
    mockedExistsSync.mockReturnValue(false);
    expect(validateFilePaths(['/tmp/test/file.txt'], '/tmp/test')).toEqual([]);
  });

  it('returns valid paths under projectPath', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedRealpathSync.mockImplementation((p: any) => p as any);
    expect(validateFilePaths(['/tmp/test/file.txt'], '/tmp/test')).toEqual(['/tmp/test/file.txt']);
  });

  it('rejects paths outside projectPath', () => {
    mockedExistsSync.mockReturnValue(true);
    mockedRealpathSync.mockImplementation((p: any) => p as any);
    expect(validateFilePaths(['/etc/passwd'], '/tmp/test')).toEqual([]);
  });
});

// ── splitAndSendToChannel ────────────────────────────────────────────

describe('splitAndSendToChannel', () => {
  it('splits for slack platform', async () => {
    const m = mockMessaging('slack');
    await splitAndSendToChannel(m, 'ch-1', 'Hello world');
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', 'Hello world');
  });

  it('splits for discord platform', async () => {
    const m = mockMessaging('discord');
    await splitAndSendToChannel(m, 'ch-1', 'Hello world');
    expect(m.sendToChannel).toHaveBeenCalledWith('ch-1', 'Hello world');
  });

  it('skips empty chunks after splitting', async () => {
    const m = mockMessaging('slack');
    await splitAndSendToChannel(m, 'ch-1', '   ');
    expect(m.sendToChannel).not.toHaveBeenCalled();
  });
});
