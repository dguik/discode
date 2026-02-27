import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { verifyBridgeScriptIntegrity } from '../../src/container/mcp-bridge-injector.js';

describe('verifyBridgeScriptIntegrity', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bridge-integrity-'));
  });

  it('returns true when no sidecar file exists', () => {
    const scriptPath = join(tmpDir, 'bridge.cjs');
    writeFileSync(scriptPath, 'console.log("hello")');
    expect(verifyBridgeScriptIntegrity(scriptPath)).toBe(true);
  });

  it('returns true when hash matches', () => {
    const scriptPath = join(tmpDir, 'bridge.cjs');
    const content = 'console.log("hello")';
    writeFileSync(scriptPath, content);

    const hash = createHash('sha256').update(Buffer.from(content)).digest('hex');
    writeFileSync(scriptPath + '.sha256', hash);

    expect(verifyBridgeScriptIntegrity(scriptPath)).toBe(true);
  });

  it('returns false when hash does not match', () => {
    const scriptPath = join(tmpDir, 'bridge.cjs');
    writeFileSync(scriptPath, 'console.log("hello")');
    writeFileSync(scriptPath + '.sha256', 'badhash1234');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(verifyBridgeScriptIntegrity(scriptPath)).toBe(false);
    warnSpy.mockRestore();
  });

  it('returns true when sidecar hash has trailing whitespace', () => {
    const scriptPath = join(tmpDir, 'bridge.cjs');
    const content = 'some script content';
    writeFileSync(scriptPath, content);

    const hash = createHash('sha256').update(Buffer.from(content)).digest('hex');
    writeFileSync(scriptPath + '.sha256', hash + '\n');

    expect(verifyBridgeScriptIntegrity(scriptPath)).toBe(true);
  });
});
