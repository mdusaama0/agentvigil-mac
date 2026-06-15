import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { loadOrCreateKeyPair } from '../crypto/encryption.js';
import { RelayHandler } from '../relay/relay-handler.js';
import { isBlocklisted } from '../sessions/session-watcher.js';
import { dailyTracker } from '../stats/daily-tracker.js';
import { calculateTokenUsage } from '../sessions/token-calculator.js';
import type { AgentEvent, AgentEventType, HookPayload } from '../types.js';

const LOG_FILE = path.join(os.homedir(), '.agentvigil', 'hooks.log');

async function logToFile(type: string, payload: unknown): Promise<void> {
  const line = `${new Date().toISOString()} [${type}] ${JSON.stringify(payload)}\n`;
  await fs.appendFile(LOG_FILE, line).catch(() => {});
}

const DAEMON_FORWARD_TIMEOUT_MS = 1500;

const HOOK_TYPES = ['permission_prompt', 'idle_prompt', 'stop', 'subagent_stop'] as const;
type HookType = (typeof HOOK_TYPES)[number];

const DEFAULT_MESSAGE: Record<HookType, string> = {
  permission_prompt: 'Permission required',
  idle_prompt: 'Session idle, waiting for input',
  stop: 'Session closed',
  subagent_stop: 'Sub-agent completed',
};

const AGENT_EVENT_TYPE: Record<HookType, AgentEventType> = {
  permission_prompt: 'permission_prompt',
  idle_prompt: 'idle_waiting',
  stop: 'session_ended',
  subagent_stop: 'task_complete',
};

export async function handleHook(eventType: string): Promise<void> {
  // Log to file FIRST — before any other logic — so we can confirm hooks
  // are actually firing even if downstream code fails.
  const raw = await readStdin();
  await logToFile(eventType, raw);

  try {
    const payload = parseHookPayload(raw);

    if (isBlocklisted(payload.cwd)) {
      logger.dim(`[${path.basename(payload.cwd)}] Ignoring hook from blocklisted project`);
      return;
    }

    // Sub-agent completions are an internal implementation detail — only the
    // top-level Stop hook represents the session actually finishing, so
    // SubagentStop must never reach the session store, the daemon, or ntfy.
    if (payload.hook_event_name === 'SubagentStop') {
      logger.dim('Ignoring SubagentStop — sub-agent completions never notify the phone');
      return;
    }

    const event = buildAgentEvent(eventType, payload);

    if (eventType === 'permission_prompt') {
      const details = await getPermissionDetails(payload.transcript_path);
      if (details !== FALLBACK_PERMISSION_DETAILS) {
        event.message = details.fullText;
        event.permission_command = details.fullText;
        event.tool_name = details.toolName;
        event.tool_input = details.toolInput;
      }

      await dailyTracker.trackPermission(payload.session_id);
    } else if (eventType === 'stop') {
      const usage = await calculateTokenUsage(payload.transcript_path);
      await dailyTracker.trackSessionEnd(payload.session_id, usage);
    }

    logger.info(`[${event.project_name}] ${event.type}: ${event.message}`);

    const config = await getConfig();
    const keyPair = await loadOrCreateKeyPair();

    // Forward the event in-process to the long-running daemon (`agentvigil
    // start`), which holds the live phone WebSocket connection and can relay
    // it immediately.
    const forwarded = await forwardToDaemon(event, config.ws_port, keyPair.secretKey);

    if (!forwarded) {
      // Daemon isn't running — this short-lived CLI process is the only
      // chance this event gets to reach ntfy, so push it directly. When the
      // daemon IS reachable it relays the forwarded event itself, so doing
      // it here too would double-send every notification.
      const relay = new RelayHandler(
        { sendEvent: () => {}, isPhoneConnected: false, getSharedSecret: () => undefined },
        config.ntfy_topic
      );
      await relay.handleAgentEvent(event);
    }
  } catch (err) {
    logger.error('Failed to handle hook event', err);
  }
}

/**
 * Sends the event to the daemon's local WebSocket server, authenticated with
 * the Mac's own secret key (never sent to the phone). Resolves `true` only if
 * the message was actually handed to the daemon; `false` if the daemon isn't
 * running (or didn't respond in time), so the caller can fall back to its own
 * ntfy push.
 */
function forwardToDaemon(event: AgentEvent, wsPort: number, localToken: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(delivered);
    };

    let socket: WebSocket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${wsPort}/hook`);
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      socket.terminate();
      finish(false);
    }, DAEMON_FORWARD_TIMEOUT_MS);

    let delivered = false;
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hook_event', token: localToken, event }));
      delivered = true;
      socket.close();
    });
    socket.on('close', () => finish(delivered));
    socket.on('error', () => finish(false));
  });
}

export function parseHookPayload(raw: string): HookPayload {
  const parsed = JSON.parse(raw || '{}');
  return {
    session_id: parsed.session_id ?? 'unknown',
    transcript_path: parsed.transcript_path ?? '',
    cwd: parsed.cwd ?? process.cwd(),
    hook_event_name: parsed.hook_event_name ?? '',
    notification_type: parsed.notification_type,
    message: parsed.message,
  };
}

export function buildAgentEvent(eventType: string, payload: HookPayload): AgentEvent {
  if (!isHookType(eventType)) {
    throw new Error(`Unknown hook type: ${eventType}`);
  }

  const event: AgentEvent = {
    type: AGENT_EVENT_TYPE[eventType],
    session_id: payload.session_id,
    project_name: path.basename(payload.cwd),
    cwd: payload.cwd,
    agent: 'claude-code',
    message: payload.message ?? DEFAULT_MESSAGE[eventType],
    timestamp: new Date().toISOString(),
  };

  if (eventType === 'permission_prompt') {
    event.permission_command = payload.message;
  }

  return event;
}

function isHookType(value: string): value is HookType {
  return (HOOK_TYPES as readonly string[]).includes(value);
}

export interface PermissionDetails {
  toolName: string;
  toolInput: string;
  fullText: string;
}

const FALLBACK_PERMISSION_DETAILS: PermissionDetails = {
  toolName: 'Unknown',
  toolInput: '',
  fullText: 'Claude needs your permission',
};

/**
 * Reads the JSONL transcript and returns the tool name/input behind the most
 * recent permission prompt, formatted as the human-readable command text
 * shown on the phone (e.g. "$ rm -rf node_modules" or "Write file: foo.ts").
 * Falls back to FALLBACK_PERMISSION_DETAILS if the transcript can't be read
 * or contains no tool_use entry.
 */
export async function getPermissionDetails(transcriptPath: string): Promise<PermissionDetails> {
  if (!transcriptPath) return FALLBACK_PERMISSION_DETAILS;

  try {
    const content = await fs.readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter((l) => l.trim());

    for (const line of [...lines].reverse()) {
      try {
        const entry = JSON.parse(line);
        const toolUse = extractToolUse(entry);
        if (toolUse) {
          return {
            toolName: toolUse.name,
            toolInput: JSON.stringify(toolUse.input),
            fullText: formatPermissionText(toolUse.name, toolUse.input),
          };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Transcript missing or unreadable — fall through to the default.
  }

  return FALLBACK_PERMISSION_DETAILS;
}

/**
 * Finds the most recent tool_use block in a transcript line, supporting both
 * the raw `{ tool_name, tool_input }` shape and Claude Code's nested
 * `{ message: { content: [{ type: 'tool_use', name, input }] } }` shape.
 */
function extractToolUse(entry: any): { name: string; input: Record<string, unknown> } | undefined {
  if (entry?.type === 'tool_use' || entry?.tool_name) {
    return {
      name: entry.tool_name ?? entry.name ?? 'Unknown',
      input: entry.tool_input ?? entry.input ?? {},
    };
  }

  const blocks = entry?.message?.content;
  if (Array.isArray(blocks)) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block?.type === 'tool_use') {
        return { name: block.name ?? 'Unknown', input: block.input ?? {} };
      }
    }
  }

  return undefined;
}

/**
 * Formats the tool_use block as the question the terminal shows the user,
 * e.g. "Do you want to create test.txt?" or "$ rm -rf node_modules".
 * Claude Code does not persist this question text anywhere in the
 * transcript — it's rendered client-side from the tool_use block — so it's
 * reconstructed here from the tool name + input.
 */
function formatPermissionText(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `$ ${input.command ?? ''}`;
    case 'Write':
      return `Do you want to create ${fileNameOf(input)}?`;
    case 'Edit':
    case 'MultiEdit':
      return `Do you want to edit ${fileNameOf(input)}?`;
    case 'Read':
      return `Read ${fileNameOf(input)}`;
    case 'WebFetch':
      return `Fetch URL: ${input.url ?? ''}`;
    case 'TodoWrite':
      return 'Update todo list';
    default:
      return `${toolName}: ${keyDetailOf(input)}`;
  }
}

/** Extracts just the filename (e.g. "test.txt") from a tool_use input's path. */
function fileNameOf(input: Record<string, unknown>): string {
  const filePath = (input.file_path ?? input.path) as string | undefined;
  return filePath ? path.basename(filePath) : '';
}

/** Picks the single most relevant field from a tool_use input for the default case. */
function keyDetailOf(input: Record<string, unknown>): string {
  const value =
    (input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.url ?? input.query ?? input.description) as
      | string
      | undefined;
  return value ?? JSON.stringify(input).substring(0, 100);
}


async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data || '{}'), 2000);
  });
}
