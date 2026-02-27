/**
 * Log sanitization utilities.
 *
 * Prevents sensitive information (tokens, message content, home directory paths)
 * from leaking into console output.
 */

import { homedir } from 'os';

const homeDir = homedir();

/** Token-like prefixes that should be masked in log output. */
const TOKEN_PREFIXES = ['xoxb-', 'xoxp-', 'xoxa-', 'xoxr-', 'xoxs-', 'Bot ', 'Bearer '];

/**
 * Truncate a message content string for safe logging.
 * Returns the first `maxLen` characters followed by "..." if truncated.
 */
export function truncateContent(text: string, maxLen = 50): string {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + '...';
}

/**
 * Mask a token-like string, preserving only the prefix.
 * E.g. "xoxb-1234-abcdef" -> "xoxb-***"
 */
export function maskToken(value: string): string {
  for (const prefix of TOKEN_PREFIXES) {
    if (value.startsWith(prefix)) {
      return prefix + '***';
    }
  }
  return value;
}

/**
 * Replace the user's home directory path with `~` in a string.
 */
export function sanitizePath(text: string): string {
  if (!homeDir) return text;
  // Replace all occurrences — handles paths appearing multiple times
  return text.replaceAll(homeDir, '~');
}

/**
 * Apply all sanitization to a log message string:
 * - Replace home directory with ~
 */
export function sanitizeForLog(message: string): string {
  return sanitizePath(message);
}
