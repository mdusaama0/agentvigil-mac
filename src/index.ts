#!/usr/bin/env node
import { Command } from 'commander';
import { logger } from './utils/logger.js';

const program = new Command();

program
  .name('agentvigil')
  .description('Fleet watchdog for AI coding agent sessions')
  .version('1.0.0');

program
  .command('setup')
  .description('First-time setup: register hooks, generate keys, show QR code')
  .option('--dry-run', 'Show what would happen without making changes')
  .action(async (opts) => {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup(opts);
  });

program
  .command('start')
  .description('Start the AgentVigil daemon (tunnel + WebSocket server)')
  .action(async () => {
    const { runStart } = await import('./commands/start.js');
    await runStart();
  });

program
  .command('hook <type>')
  .description('Handle a Claude Code hook event (called by hooks, not by user)')
  .action(async (type: string) => {
    const { handleHook } = await import('./hooks/hook-handler.js');
    await handleHook(type);
  });

program
  .command('status')
  .description('Show current session states')
  .action(async () => {
    logger.info('TODO: implement status command');
  });

program
  .command('unpair')
  .description('Revoke all device pairings')
  .action(async () => {
    logger.info('TODO: implement unpair command');
  });

program
  .command('logs')
  .description('Tail the AgentVigil log file')
  .action(async () => {
    logger.info('TODO: implement logs command');
  });

program
  .command('uninstall')
  .description('Remove AgentVigil hooks from ~/.claude/settings.json')
  .action(async () => {
    const { runUninstall } = await import('./commands/uninstall.js');
    await runUninstall();
  });

program.parse();
