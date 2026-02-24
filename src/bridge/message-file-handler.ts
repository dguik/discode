/**
 * File attachment processing — download, container injection, marker building.
 * Isolated from message-router so text changes don't affect file handling.
 */

import type { MessageAttachment } from '../types/index.js';
import { downloadFileAttachments, buildFileMarkers } from '../infra/file-downloader.js';
import { injectFile, WORKSPACE_DIR } from '../container/index.js';

export interface FileHandlerInstance {
  containerMode?: boolean;
  containerId?: string;
}

/**
 * Process file attachments: download, inject into containers if needed, build markers.
 * Returns the marker string to append to the message content.
 */
export async function processAttachments(
  attachments: MessageAttachment[],
  projectPath: string,
  instance: FileHandlerInstance,
  logTag: string,
): Promise<string> {
  if (attachments.length === 0) return '';

  try {
    const downloaded = await downloadFileAttachments(attachments, projectPath, attachments[0]?.authHeaders);
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
