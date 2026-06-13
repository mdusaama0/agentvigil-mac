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
  .description('First-time setup: register hooks and pair with mobile app')
  .option('--dry-run', 'Show what would happen without making changes')
  .action(async (opts) => {
    const { runSetup } = await import('./commands/setup.js');
    await runSetup(opts);
  });

program
  .command('start')
  .description('Start the AgentVigil daemon')
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
  .description('Show all active agent sessions')
  .action(async () => {
    logger.info('TODO: implement status command');
  });

program
  .command('unpair')
  .description('Revoke mobile app pairing')
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
  .description('Remove AgentVigil hooks from Claude Code and Codex')
  .action(async () => {
    const { runUninstall } = await import('./commands/uninstall.js');
    await runUninstall();
  });

program
  .command('install-autostart')
  .description('Start AgentVigil automatically on login')
  .action(async () => {
    const { runInstallAutostart } = await import('./commands/autostart.js');
    await runInstallAutostart();
  });

program
  .command('uninstall-autostart')
  .description('Remove autostart')
  .action(async () => {
    const { runUninstallAutostart } = await import('./commands/autostart.js');
    await runUninstallAutostart();
  });

// `npx agentvigil` with no arguments — show a welcome message pointing at
// `setup`/`start` instead of commander's default help-and-exit-1 behavior.
program.action(() => {
  console.log('');
  console.log('  AgentVigil v1.0.0');
  console.log('  Fleet watchdog for AI coding agent sessions');
  console.log('');
  console.log('  Getting started:');
  console.log('    npx agentvigil setup    ← run this first');
  console.log('    npx agentvigil start    ← then run this');
  console.log('');
  console.log('  Supported agents: Claude Code, Codex CLI');
  console.log('  Requires: Node.js 18+, macOS');
  console.log('  Docs: https://agentvigil.app');
  console.log('');
  program.help();
});

program.parse();
