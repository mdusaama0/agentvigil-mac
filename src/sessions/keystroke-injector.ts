import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { getSession, updateSession } from './session-manager.js';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// The permission prompt is a numbered menu — option 1 is "Yes", option 3 is "No".
export async function approvePermission(sessionId: string): Promise<boolean> {
  return injectText(sessionId, '1');
}

export async function denyPermission(sessionId: string): Promise<boolean> {
  return injectText(sessionId, '3');
}

export async function sendPromptToSession(sessionId: string, text: string): Promise<boolean> {
  return injectText(sessionId, text);
}

async function getTtyForPid(pid: string): Promise<string | null> {
  try {
    const raw = await run('ps', ['-p', pid, '-o', 'tty=']);
    const tty = raw.trim();
    if (!tty || tty === '?' || tty === '??') return null;
    return tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
  } catch {
    return null;
  }
}

async function injectText(sessionId: string, text: string): Promise<boolean> {
  const session = getSession(sessionId);
  if (!session) {
    logger.error(`Cannot inject — session ${sessionId} not found`);
    return false;
  }
  const pid = session.pid;
  if (!pid) {
    logger.error(`Cannot inject — session ${session.project_name} has no pid`);
    return false;
  }

  const tty = await getTtyForPid(pid);
  logger.info(`Injecting "${text}" into ${session.project_name} (pid ${pid}, tty ${tty ?? 'unresolved'})`);

  const strategies: Array<[string, () => Promise<boolean>]> = [
    ['tmux',         () => injectViaTmux(pid, session.tmux_pane_id, sessionId, text)],
    ['iTerm2',       () => injectViaITerm2(tty, text)],
    ['Terminal.app', () => injectViaTerminalApp(tty, text)],
    ['tty-write',    () => injectViaTtyWrite(tty, text)],
  ];

  for (const [name, strategy] of strategies) {
    try {
      const ok = await strategy();
      if (ok) {
        logger.success(`Keystroke injected into ${session.project_name} (via ${name})`);
        return true;
      }
      logger.dim(`${name} strategy declined`);
    } catch (err) {
      logger.dim(`${name} strategy failed: ${err}`);
    }
  }

  await sendMacNotificationFallback(session.project_name, text);
  logger.warn(`All injection strategies failed for ${session.project_name}`);
  return false;
}

// ── Strategy 1: tmux send-keys ────────────────────────────────────────────────

async function injectViaTmux(
  pid: string,
  storedPaneId: string | undefined,
  sessionId: string,
  text: string
): Promise<boolean> {
  try { await run('which', ['tmux']); } catch {
    logger.dim('tmux: not installed');
    return false;
  }

  // Fast path: use cached pane ID
  if (storedPaneId) {
    try {
      await run('tmux', ['send-keys', '-t', storedPaneId, text, 'Enter']);
      return true;
    } catch {
      logger.dim(`tmux: cached pane ${storedPaneId} is stale — scanning all panes`);
    }
  }

  // Slow path: find the pane whose pid matches this process
  try {
    const out = await run('tmux', ['list-panes', '-a', '-F', '#{pane_id}|#{pane_pid}']);
    for (const line of out.trim().split('\n')) {
      const [paneId, panePid] = line.split('|');
      if (panePid?.trim() === pid && paneId?.trim()) {
        await run('tmux', ['send-keys', '-t', paneId.trim(), text, 'Enter']);
        updateSession(sessionId, { tmux_pane_id: paneId.trim() });
        return true;
      }
    }
  } catch (err) {
    logger.dim(`tmux: list-panes failed: ${err}`);
    return false;
  }

  logger.dim(`tmux: no pane found for pid ${pid} (not running inside tmux)`);
  return false;
}

// ── Strategy 2: iTerm2 AppleScript ───────────────────────────────────────────
// iTerm2's `write text` injects directly into the PTY without needing focus.

async function injectViaITerm2(tty: string | null, text: string): Promise<boolean> {
  try {
    const out = await run('pgrep', ['-x', 'iTerm2']);
    if (!out.trim()) {
      logger.dim('iTerm2: not running (pgrep returned no match)');
      return false;
    }
  } catch (err) {
    logger.dim(`iTerm2: pgrep check failed: ${err}`);
    return false;
  }

  if (!tty) {
    logger.dim('iTerm2: could not resolve tty for pid');
    return false;
  }

  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const script = `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          tell s to write text "${safe}"
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
end tell`;

  try {
    await run('osascript', ['-e', script]);
    return true;
  } catch (err) {
    logger.dim(`iTerm2: osascript failed (Automation permission?): ${err}`);
    return false;
  }
}

// ── Strategy 3: Terminal.app via AppleScript + System Events ─────────────────
// Finds the tab by TTY, focuses it, then sends keystrokes via System Events.
// Brings the Terminal window to the front — the visible side-effect is
// intentional: the user sees the injection happen.

async function injectViaTerminalApp(tty: string | null, text: string): Promise<boolean> {
  try {
    const out = await run('pgrep', ['-x', 'Terminal']);
    if (!out.trim()) {
      logger.dim('Terminal.app: not running (pgrep returned no match)');
      return false;
    }
  } catch (err) {
    logger.dim(`Terminal.app: pgrep check failed: ${err}`);
    return false;
  }

  if (!tty) {
    logger.dim('Terminal.app: could not resolve tty for pid');
    return false;
  }

  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // key code 36 = Return in System Events
  const script = `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected of t to true
        set frontmost of w to true
        tell application "System Events"
          tell process "Terminal"
            keystroke "${safe}"
            key code 36
          end tell
        end tell
        return "ok"
      end if
    end repeat
  end repeat
end tell`;

  try {
    await run('osascript', ['-e', script]);
    return true;
  } catch (err) {
    logger.dim(`Terminal.app: osascript failed (Automation/Accessibility permission?): ${err}`);
    return false;
  }
}

// ── Strategy 4: Python TIOCSTI — write into the TTY input queue ──────────────
// Injects characters directly into the terminal's input buffer using the
// TIOCSTI ioctl. Works for any terminal emulator when we own the TTY (same
// user). No window focus required.

async function injectViaTtyWrite(tty: string | null, text: string): Promise<boolean> {
  if (!tty) {
    logger.dim('tty-write: could not resolve tty for pid');
    return false;
  }

  const safe = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const py = [
    'import fcntl, termios, struct',
    `chars = "${safe}\\n"`,
    // buffering=0 — a tty isn't seekable, and the default buffered I/O
    // (BufferedRandom) probes seekability on open() and raises
    // io.UnsupportedOperation for non-seekable files.
    `f = open("${tty}", "r+b", buffering=0)`,
    '[fcntl.ioctl(f, termios.TIOCSTI, struct.pack("B", c)) for c in chars.encode("utf-8")]',
    'f.close()',
  ].join('; ');

  try {
    await run('python3', ['-c', py]);
    return true;
  } catch (err) {
    // EPERM here is expected and not fixable from a separate process: TIOCSTI
    // requires the calling process to be in the same session as the target
    // tty, which a daemon never is. python3 missing would show as ENOENT instead.
    logger.dim(`tty-write: failed (TIOCSTI requires owning the tty's session — expected EPERM from a separate process): ${err}`);
    return false;
  }
}

// ── Notification fallback ─────────────────────────────────────────────────────

async function sendMacNotificationFallback(projectName: string, text: string): Promise<void> {
  const key = text === '1' ? "'1'" : text === '3' ? "'3'" : `"${text}"`;
  const action = text === '1' ? 'approve' : text === '3' ? 'deny' : 'respond';
  const title = `AgentVigil — ${projectName}`.replace(/"/g, '\\"');
  const body = `Press ${key} + Enter in your terminal to ${action}`;
  try {
    await run('osascript', ['-e', `display notification "${body}" with title "${title}" sound name "Funk"`]);
  } catch {}
}
