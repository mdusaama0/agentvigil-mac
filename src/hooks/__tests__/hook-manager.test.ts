import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `/tmp/agentvigil-hook-manager-test-${process.pid}-${Date.now()}`,
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => TEST_HOME },
    homedir: () => TEST_HOME,
  };
});

const { registerHooks, unregisterHooks, mergeHooks, buildHookConfig, buildHookCommand } =
  await import('../hook-manager.js');

const SETTINGS_PATH = path.join(TEST_HOME, '.claude', 'settings.json');

async function readSettingsFile(): Promise<any> {
  return JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
}

async function writeSettingsFile(settings: unknown): Promise<void> {
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

beforeEach(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_HOME, '.claude'), { recursive: true });
});

afterAll(async () => {
  await fs.rm(TEST_HOME, { recursive: true, force: true });
});

// ── buildHookCommand / buildHookConfig — absolute path assertions ──────────

describe('buildHookCommand', () => {
  it('contains process.execPath so it works in Claude Code restricted shells', () => {
    const cmd = buildHookCommand('permission_prompt');
    expect(cmd).toContain(process.execPath);
  });

  it('contains an absolute path ending in "index.js"', () => {
    const cmd = buildHookCommand('permission_prompt');
    // Extract the path between the node executable and "hook"
    const parts = cmd.split(' ');
    const indexJsPath = parts[1]; // second token is the script path
    expect(path.isAbsolute(indexJsPath)).toBe(true);
    expect(indexJsPath.endsWith('index.js')).toBe(true);
  });

  it('does NOT use the bare "agentvigil" binary as the command', () => {
    const cmd = buildHookCommand('permission_prompt');
    // Must not start with "agentvigil" — that only works when npm global bin is in PATH
    expect(cmd.startsWith('agentvigil')).toBe(false);
    expect(cmd.trimStart().startsWith('agentvigil')).toBe(false);
  });
});

// ── mergeHooks ────────────────────────────────────────────────────────────

describe('mergeHooks', () => {
  it('preserves existing user hooks without adding its own PreToolUse', () => {
    const existing = { PreToolUse: [{ hooks: [{ type: 'command' as const, command: 'echo hello' }] }] };
    const merged = mergeHooks(existing, buildHookConfig());

    // The user's PreToolUse hook is preserved; we do NOT add our own
    const allCmds = merged.PreToolUse!.flatMap((e) => e.hooks.map((h) => h.command));
    expect(allCmds).toContain('echo hello');
    expect(allCmds.some((c) => c.includes('pre_tool_use'))).toBe(false);
    expect(merged.Notification).toBeDefined();
    expect(merged.Stop).toBeDefined();
    expect(merged.SubagentStop).toBeDefined();
  });

  it('preserves an existing Notification entry with a different matcher', () => {
    const existing = {
      Notification: [
        { matcher: 'custom_matcher', hooks: [{ type: 'command' as const, command: 'my-other-tool notify' }] },
      ],
    };
    const merged = mergeHooks(existing, buildHookConfig());

    expect(merged.Notification).toHaveLength(3);
    expect(merged.Notification!.some((e) => e.matcher === 'custom_matcher')).toBe(true);
    expect(merged.Notification!.some((e) => e.matcher === 'permission_prompt')).toBe(true);
    expect(merged.Notification!.some((e) => e.matcher === 'idle_prompt')).toBe(true);
  });

  it('is idempotent — merging our config in twice does not duplicate entries', () => {
    const ours = buildHookConfig();
    const once  = mergeHooks({}, ours);
    const twice = mergeHooks(once, ours);

    expect(twice.Notification).toHaveLength(once.Notification!.length);
    expect(twice.Stop).toHaveLength(once.Stop!.length);
    expect(twice.SubagentStop).toHaveLength(once.SubagentStop!.length);
  });

  it('upgrades an old bare-command entry to the absolute-path version', () => {
    const oldFormat = {
      Stop: [{ hooks: [{ type: 'command' as const, command: 'agentvigil hook stop' }] }],
    };
    const merged = mergeHooks(oldFormat, buildHookConfig());

    const stopCmds = merged.Stop!.flatMap((e) => e.hooks.map((h) => h.command));
    // Exactly one Stop command — the old bare one was replaced
    expect(stopCmds).toHaveLength(1);
    expect(stopCmds[0]).toContain(process.execPath);
    expect(stopCmds[0]).not.toBe('agentvigil hook stop');
  });

  it('replaces hooks registered by a different AgentVigil installation instead of stacking', () => {
    // Simulates re-running `setup` from a different install (global npm vs.
    // a local dev checkout vs. an npx cache) — each computes its own
    // absolute entryPoint, so a naive exact-path check would leave the old
    // install's entries in place and Claude Code would fire every copy.
    const existing = {
      Notification: [
        {
          matcher: 'permission_prompt',
          hooks: [{ type: 'command' as const, command: '/usr/bin/node /opt/homebrew/lib/node_modules/agentvigil/dist/index.js hook permission_prompt' }],
        },
        {
          matcher: 'idle_prompt',
          hooks: [{ type: 'command' as const, command: '/usr/bin/node /opt/homebrew/lib/node_modules/agentvigil/dist/index.js hook idle_prompt' }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command' as const, command: '/usr/bin/node /Users/x/.npm/_npx/abc123/node_modules/agentvigil/dist/index.js hook stop' }] }],
    };
    const merged = mergeHooks(existing, buildHookConfig());

    for (const matcher of ['permission_prompt', 'idle_prompt']) {
      const entries = merged.Notification!.filter((e) => e.matcher === matcher);
      expect(entries).toHaveLength(1);
      expect(entries[0].hooks).toHaveLength(1);
      expect(entries[0].hooks[0].command).toContain(process.execPath);
      expect(entries[0].hooks[0].command).not.toContain('/opt/homebrew/lib/node_modules/agentvigil');
    }

    expect(merged.Stop).toHaveLength(1);
    expect(merged.Stop![0].hooks).toHaveLength(1);
    expect(merged.Stop![0].hooks[0].command).not.toContain('_npx');
  });

  it('collapses many duplicate same-matcher entries (one per install) down to one', () => {
    // Reproduces the real-world settings.json after repeated `setup` runs
    // from 5 different AgentVigil installs — each run added its own
    // permission_prompt/idle_prompt entry without removing the others'.
    const installPaths = [
      '/Users/x/agentvigil-mac/dist/index.js',
      '/Users/x/node_modules/agentvigil/dist/index.js',
      '/Users/x/.npm/_npx/aaa/node_modules/agentvigil/dist/index.js',
      '/Users/x/.npm/_npx/bbb/node_modules/agentvigil/dist/index.js',
      '/opt/homebrew/lib/node_modules/agentvigil/dist/index.js',
    ];
    const existing = {
      Notification: installPaths.flatMap((p) => [
        { matcher: 'permission_prompt', hooks: [{ type: 'command' as const, command: `/usr/bin/node ${p} hook permission_prompt` }] },
        { matcher: 'idle_prompt', hooks: [{ type: 'command' as const, command: `/usr/bin/node ${p} hook idle_prompt` }] },
      ]),
      Stop: installPaths.map((p) => ({ hooks: [{ type: 'command' as const, command: `/usr/bin/node ${p} hook stop` }] })),
      SubagentStop: installPaths.map((p) => ({ hooks: [{ type: 'command' as const, command: `/usr/bin/node ${p} hook subagent_stop` }] })),
    };

    const merged = mergeHooks(existing, buildHookConfig());

    expect(merged.Notification!.filter((e) => e.matcher === 'permission_prompt')).toHaveLength(1);
    expect(merged.Notification!.filter((e) => e.matcher === 'idle_prompt')).toHaveLength(1);
    expect(merged.Stop).toHaveLength(1);
    expect(merged.SubagentStop).toHaveLength(1);
  });
});

// ── registerHooks ─────────────────────────────────────────────────────────

describe('registerHooks', () => {
  it('creates settings.json with absolute-path hook commands', async () => {
    await registerHooks();
    const settings = await readSettingsFile();
    const serialized = JSON.stringify(settings.hooks);

    // All hook commands must contain the running node executable
    expect(serialized).toContain(process.execPath);
    // Must contain the hook type suffixes
    expect(serialized).toContain('hook permission_prompt');
    expect(serialized).toContain('hook idle_prompt');
    expect(serialized).toContain('hook stop');
    expect(serialized).toContain('hook subagent_stop');
  });

  it('merges with existing settings without destroying unrelated keys or hooks', async () => {
    await writeSettingsFile({
      otherSetting: 'keep-me',
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hello' }] }] },
    });

    await registerHooks();
    const settings = await readSettingsFile();

    expect(settings.otherSetting).toBe('keep-me');
    // The user's existing PreToolUse hook is preserved; we do NOT add our own
    const ptCmds: string[] = settings.hooks.PreToolUse.flatMap((e: any) => e.hooks.map((h: any) => h.command as string));
    expect(ptCmds).toContain('echo hello');
    expect(ptCmds.some((c: string) => c.includes('pre_tool_use'))).toBe(false);
    expect(settings.hooks.Notification).toBeDefined();
  });

  it('does not duplicate hooks when registered twice', async () => {
    await registerHooks();
    await registerHooks();
    const settings = await readSettingsFile();

    const stopCommands: string[] = settings.hooks.Stop.flatMap((e: any) =>
      e.hooks.map((h: any) => h.command as string),
    );
    // Only one entry — absolute-path command (not duplicated)
    expect(stopCommands).toHaveLength(1);
    expect(stopCommands[0]).toContain(process.execPath);
  });

  it('backs up an existing settings file before overwriting it', async () => {
    await writeSettingsFile({ hooks: {} });
    await registerHooks();

    const backupRaw = await fs.readFile(`${SETTINGS_PATH}.bak`, 'utf8');
    expect(JSON.parse(backupRaw)).toEqual({ hooks: {} });
  });
});

// ── unregisterHooks ───────────────────────────────────────────────────────

describe('unregisterHooks', () => {
  it('removes only agentvigil hook commands, leaving other hooks intact', async () => {
    await writeSettingsFile({
      hooks: {
        PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hello' }] }],
        Notification: [
          { matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'agentvigil hook permission_prompt' }] },
          { matcher: 'custom', hooks: [{ type: 'command', command: 'my-other-tool notify' }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'agentvigil hook stop' }] }],
      },
    });

    await unregisterHooks();
    const settings = await readSettingsFile();

    expect(settings.hooks.PreToolUse).toEqual([{ hooks: [{ type: 'command', command: 'echo hello' }] }]);
    expect(settings.hooks.Notification).toHaveLength(1);
    expect(settings.hooks.Notification[0].matcher).toBe('custom');
    expect(settings.hooks.Stop).toBeUndefined();
  });

  it('removes absolute-path hook commands registered by the new format', async () => {
    await registerHooks();
    await unregisterHooks();
    const settings = await readSettingsFile();

    // All our hook events should be gone
    expect(settings.hooks?.PreToolUse).toBeUndefined();
    expect(settings.hooks?.Notification).toBeUndefined();
    expect(settings.hooks?.Stop).toBeUndefined();
    expect(settings.hooks?.SubagentStop).toBeUndefined();
  });

  it('leaves settings untouched when there are no hooks registered', async () => {
    await writeSettingsFile({ otherSetting: 'value' });
    await unregisterHooks();
    const settings = await readSettingsFile();
    expect(settings).toEqual({ otherSetting: 'value' });
  });
});
