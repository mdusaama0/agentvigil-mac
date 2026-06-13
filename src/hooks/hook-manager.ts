import { fileURLToPath } from 'url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';

// ── Absolute-path hook command ─────────────────────────────────────────────
// Claude Code fires hooks in a restricted shell where the npm global bin
// directory is NOT in PATH, so bare `agentvigil hook <type>` silently fails.
// Using process.execPath + the absolute path to dist/index.js works on any
// machine regardless of how Node or the package were installed.

const __filename = fileURLToPath(import.meta.url);
// dist/hooks/hook-manager.js → go up one level to reach dist/
const distDir    = path.dirname(path.dirname(__filename));
const entryPoint = path.join(distDir, 'index.js');
const nodeExecutable = process.execPath;

/** Builds the shell command for a given hook type with full absolute paths. */
export const buildHookCommand = (type: string): string =>
  `${nodeExecutable} ${entryPoint} hook ${type}`;

// ── Settings path ──────────────────────────────────────────────────────────
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/** Marker present in every OLD-style bare command (pre-absolute-path fix). */
const LEGACY_MARKER = 'agentvigil hook';

/**
 * Matches `<node> <any-path>/agentvigil[-mac]/dist/index.js hook <type>` —
 * i.e. ANY AgentVigil installation (global npm, local dev checkout, npx
 * cache, etc.), not just the one currently running `setup`. Without this,
 * running `setup` from a different install path than last time leaves the
 * previous install's entry behind instead of replacing it, and Claude Code
 * ends up firing every registered copy for a single event.
 */
const ANY_INSTALL_PATTERN = /[/\\]agentvigil(?:-mac)?[/\\]dist[/\\]index\.js hook /;

/** Returns true when a command was registered by AgentVigil (old or new, any install). */
const isOurCommand = (cmd: string): boolean =>
  cmd.includes(entryPoint) || cmd.includes(LEGACY_MARKER) || ANY_INSTALL_PATTERN.test(cmd);

// ── Types ──────────────────────────────────────────────────────────────────

interface HookCommand {
  type: 'command';
  command: string;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

type HookConfig = Record<string, HookEntry[]>;

interface ClaudeSettings {
  hooks?: HookConfig;
  [key: string]: unknown;
}

// ── Hook config builder ────────────────────────────────────────────────────

export function buildHookConfig(): HookConfig {
  return {
    Notification: [
      {
        matcher: 'permission_prompt',
        hooks: [{ type: 'command', command: buildHookCommand('permission_prompt') }],
      },
      {
        matcher: 'idle_prompt',
        hooks: [{ type: 'command', command: buildHookCommand('idle_prompt') }],
      },
    ],
    Stop: [
      { hooks: [{ type: 'command', command: buildHookCommand('stop') }] },
    ],
    SubagentStop: [
      { hooks: [{ type: 'command', command: buildHookCommand('subagent_stop') }] },
    ],
  };
}

// ── Merge ──────────────────────────────────────────────────────────────────

/**
 * Merge our hook config into the existing one without dropping or duplicating
 * anything. An entry is considered "ours already" when an existing entry with
 * the same matcher already runs a command that looks like one of ours.
 */
export function mergeHooks(existing: HookConfig, ours: HookConfig): HookConfig {
  const merged: HookConfig = {};

  for (const [event, entries] of Object.entries(existing)) {
    merged[event] = [...entries];
  }

  for (const [event, ourEntries] of Object.entries(ours)) {
    const entries = merged[event] ?? (merged[event] = []);

    for (const ourEntry of ourEntries) {
      // Strip any old/new variant of our command before adding the fresh one,
      // so re-running setup upgrades bare commands to absolute-path commands.
      for (const existingEntry of entries) {
        if (existingEntry.matcher === ourEntry.matcher) {
          existingEntry.hooks = existingEntry.hooks.filter((h) => !isOurCommand(h.command));
        }
      }

      // Remove ALL entries that are now empty after stripping our old
      // commands — multiple AgentVigil installations can each have left
      // their own same-matcher entry behind, not just one.
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].matcher === ourEntry.matcher && entries[i].hooks.length === 0) {
          entries.splice(i, 1);
        }
      }

      // Add the fresh entry (always — we removed any pre-existing one above).
      entries.push(ourEntry);
    }
  }

  return merged;
}

// ── File helpers ───────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readSettings(): Promise<ClaudeSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    logger.warn('~/.claude/settings.json is malformed — backing it up and starting fresh');
    await fs.copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.bak`).catch(() => {});
    return {};
  }
}

async function writeSettings(settings: ClaudeSettings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  if (await fileExists(SETTINGS_PATH)) {
    await fs.copyFile(SETTINGS_PATH, `${SETTINGS_PATH}.bak`);
  }
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function registerHooks(): Promise<void> {
  const existing = await readSettings();
  existing.hooks = mergeHooks(existing.hooks ?? {}, buildHookConfig());
  await writeSettings(existing);
  logger.success('Hooks registered in ~/.claude/settings.json');
}

export async function unregisterHooks(): Promise<void> {
  const existing = await readSettings();
  if (!existing.hooks) return;

  const cleaned: HookConfig = {};
  for (const [event, entries] of Object.entries(existing.hooks)) {
    const keptEntries = entries
      .map((entry) => ({
        ...entry,
        hooks: entry.hooks.filter((h) => !isOurCommand(h.command)),
      }))
      .filter((entry) => entry.hooks.length > 0);

    if (keptEntries.length > 0) {
      cleaned[event] = keptEntries;
    }
  }

  existing.hooks = cleaned;
  await writeSettings(existing);
  logger.success('Hooks removed from ~/.claude/settings.json');
}
