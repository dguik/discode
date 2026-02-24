// Re-export from canonical location for backward compatibility
export {
  GEMINI_HOOK_NAME,
  GEMINI_AFTER_AGENT_HOOK_FILENAME,
  GEMINI_NOTIFICATION_HOOK_FILENAME,
  GEMINI_SESSION_HOOK_FILENAME,
  GEMINI_NOTIFICATION_HOOK_NAME,
  GEMINI_SESSION_HOOK_NAME,
  getGeminiConfigDir,
  getGeminiHookDir,
  getGeminiSettingsPath,
  getGeminiHookSourcePath,
  installGeminiHook,
  removeGeminiHook,
} from '../agents/gemini/hook-installer.js';
