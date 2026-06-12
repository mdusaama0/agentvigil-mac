import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { isBlocklisted } from './session-watcher.js';

const AGENT_COMMANDS = ['claude', 'codex', 'amp'];

export interface TmuxPane {
  pane_id: string;
  pid: string;
  command: string;
  cwd: string;
}

export function isPidAlive(pid: string): boolean {
  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.toString());
    });
  });
}

export async function enumerateTmuxSessions(): Promise<TmuxPane[]> {
  try {
    const stdout = await runCommand('tmux', [
      'list-panes',
      '-a',
      '-F',
      '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}',
    ]);

    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pane_id, pid, command, cwd] = line.split('|');
        return { pane_id, pid, command, cwd };
      })
      .filter((pane) => AGENT_COMMANDS.some((agent) => pane.command.includes(agent)))
      .filter((pane) => isPidAlive(pane.pid))
      .filter((pane) => !isBlocklisted(pane.cwd));
  } catch {
    // tmux not running or not installed
    return [];
  }
}

export function findTmuxPaneForSession(cwd: string, panes: TmuxPane[]): TmuxPane | undefined {
  // Prefer the most specific match so a nested-directory session binds to its
  // own pane rather than a parent directory's (e.g. monorepo sub-packages).
  const candidates = panes.filter((pane) => pane.cwd === cwd || cwd.startsWith(`${pane.cwd}/`));
  return candidates.sort((a, b) => b.cwd.length - a.cwd.length)[0];
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export async function sendMacNotification(title: string, message: string): Promise<void> {
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)} sound name "Funk"`;
  try {
    await runCommand('osascript', ['-e', script]);
  } catch (err) {
    logger.warn('Failed to display Mac notification', err);
  }
}

