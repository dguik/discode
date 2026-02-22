import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeSdkRunner, type SdkRunnerDeps } from '../../src/sdk/claude-sdk-runner.js';

// Mock the SDK module
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query as mockQueryFn } from '@anthropic-ai/claude-agent-sdk';
const mockQuery = vi.mocked(mockQueryFn);

function createDeps(overrides?: Partial<SdkRunnerDeps>): SdkRunnerDeps {
  return {
    projectName: 'test-project',
    instanceId: 'opencode',
    agentType: 'opencode',
    projectPath: '/tmp/test-project',
    permissionAllow: true,
    onEvent: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** Create an async iterable from an array of SDK messages. */
async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

describe('ClaudeSdkRunner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('submitMessage', () => {
    it('should emit session.start from SDKSystemMessage init', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system',
          subtype: 'init',
          uuid: 'uuid-1',
          session_id: 'sess-123',
          model: 'claude-opus-4-6',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'text',
          apiKeySource: 'user',
        },
        {
          type: 'result',
          subtype: 'success',
          uuid: 'uuid-2',
          session_id: 'sess-123',
          duration_ms: 1000,
          duration_api_ms: 900,
          is_error: false,
          num_turns: 1,
          result: 'Hello world',
          total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 },
          modelUsage: {},
          permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('Hello');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const calls = onEvent.mock.calls;

      // Should emit session.start
      const startCall = calls.find((c) => c[0].type === 'session.start');
      expect(startCall).toBeDefined();
      expect(startCall![0].source).toBe('sdk');
      expect(startCall![0].model).toBe('claude-opus-4-6');
      expect(startCall![0].projectName).toBe('test-project');

      // Should store session ID
      expect(runner.getSessionId()).toBe('sess-123');
    });

    it('should emit session.idle from SDKResultMessage success', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system',
          subtype: 'init',
          uuid: 'uuid-1',
          session_id: 'sess-123',
          model: 'claude-opus-4-6',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'text',
          apiKeySource: 'user',
        },
        {
          type: 'result',
          subtype: 'success',
          uuid: 'uuid-2',
          session_id: 'sess-123',
          duration_ms: 1000,
          duration_api_ms: 900,
          is_error: false,
          num_turns: 1,
          result: 'Here is the answer',
          total_cost_usd: 0.03,
          usage: { input_tokens: 5000, output_tokens: 3234 },
          modelUsage: {},
          permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('Help me');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const idleCall = onEvent.mock.calls.find((c) => c[0].type === 'session.idle');
      expect(idleCall).toBeDefined();
      expect(idleCall![0].text).toBe('Here is the answer');
      expect(idleCall![0].usage).toEqual({
        inputTokens: 5000,
        outputTokens: 3234,
        totalCostUsd: 0.03,
      });
    });

    it('should emit session.error from SDKResultMessage error', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system',
          subtype: 'init',
          uuid: 'uuid-1',
          session_id: 'sess-123',
          model: 'claude-opus-4-6',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'text',
          apiKeySource: 'user',
        },
        {
          type: 'result',
          subtype: 'error_max_turns',
          uuid: 'uuid-2',
          session_id: 'sess-123',
          duration_ms: 1000,
          duration_api_ms: 900,
          is_error: true,
          num_turns: 10,
          total_cost_usd: 0.5,
          usage: { input_tokens: 10000, output_tokens: 5000 },
          modelUsage: {},
          permission_denials: [],
          errors: ['Max turns exceeded', 'Budget limit'],
        },
      ]) as any);

      await runner.submitMessage('Do something');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const errorCall = onEvent.mock.calls.find((c) => c[0].type === 'session.error');
      expect(errorCall).toBeDefined();
      expect(errorCall![0].text).toBe('Max turns exceeded; Budget limit');
    });

    it('should emit session.error on query exception', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockImplementation(() => {
        throw new Error('API key invalid');
      });

      await runner.submitMessage('test');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const errorCall = onEvent.mock.calls.find((c) => c[0].type === 'session.error');
      expect(errorCall).toBeDefined();
      expect(errorCall![0].text).toContain('API key invalid');
    });
  });

  describe('stream events', () => {
    it('should emit tool.activity for tool_use start and stop', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system',
          subtype: 'init',
          uuid: 'uuid-1',
          session_id: 'sess-1',
          model: 'claude-opus-4-6',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'text',
          apiKeySource: 'user',
        },
        {
          type: 'stream_event',
          uuid: 'uuid-2',
          session_id: 'sess-1',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
          },
        },
        {
          type: 'stream_event',
          uuid: 'uuid-3',
          session_id: 'sess-1',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"file_path":"/src/index.ts"}' },
          },
        },
        {
          type: 'stream_event',
          uuid: 'uuid-4',
          session_id: 'sess-1',
          parent_tool_use_id: null,
          event: { type: 'content_block_stop', index: 0 },
        },
        {
          type: 'result',
          subtype: 'success',
          uuid: 'uuid-5',
          session_id: 'sess-1',
          duration_ms: 500,
          duration_api_ms: 400,
          is_error: false,
          num_turns: 1,
          result: 'Done',
          total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 },
          modelUsage: {},
          permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('Read file');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const activities = onEvent.mock.calls
        .filter((c) => c[0].type === 'tool.activity')
        .map((c) => c[0].text);

      // Should have "Running: Read..." and then the formatted completion
      expect(activities).toContain('\uD83D\uDD27 Running: Read...');
      expect(activities.some((a: string) => a.includes('\uD83D\uDCD6 Read('))).toBe(true);
    });

    it('should emit thinking.start on thinking block', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system',
          subtype: 'init',
          uuid: 'uuid-1',
          session_id: 'sess-1',
          model: 'claude-opus-4-6',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'text',
          apiKeySource: 'user',
        },
        {
          type: 'stream_event',
          uuid: 'uuid-2',
          session_id: 'sess-1',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '' },
          },
        },
        {
          type: 'stream_event',
          uuid: 'uuid-3',
          session_id: 'sess-1',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'Let me analyze this...' },
          },
        },
        {
          type: 'stream_event',
          uuid: 'uuid-4',
          session_id: 'sess-1',
          parent_tool_use_id: null,
          event: { type: 'content_block_stop', index: 0 },
        },
        {
          type: 'result',
          subtype: 'success',
          uuid: 'uuid-5',
          session_id: 'sess-1',
          duration_ms: 500,
          duration_api_ms: 400,
          is_error: false,
          num_turns: 1,
          result: 'Analysis complete',
          total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 },
          modelUsage: {},
          permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('Analyze this');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const types = onEvent.mock.calls.map((c) => c[0].type);

      expect(types).toContain('thinking.start');
      expect(types).toContain('thinking.stop');

      // Check that thinking is passed through in session.idle
      const idleCall = onEvent.mock.calls.find((c) => c[0].type === 'session.idle');
      expect(idleCall![0].thinking).toBe('Let me analyze this...');
    });
  });

  describe('formatToolActivity', () => {
    let runner: ClaudeSdkRunner;

    beforeEach(() => {
      runner = new ClaudeSdkRunner(createDeps());
    });

    it('should format Read tool', () => {
      expect(runner.formatToolActivity('Read', { file_path: '/src/index.ts' }))
        .toBe('\uD83D\uDCD6 Read(`/src/index.ts`)');
    });

    it('should format Edit tool with line delta', () => {
      const result = runner.formatToolActivity('Edit', {
        file_path: '/src/app.ts',
        old_string: 'line1\nline2',
        new_string: 'line1\nline2\nline3\nline4',
      });
      expect(result).toBe('\u270F\uFE0F Edit(`/src/app.ts`) +2 lines');
    });

    it('should format Write tool with line count', () => {
      const result = runner.formatToolActivity('Write', {
        file_path: '/src/new.ts',
        content: 'line1\nline2\nline3',
      });
      expect(result).toBe('\uD83D\uDCDD Write(`/src/new.ts`) 3 lines');
    });

    it('should format Bash tool', () => {
      const result = runner.formatToolActivity('Bash', { command: 'npm run build' });
      expect(result).toBe('\uD83D\uDCBB `npm run build`');
    });

    it('should format Grep tool', () => {
      const result = runner.formatToolActivity('Grep', { pattern: 'TODO' });
      expect(result).toBe('\uD83D\uDD0D Grep(`TODO`)');
    });

    it('should format Glob tool', () => {
      const result = runner.formatToolActivity('Glob', { pattern: '**/*.ts' });
      expect(result).toBe('\uD83D\uDCC2 Glob(`**/*.ts`)');
    });

    it('should format WebSearch tool', () => {
      const result = runner.formatToolActivity('WebSearch', { query: 'vitest docs' });
      expect(result).toBe('\uD83C\uDF10 WebSearch(`vitest docs`)');
    });

    it('should format WebFetch tool', () => {
      const result = runner.formatToolActivity('WebFetch', { url: 'https://example.com' });
      expect(result).toBe('\uD83C\uDF10 Fetch(`https://example.com`)');
    });

    it('should format Task (subagent) tool', () => {
      const result = runner.formatToolActivity('Task', { description: 'Run tests' });
      expect(result).toBe('\uD83E\uDD16 Subagent: Run tests');
    });

    it('should format unknown/MCP tools', () => {
      const result = runner.formatToolActivity('mcp__server__custom_tool', {});
      expect(result).toBe('\uD83D\uDD0C mcp__server__custom_tool');
    });

    it('should return empty for AskUserQuestion', () => {
      expect(runner.formatToolActivity('AskUserQuestion', {})).toBe('');
    });

    it('should return empty for ExitPlanMode', () => {
      expect(runner.formatToolActivity('ExitPlanMode', {})).toBe('');
    });

    it('should shorten long paths', () => {
      const result = runner.formatToolActivity('Read', {
        file_path: '/very/deep/nested/path/to/file.ts',
      });
      expect(result).toBe('\uD83D\uDCD6 Read(`.../path/to/file.ts`)');
    });

    it('should truncate long bash commands', () => {
      const longCmd = 'a'.repeat(100);
      const result = runner.formatToolActivity('Bash', { command: longCmd });
      expect(result.length).toBeLessThan(100);
      expect(result).toContain('\u2026');
    });
  });

  describe('text preview', () => {
    it('should emit text preview after PREVIEW_FIRST_THRESHOLD chars', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      // Build text deltas that exceed 100 chars
      const chunk = 'a'.repeat(110);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system', subtype: 'init', uuid: 'u1', session_id: 's1',
          model: 'claude-opus-4-6', cwd: '/tmp', tools: [], mcp_servers: [],
          permissionMode: 'bypassPermissions', slash_commands: [], output_style: 'text', apiKeySource: 'user',
        },
        {
          type: 'stream_event', uuid: 'u2', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        },
        {
          type: 'stream_event', uuid: 'u3', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
        },
        {
          type: 'stream_event', uuid: 'u4', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_stop', index: 0 },
        },
        {
          type: 'result', subtype: 'success', uuid: 'u5', session_id: 's1',
          duration_ms: 500, duration_api_ms: 400, is_error: false, num_turns: 1,
          result: 'Done', total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: {}, permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('test');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const previews = onEvent.mock.calls
        .filter((c) => c[0].type === 'tool.activity' && typeof c[0].text === 'string' && c[0].text.startsWith('\uD83D\uDCAC'))
        .map((c) => c[0].text);

      expect(previews.length).toBeGreaterThanOrEqual(1);
      expect(previews[0]).toMatch(/^\uD83D\uDCAC ".+"/);
    });

    it('should emit additional previews at PREVIEW_INTERVAL', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      // Send multiple text deltas totaling > 600 chars (first at 100, next at 600)
      const deltas = [
        'a'.repeat(110),  // triggers first preview
        'b'.repeat(500),  // triggers second preview
      ];

      const events: any[] = [
        {
          type: 'system', subtype: 'init', uuid: 'u1', session_id: 's1',
          model: 'claude-opus-4-6', cwd: '/tmp', tools: [], mcp_servers: [],
          permissionMode: 'bypassPermissions', slash_commands: [], output_style: 'text', apiKeySource: 'user',
        },
        {
          type: 'stream_event', uuid: 'u2', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        },
      ];
      deltas.forEach((text, i) => {
        events.push({
          type: 'stream_event', uuid: `u${i + 3}`, session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        });
      });
      events.push(
        {
          type: 'stream_event', uuid: 'u10', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_stop', index: 0 },
        },
        {
          type: 'result', subtype: 'success', uuid: 'u11', session_id: 's1',
          duration_ms: 500, duration_api_ms: 400, is_error: false, num_turns: 1,
          result: 'Done', total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: {}, permission_denials: [],
        },
      );

      mockQuery.mockReturnValue(asyncIter(events) as any);
      await runner.submitMessage('test');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const previews = onEvent.mock.calls
        .filter((c) => c[0].type === 'tool.activity' && typeof c[0].text === 'string' && c[0].text.startsWith('\uD83D\uDCAC'))
        .map((c) => c[0].text);

      expect(previews.length).toBe(2);
    });

    it('should not emit preview below threshold', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system', subtype: 'init', uuid: 'u1', session_id: 's1',
          model: 'claude-opus-4-6', cwd: '/tmp', tools: [], mcp_servers: [],
          permissionMode: 'bypassPermissions', slash_commands: [], output_style: 'text', apiKeySource: 'user',
        },
        {
          type: 'stream_event', uuid: 'u2', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'short' } },
        },
        {
          type: 'result', subtype: 'success', uuid: 'u3', session_id: 's1',
          duration_ms: 100, duration_api_ms: 80, is_error: false, num_turns: 1,
          result: 'Done', total_cost_usd: 0.001,
          usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {}, permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('test');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const previews = onEvent.mock.calls
        .filter((c) => c[0].type === 'tool.activity' && typeof c[0].text === 'string' && c[0].text.startsWith('\uD83D\uDCAC'));

      expect(previews.length).toBe(0);
    });
  });

  describe('intermediate text', () => {
    it('should save text before tool_use as intermediateText', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system', subtype: 'init', uuid: 'u1', session_id: 's1',
          model: 'claude-opus-4-6', cwd: '/tmp', tools: [], mcp_servers: [],
          permissionMode: 'bypassPermissions', slash_commands: [], output_style: 'text', apiKeySource: 'user',
        },
        // Text before tool call
        {
          type: 'stream_event', uuid: 'u2', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me read the file.' } },
        },
        // Tool call starts — should save prior text as intermediate
        {
          type: 'stream_event', uuid: 'u3', session_id: 's1', parent_tool_use_id: null,
          event: {
            type: 'content_block_start', index: 1,
            content_block: { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} },
          },
        },
        {
          type: 'stream_event', uuid: 'u4', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a.ts"}' } },
        },
        {
          type: 'stream_event', uuid: 'u5', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_stop', index: 1 },
        },
        {
          type: 'result', subtype: 'success', uuid: 'u6', session_id: 's1',
          duration_ms: 500, duration_api_ms: 400, is_error: false, num_turns: 1,
          result: 'Final answer', total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: {}, permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('read it');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const idleCall = onEvent.mock.calls.find((c) => c[0].type === 'session.idle');
      expect(idleCall).toBeDefined();
      expect(idleCall![0].intermediateText).toBe('Let me read the file.');
    });

    it('should accumulate multiple intermediate text parts', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system', subtype: 'init', uuid: 'u1', session_id: 's1',
          model: 'claude-opus-4-6', cwd: '/tmp', tools: [], mcp_servers: [],
          permissionMode: 'bypassPermissions', slash_commands: [], output_style: 'text', apiKeySource: 'user',
        },
        // First text block
        {
          type: 'stream_event', uuid: 'u2', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'First chunk' } },
        },
        // First tool call
        {
          type: 'stream_event', uuid: 'u3', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu-1', name: 'Read', input: {} } },
        },
        {
          type: 'stream_event', uuid: 'u4', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_stop', index: 1 },
        },
        // Second text block
        {
          type: 'stream_event', uuid: 'u5', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Second chunk' } },
        },
        // Second tool call
        {
          type: 'stream_event', uuid: 'u6', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'tu-2', name: 'Bash', input: {} } },
        },
        {
          type: 'stream_event', uuid: 'u7', session_id: 's1', parent_tool_use_id: null,
          event: { type: 'content_block_stop', index: 3 },
        },
        {
          type: 'result', subtype: 'success', uuid: 'u8', session_id: 's1',
          duration_ms: 500, duration_api_ms: 400, is_error: false, num_turns: 1,
          result: 'Final', total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: {}, permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('do stuff');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const idleCall = onEvent.mock.calls.find((c) => c[0].type === 'session.idle');
      expect(idleCall![0].intermediateText).toBe('First chunk\n\nSecond chunk');
    });
  });

  describe('concurrency and abort', () => {
    it('should reject concurrent submitMessage calls', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      let resolveBlock: () => void;
      const blocker = new Promise<void>((r) => { resolveBlock = r; });

      async function* blockingIter() {
        yield {
          type: 'system' as const, subtype: 'init' as const,
          uuid: 'u1', session_id: 's1', model: 'claude-opus-4-6', cwd: '/tmp',
          tools: [], mcp_servers: [], permissionMode: 'bypassPermissions',
          slash_commands: [], output_style: 'text', apiKeySource: 'user',
        };
        await blocker;
        yield {
          type: 'result' as const, subtype: 'success' as const,
          uuid: 'u2', session_id: 's1', duration_ms: 100, duration_api_ms: 80,
          is_error: false, num_turns: 1, result: 'ok', total_cost_usd: 0.001,
          usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: {}, permission_denials: [],
        };
      }

      mockQuery.mockReturnValue(blockingIter() as any);

      const firstPromise = runner.submitMessage('first');
      expect(runner.isRunning()).toBe(true);

      // Second call should be ignored
      await runner.submitMessage('second');

      // query should only have been called once
      expect(mockQuery).toHaveBeenCalledTimes(1);

      resolveBlock!();
      await firstPromise;
    });

    it('should not emit session.error on AbortError', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      async function* abortingIter() {
        yield {
          type: 'system' as const, subtype: 'init' as const,
          uuid: 'u1', session_id: 's1', model: 'claude-opus-4-6', cwd: '/tmp',
          tools: [], mcp_servers: [], permissionMode: 'bypassPermissions',
          slash_commands: [], output_style: 'text', apiKeySource: 'user',
        };
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }

      mockQuery.mockReturnValue(abortingIter() as any);
      await runner.submitMessage('test');

      const onEvent = deps.onEvent as ReturnType<typeof vi.fn>;
      const errorCalls = onEvent.mock.calls.filter((c) => c[0].type === 'session.error');
      expect(errorCalls.length).toBe(0);
    });
  });

  describe('multi-turn sessions', () => {
    it('should resume session with stored sessionId', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      // First message
      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'system',
          subtype: 'init',
          uuid: 'uuid-1',
          session_id: 'sess-abc',
          model: 'claude-opus-4-6',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'text',
          apiKeySource: 'user',
        },
        {
          type: 'result',
          subtype: 'success',
          uuid: 'uuid-2',
          session_id: 'sess-abc',
          duration_ms: 500,
          duration_api_ms: 400,
          is_error: false,
          num_turns: 1,
          result: 'First reply',
          total_cost_usd: 0.01,
          usage: { input_tokens: 100, output_tokens: 50 },
          modelUsage: {},
          permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('First');
      expect(runner.getSessionId()).toBe('sess-abc');

      // Second message — should use resume
      mockQuery.mockReturnValue(asyncIter([
        {
          type: 'result',
          subtype: 'success',
          uuid: 'uuid-3',
          session_id: 'sess-abc',
          duration_ms: 300,
          duration_api_ms: 200,
          is_error: false,
          num_turns: 2,
          result: 'Second reply',
          total_cost_usd: 0.005,
          usage: { input_tokens: 200, output_tokens: 100 },
          modelUsage: {},
          permission_denials: [],
        },
      ]) as any);

      await runner.submitMessage('Second');

      // Verify query was called with resume option
      const secondCall = mockQuery.mock.calls[1];
      expect(secondCall[0].prompt).toBe('Second');
      expect(secondCall[0].options?.resume).toBe('sess-abc');
    });
  });

  describe('abort', () => {
    it('should abort running query', async () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      // Create a never-ending async generator
      let resolve: () => void;
      const blocker = new Promise<void>((r) => { resolve = r; });

      async function* slowIter() {
        yield {
          type: 'system' as const,
          subtype: 'init' as const,
          uuid: 'uuid-1',
          session_id: 'sess-1',
          model: 'claude-opus-4-6',
          cwd: '/tmp',
          tools: [],
          mcp_servers: [],
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'text',
          apiKeySource: 'user',
        };
        await blocker;
      }

      mockQuery.mockReturnValue(slowIter() as any);

      const promise = runner.submitMessage('test');
      expect(runner.isRunning()).toBe(true);

      runner.abort();
      resolve!();
      await promise;

      expect(runner.isRunning()).toBe(false);
    });
  });

  describe('dispose', () => {
    it('should clear sessionId and abort', () => {
      const deps = createDeps();
      const runner = new ClaudeSdkRunner(deps);

      // Manually set internal state
      (runner as any).sessionId = 'sess-123';
      runner.dispose();

      expect(runner.getSessionId()).toBeNull();
    });
  });
});
