/**
 * Tests for message-file-handler — file attachment processing isolated from routing.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../src/infra/file-downloader.js', () => ({
  downloadFileAttachments: vi.fn(),
  buildFileMarkers: vi.fn(),
}));

vi.mock('../../src/container/index.js', () => ({
  injectFile: vi.fn(),
  WORKSPACE_DIR: '/workspace',
}));

import { processAttachments } from '../../src/bridge/message-file-handler.js';
import { downloadFileAttachments, buildFileMarkers } from '../../src/infra/file-downloader.js';
import { injectFile } from '../../src/container/index.js';

describe('processAttachments', () => {
  beforeEach(() => {
    (downloadFileAttachments as any).mockReset();
    (buildFileMarkers as any).mockReset();
    (injectFile as any).mockReset();
  });

  it('returns empty string for empty attachments', async () => {
    const result = await processAttachments([], '/project', {}, 'test/log');
    expect(result).toBe('');
  });

  it('downloads files and returns markers', async () => {
    (downloadFileAttachments as any).mockResolvedValue({
      downloaded: [{ localPath: '/tmp/file.txt', filename: 'file.txt' }],
      skipped: [],
    });
    (buildFileMarkers as any).mockReturnValue('\n[file: /tmp/file.txt]');

    const attachments = [
      { url: 'https://example.com/file.txt', filename: 'file.txt', contentType: 'text/plain', size: 100 },
    ];
    const result = await processAttachments(attachments, '/project', {}, 'test/log');

    expect(result).toBe('\n[file: /tmp/file.txt]');
    expect(downloadFileAttachments).toHaveBeenCalledOnce();
  });

  it('injects files into container when containerMode is true', async () => {
    (downloadFileAttachments as any).mockResolvedValue({
      downloaded: [{ localPath: '/tmp/file.txt', filename: 'file.txt' }],
      skipped: [],
    });
    (buildFileMarkers as any).mockReturnValue('\n[file: /tmp/file.txt]');

    const attachments = [
      { url: 'https://example.com/file.txt', filename: 'file.txt', contentType: 'text/plain', size: 100 },
    ];
    await processAttachments(attachments, '/project', { containerMode: true, containerId: 'abc123' }, 'test/log');

    expect(injectFile).toHaveBeenCalledWith('abc123', '/tmp/file.txt', '/workspace/.discode/files');
  });

  it('does not inject files when not in container mode', async () => {
    (downloadFileAttachments as any).mockResolvedValue({
      downloaded: [{ localPath: '/tmp/file.txt', filename: 'file.txt' }],
      skipped: [],
    });
    (buildFileMarkers as any).mockReturnValue('\n[file: /tmp/file.txt]');

    const attachments = [
      { url: 'https://example.com/file.txt', filename: 'file.txt', contentType: 'text/plain', size: 100 },
    ];
    await processAttachments(attachments, '/project', {}, 'test/log');

    expect(injectFile).not.toHaveBeenCalled();
  });

  it('returns empty string when download fails', async () => {
    (downloadFileAttachments as any).mockRejectedValue(new Error('download failed'));

    const attachments = [
      { url: 'https://example.com/file.txt', filename: 'file.txt', contentType: 'text/plain', size: 100 },
    ];
    const result = await processAttachments(attachments, '/project', {}, 'test/log');

    expect(result).toBe('');
  });

  it('returns empty string when no files downloaded', async () => {
    (downloadFileAttachments as any).mockResolvedValue({ downloaded: [], skipped: [] });

    const attachments = [
      { url: 'https://example.com/file.txt', filename: 'file.txt', contentType: 'text/plain', size: 100 },
    ];
    const result = await processAttachments(attachments, '/project', {}, 'test/log');

    expect(result).toBe('');
  });
});
