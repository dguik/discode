/**
 * File attachment processing — download, container injection, marker building.
 * Isolated from message-router so text changes don't affect file handling.
 */

import type { MessageAttachment } from '../types/index.js';
import type { MessagingClient } from '../messaging/interface.js';
import { downloadFileAttachments, buildFileMarkers } from '../infra/file-downloader.js';
import { injectFile, WORKSPACE_DIR } from '../container/index.js';

export interface FileHandlerInstance {
  containerMode?: boolean;
  containerId?: string;
}

/**
 * Process file attachments: download, inject into containers if needed, build markers.
 * Returns the marker string to append to the message content.
 * Optionally sends skip feedback to the channel if messaging client is provided.
 */
export async function processAttachments(
  attachments: MessageAttachment[],
  projectPath: string,
  instance: FileHandlerInstance,
  logTag: string,
  messaging?: MessagingClient,
  channelId?: string,
): Promise<string> {
  if (attachments.length === 0) return '';

  try {
    const { downloaded, skipped } = await downloadFileAttachments(attachments, projectPath, attachments[0]?.authHeaders);

    if (skipped.length > 0 && messaging && channelId) {
      const lines = skipped.map((s) => `\u2022 \`${s.filename}\`: ${s.reason}`);
      messaging.sendToChannel(channelId, `\u26A0\uFE0F Skipped file(s):\n${lines.join('\n')}`).catch(() => {});
    }

    if (downloaded.length === 0) return '';

    // If the instance runs in a container, inject files into it
    if (instance.containerMode && instance.containerId) {
      const containerFilesDir = `${WORKSPACE_DIR}/.discode/files`;
      for (const file of downloaded) {
        injectFile(instance.containerId, file.localPath, containerFilesDir);
      }
    }

    const markers = buildFileMarkers(downloaded);
    console.log(`📎 [${logTag}] ${downloaded.length} file(s) attached`);
    return markers;
  } catch (error) {
    console.warn('Failed to process file attachments:', error);
    return '';
  }
}
