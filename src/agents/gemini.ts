/**
 * Gemini CLI agent adapter
 */

import { BaseAgentAdapter, type AgentConfig } from './base.js';

const geminiConfig: AgentConfig = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  command: 'gemini',
  channelSuffix: 'gemini',
};

export class GeminiAdapter extends BaseAgentAdapter {
  constructor() {
    super(geminiConfig);
  }
}

export const geminiAdapter = new GeminiAdapter();
