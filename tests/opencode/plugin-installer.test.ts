import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import ts from 'typescript';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  OPENCODE_PLUGIN_FILENAME,
  getPluginSourcePath,
  installOpencodePlugin,
} from '../../src/opencode/plugin-installer.js';

type FetchCall = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

function createPluginHarness() {
  const source = readFileSync(getPluginSourcePath(), 'utf-8').replace(
    'export const AgentDiscordBridgePlugin',
    'const AgentDiscordBridgePlugin'
  );
  const transpiledSource = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
  const calls: FetchCall[] = [];

  const fetchMock = async (url: string, init: any) => {
    calls.push({ url, init: init || {} });
    return { ok: true };
  };

  const buildPlugin = new Function(
    'fetch',
    'process',
    `${transpiledSource}\nreturn AgentDiscordBridgePlugin;`
  ) as (fetch: typeof fetchMock, process: { env: Record<string, string> }) => () => Promise<any>;

  const processStub = {
    env: {
      AGENT_DISCORD_PROJECT: 'demo-project',
      AGENT_DISCORD_PORT: '18470',
    },
  };

  return {
    calls,
    create: async () => {
      const pluginFactory = buildPlugin(fetchMock, processStub);
      return pluginFactory();
    },
  };
}

function parseBody(call: FetchCall): Record<string, unknown> {
  return JSON.parse(call.init.body || '{}') as Record<string, unknown>;
}

describe('opencode plugin installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-opencode-plugin-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('source plugin file exists', () => {
    expect(existsSync(getPluginSourcePath())).toBe(true);
  });

  it('installOpencodePlugin copies file to target directory', () => {
    const result = installOpencodePlugin(undefined, tempDir);
    expect(result).toBe(join(tempDir, OPENCODE_PLUGIN_FILENAME));
    expect(existsSync(result)).toBe(true);

    const content = readFileSync(result, 'utf-8');
    expect(content).toContain('AgentDiscordBridgePlugin');
    expect(content).toContain('/opencode-event');
  });

  it('posts final assistant text on session.idle from message parts', async () => {
    const harness = createPluginHarness();
    const plugin = await harness.create();

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'assistant-msg-1', role: 'assistant' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            type: 'text',
            messageID: 'assistant-msg-1',
            text: '결과 본문',
          },
        },
      },
    });

    await plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'session-1' },
      },
    });

    expect(harness.calls).toHaveLength(1);
    const payload = parseBody(harness.calls[0]);
    expect(payload.type).toBe('session.idle');
    expect(payload.text).toBe('결과 본문');
    expect(payload.projectName).toBe('demo-project');
    expect(payload.agentType).toBe('opencode');
  });

  describe('compiled binary resource resolution', () => {
    let originalExecPath: string;

    beforeEach(() => {
      originalExecPath = process.execPath;
    });

    afterEach(() => {
      process.execPath = originalExecPath;
    });

    it('resolves plugin source from process.execPath-based resources path', () => {
      // Simulate compiled binary layout: bin/discode + resources/opencode-plugin/
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'opencode-plugin');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getPluginSourcePath(), join(resourcesDir, OPENCODE_PLUGIN_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const candidate = join(dirname(process.execPath), '..', 'resources', 'opencode-plugin', OPENCODE_PLUGIN_FILENAME);
      expect(existsSync(candidate)).toBe(true);

      const content = readFileSync(candidate, 'utf-8');
      expect(content).toContain('AgentDiscordBridgePlugin');
    });

    it('installOpencodePlugin works from binary resources layout', () => {
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'opencode-plugin');
      const targetDir = join(tempDir, 'installed-plugin');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getPluginSourcePath(), join(resourcesDir, OPENCODE_PLUGIN_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const result = installOpencodePlugin(undefined, targetDir);
      expect(existsSync(result)).toBe(true);

      const content = readFileSync(result, 'utf-8');
      expect(content).toContain('AgentDiscordBridgePlugin');
    });
  });

  it('builds assistant text from delta updates when part text is empty', async () => {
    const harness = createPluginHarness();
    const plugin = await harness.create();

    await plugin.event({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'assistant-msg-2', role: 'assistant' } },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            type: 'text',
            messageID: 'assistant-msg-2',
            text: '',
          },
          delta: 'hello ',
        },
      },
    });
    await plugin.event({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-2',
            type: 'text',
            messageID: 'assistant-msg-2',
            text: '',
          },
          delta: 'world',
        },
      },
    });

    await plugin.event({
      event: {
        type: 'session.idle',
        properties: { sessionID: 'session-2' },
      },
    });

    expect(harness.calls).toHaveLength(1);
    const payload = parseBody(harness.calls[0]);
    expect(payload.type).toBe('session.idle');
    expect(payload.text).toBe('hello world');
  });
});
