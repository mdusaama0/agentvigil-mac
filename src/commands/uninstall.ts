import { logger } from '../utils/logger.js';
import { unregisterHooks } from '../hooks/hook-manager.js';

/**
 * Removes all AgentVigil hook entries from ~/.claude/settings.json.
 * Only removes commands registered by AgentVigil — all other hooks
 * (including other tools' hooks) are left completely untouched.
 */
export async function runUninstall(): Promise<void> {
  logger.info('Removing AgentVigil hooks from ~/.claude/settings.json...');
  await unregisterHooks();
  logger.info('Verify with: cat ~/.claude/settings.json | grep -i agentvigil');
}
