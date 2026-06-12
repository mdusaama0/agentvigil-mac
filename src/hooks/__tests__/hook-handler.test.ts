import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseHookPayload, buildAgentEvent, getPermissionDetails } from '../hook-handler.js';

describe('parseHookPayload', () => {
  it('parses a full permission_prompt payload', () => {
    const raw = JSON.stringify({
      session_id: 'abc123',
      transcript_path: '/Users/dev/.claude/projects/my-api/abc123.jsonl',
      cwd: '/Users/dev/my-api-backend',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude wants to run: rm -rf node_modules',
    });

    const payload = parseHookPayload(raw);

    expect(payload).toEqual({
      session_id: 'abc123',
      transcript_path: '/Users/dev/.claude/projects/my-api/abc123.jsonl',
      cwd: '/Users/dev/my-api-backend',
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      message: 'Claude wants to run: rm -rf node_modules',
    });
  });

  it('fills in defaults for a minimal Stop payload', () => {
    const raw = JSON.stringify({
      session_id: 'abc123',
      transcript_path: '/Users/dev/.claude/projects/my-api/abc123.jsonl',
      cwd: '/Users/dev/my-api-backend',
      hook_event_name: 'Stop',
    });

    const payload = parseHookPayload(raw);

    expect(payload.session_id).toBe('abc123');
    expect(payload.hook_event_name).toBe('Stop');
    expect(payload.notification_type).toBeUndefined();
    expect(payload.message).toBeUndefined();
  });

  it('falls back to safe defaults for empty/garbage input', () => {
    expect(parseHookPayload('')).toMatchObject({ session_id: 'unknown', hook_event_name: '' });
    expect(parseHookPayload('{}')).toMatchObject({ session_id: 'unknown', hook_event_name: '' });
  });

  it('throws on malformed JSON so the caller can catch and log it', () => {
    expect(() => parseHookPayload('{not json')).toThrow();
  });
});

describe('buildAgentEvent', () => {
  const basePayload = {
    session_id: 'abc123',
    transcript_path: '/Users/dev/.claude/projects/my-api/abc123.jsonl',
    cwd: '/Users/dev/my-api-backend',
    hook_event_name: 'Notification',
  };

  it('builds a permission_prompt event with the permission_command set', () => {
    const event = buildAgentEvent('permission_prompt', {
      ...basePayload,
      notification_type: 'permission_prompt',
      message: 'Claude wants to run: rm -rf node_modules',
    });

    expect(event.type).toBe('permission_prompt');
    expect(event.project_name).toBe('my-api-backend');
    expect(event.cwd).toBe('/Users/dev/my-api-backend');
    expect(event.session_id).toBe('abc123');
    expect(event.agent).toBe('claude-code');
    expect(event.message).toBe('Claude wants to run: rm -rf node_modules');
    expect(event.permission_command).toBe('Claude wants to run: rm -rf node_modules');
    expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
  });

  it('builds an idle_waiting event for idle_prompt', () => {
    const event = buildAgentEvent('idle_prompt', {
      ...basePayload,
      notification_type: 'idle_prompt',
      message: 'Waiting for your input...',
    });

    expect(event.type).toBe('idle_waiting');
    expect(event.message).toBe('Waiting for your input...');
    expect(event.permission_command).toBeUndefined();
  });

  it('builds a session_ended event for stop, with a default message when none provided', () => {
    const event = buildAgentEvent('stop', { ...basePayload, hook_event_name: 'Stop' });

    expect(event.type).toBe('session_ended');
    expect(event.message).toBe('Session closed');
    expect(event.permission_command).toBeUndefined();
  });

  it('builds a task_complete event for subagent_stop, distinguished by message', () => {
    const event = buildAgentEvent('subagent_stop', { ...basePayload, hook_event_name: 'SubagentStop' });

    expect(event.type).toBe('task_complete');
    expect(event.message).toBe('Sub-agent completed');
  });

  it('derives project_name from the basename of cwd', () => {
    const event = buildAgentEvent('stop', { ...basePayload, cwd: '/Users/dev/projects/cool-app' });
    expect(event.project_name).toBe('cool-app');
  });

  it('throws on an unknown hook type', () => {
    expect(() => buildAgentEvent('something_else', basePayload)).toThrow(/Unknown hook type/);
  });
});

describe('getPermissionDetails', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-handler-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeTranscript(lines: object[]): Promise<string> {
    const file = path.join(tmpDir, 'transcript.jsonl');
    await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return file;
  }

  it('returns the fallback when the transcript path is empty', async () => {
    expect(await getPermissionDetails('')).toEqual({
      toolName: 'Unknown',
      toolInput: '',
      fullText: 'Claude needs your permission',
    });
  });

  it('returns the fallback when the transcript file does not exist', async () => {
    expect(await getPermissionDetails(path.join(tmpDir, 'missing.jsonl'))).toEqual({
      toolName: 'Unknown',
      toolInput: '',
      fullText: 'Claude needs your permission',
    });
  });

  it('formats a Bash tool_use block from a Claude Code transcript as a shell command', async () => {
    const file = await writeTranscript([
      { type: 'user', message: { role: 'user', content: 'do the thing' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf node_modules' } }],
        },
      },
    ]);

    const details = await getPermissionDetails(file);

    expect(details.toolName).toBe('Bash');
    expect(details.toolInput).toBe(JSON.stringify({ command: 'rm -rf node_modules' }));
    expect(details.fullText).toBe('$ rm -rf node_modules');
  });

  it('formats a Write tool_use block as the create-file question, using only the basename', async () => {
    const file = await writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/Users/dev/my-api-backend/src/main.dart' } }],
        },
      },
    ]);

    const details = await getPermissionDetails(file);

    expect(details.toolName).toBe('Write');
    expect(details.fullText).toBe('Do you want to create main.dart?');
  });

  it('uses the most recent tool_use entry when multiple are present', async () => {
    const file = await writeTranscript([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'b.ts' } }] },
      },
    ]);

    const details = await getPermissionDetails(file);

    expect(details.toolName).toBe('Edit');
    expect(details.fullText).toBe('Do you want to edit b.ts?');
  });

  it('formats a Read tool_use block as "Read {filename}"', async () => {
    const file = await writeTranscript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/Users/dev/my-api-backend/README.md' } }],
        },
      },
    ]);

    const details = await getPermissionDetails(file);

    expect(details.toolName).toBe('Read');
    expect(details.fullText).toBe('Read README.md');
  });

  it('supports the flat { tool_name, tool_input } shape', async () => {
    const file = await writeTranscript([
      { tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } },
    ]);

    const details = await getPermissionDetails(file);

    expect(details.toolName).toBe('WebFetch');
    expect(details.fullText).toBe('Fetch URL: https://example.com');
  });

  it('falls back when no entry contains a tool_use block', async () => {
    const file = await writeTranscript([
      { type: 'user', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ]);

    expect(await getPermissionDetails(file)).toEqual({
      toolName: 'Unknown',
      toolInput: '',
      fullText: 'Claude needs your permission',
    });
  });
});
