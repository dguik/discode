import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GEMINI_AFTER_AGENT_HOOK_FILENAME,
  GEMINI_HOOK_NAME,
  getGeminiHookSourcePath,
  installGeminiHook,
  removeGeminiHook,
} from '../../src/gemini/hook-installer.js';

describe('gemini hook installer', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'discode-gemini-hook-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('source hook file exists', () => {
    expect(existsSync(getGeminiHookSourcePath())).toBe(true);
  });

  it('installGeminiHook copies hook and updates settings.json', () => {
    const hookPath = installGeminiHook(undefined, tempDir);
    const settingsPath = join(tempDir, 'settings.json');

    expect(hookPath).toBe(join(tempDir, 'discode-hooks', GEMINI_AFTER_AGENT_HOOK_FILENAME));
    expect(existsSync(hookPath)).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);

    const mode = statSync(hookPath).mode & 0o755;
    expect(mode).toBe(0o755);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ matcher?: string; hooks?: Array<{ name?: string; command?: string }> }>;
      };
    };

    const groups = settings.hooks?.AfterAgent || [];
    const wildcardGroup = groups.find((group) => group.matcher === '*' || group.matcher === '');
    expect(wildcardGroup).toBeDefined();
    expect(wildcardGroup?.hooks).toContainEqual(
      expect.objectContaining({
        name: GEMINI_HOOK_NAME,
        type: 'command',
        command: `'${hookPath}'`,
      })
    );
  });

  it('installGeminiHook is idempotent for settings hook entry', () => {
    const firstPath = installGeminiHook(undefined, tempDir);
    const secondPath = installGeminiHook(undefined, tempDir);
    expect(secondPath).toBe(firstPath);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ hooks?: Array<{ name?: string }> }>;
      };
    };

    const entries = (settings.hooks?.AfterAgent || [])
      .flatMap((group) => group.hooks || [])
      .filter((hook) => hook.name === GEMINI_HOOK_NAME);
    expect(entries).toHaveLength(1);
  });

  describe('compiled binary resource resolution', () => {
    let originalExecPath: string;

    beforeEach(() => {
      originalExecPath = process.execPath;
    });

    afterEach(() => {
      process.execPath = originalExecPath;
    });

    it('resolves hook source from process.execPath-based resources path', () => {
      // Simulate compiled binary layout: bin/discode + resources/gemini-hook/
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'gemini-hook');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getGeminiHookSourcePath(), join(resourcesDir, GEMINI_AFTER_AGENT_HOOK_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const candidate = join(dirname(process.execPath), '..', 'resources', 'gemini-hook', GEMINI_AFTER_AGENT_HOOK_FILENAME);
      expect(existsSync(candidate)).toBe(true);

      const content = readFileSync(candidate, 'utf-8');
      expect(content).toContain('/opencode-event');
    });

    it('installGeminiHook works from binary resources layout', () => {
      const binaryRoot = join(tempDir, 'binary-root');
      const binDir = join(binaryRoot, 'bin');
      const resourcesDir = join(binaryRoot, 'resources', 'gemini-hook');
      const targetDir = join(tempDir, 'gemini-config');

      mkdirSync(binDir, { recursive: true });
      mkdirSync(resourcesDir, { recursive: true });
      copyFileSync(getGeminiHookSourcePath(), join(resourcesDir, GEMINI_AFTER_AGENT_HOOK_FILENAME));
      writeFileSync(join(binDir, 'discode'), '');

      process.execPath = join(binDir, 'discode');

      const hookPath = installGeminiHook(undefined, targetDir);
      expect(existsSync(hookPath)).toBe(true);

      const mode = statSync(hookPath).mode & 0o755;
      expect(mode).toBe(0o755);

      const settingsPath = join(targetDir, 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
    });
  });

  it('removeGeminiHook removes hook file and settings entry', () => {
    const hookPath = installGeminiHook(undefined, tempDir);
    const removed = removeGeminiHook(tempDir);

    expect(removed).toBe(true);
    expect(existsSync(hookPath)).toBe(false);

    const settingsPath = join(tempDir, 'settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
      hooks?: {
        AfterAgent?: Array<{ hooks?: Array<{ name?: string }> }>;
      };
    };

    const hasHook = (settings.hooks?.AfterAgent || [])
      .flatMap((group) => group.hooks || [])
      .some((hook) => hook.name === GEMINI_HOOK_NAME);
    expect(hasHook).toBe(false);
  });
});
