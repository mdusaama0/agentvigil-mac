import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanup,
  clearSessions,
  deleteSession,
  getActiveSessions,
  getAllSessions,
  getSession,
  projectNameFromCwd,
  stateAfterHookEvent,
  updateSession,
} from '../session-manager.js';

beforeEach(() => {
  clearSessions();
});

describe('projectNameFromCwd', () => {
  it('returns the basename of the cwd', () => {
    expect(projectNameFromCwd('/Users/dev/my-api-backend')).toBe('my-api-backend');
  });
});

describe('stateAfterHookEvent', () => {
  it('maps each hook type to the documented state transition', () => {
    expect(stateAfterHookEvent('permission_prompt')).toBe('blocked');
    expect(stateAfterHookEvent('idle_prompt')).toBe('idle');
    expect(stateAfterHookEvent('stop')).toBe('done');
    expect(stateAfterHookEvent('subagent_stop')).toBe('working');
  });
});

describe('updateSession / getSession', () => {
  it('creates a new session with sensible defaults derived from cwd', () => {
    const session = updateSession('abc123', { cwd: '/Users/dev/my-api-backend', state: 'working' });

    expect(session).toMatchObject({
      session_id: 'abc123',
      cwd: '/Users/dev/my-api-backend',
      project_name: 'my-api-backend',
      agent: 'claude-code',
      state: 'working',
    });
    expect(session.last_activity).toBeInstanceOf(Date);
    expect(getSession('abc123')).toEqual(session);
  });

  it('merges partial updates without clobbering untouched fields', () => {
    updateSession('abc123', { cwd: '/Users/dev/my-api-backend', state: 'working', tmux_pane_id: '%3' });
    const updated = updateSession('abc123', { state: 'blocked', last_message: 'rm -rf node_modules' });

    expect(updated.state).toBe('blocked');
    expect(updated.last_message).toBe('rm -rf node_modules');
    expect(updated.tmux_pane_id).toBe('%3');
    expect(updated.cwd).toBe('/Users/dev/my-api-backend');
    expect(updated.project_name).toBe('my-api-backend');
  });

  it('returns undefined for an unknown session id', () => {
    expect(getSession('does-not-exist')).toBeUndefined();
  });

  it('stores permission_command while blocked and clears it once unblocked', () => {
    const blocked = updateSession('abc123', {
      cwd: '/Users/dev/my-api-backend',
      state: 'blocked',
      permission_command: 'rm -rf node_modules',
    });
    expect(blocked.permission_command).toBe('rm -rf node_modules');

    const idle = updateSession('abc123', { state: 'idle', last_message: 'Waiting for input' });
    expect(idle.permission_command).toBeUndefined();
  });
});

describe('getAllSessions', () => {
  it('returns every tracked session', () => {
    updateSession('a', { cwd: '/projects/a' });
    updateSession('b', { cwd: '/projects/b' });

    const all = getAllSessions();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.session_id).sort()).toEqual(['a', 'b']);
  });

  it('returns an empty array when nothing is tracked', () => {
    expect(getAllSessions()).toEqual([]);
  });
});

describe('getActiveSessions', () => {
  it('returns only working, blocked, and idle sessions', () => {
    updateSession('a', { cwd: '/projects/a', state: 'working' });
    updateSession('b', { cwd: '/projects/b', state: 'blocked' });
    updateSession('c', { cwd: '/projects/c', state: 'idle' });
    updateSession('d', { cwd: '/projects/d', state: 'done' });
    updateSession('e', { cwd: '/projects/e', state: 'error' });

    const active = getActiveSessions();
    expect(active.map((s) => s.session_id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty array when no active sessions exist', () => {
    updateSession('a', { cwd: '/projects/a', state: 'done' });
    expect(getActiveSessions()).toEqual([]);
  });
});

describe('deleteSession', () => {
  it('removes the session from the store', () => {
    updateSession('abc', { cwd: '/projects/abc' });
    expect(getSession('abc')).toBeDefined();

    deleteSession('abc');
    expect(getSession('abc')).toBeUndefined();
  });

  it('is a no-op for an unknown session id', () => {
    expect(() => deleteSession('does-not-exist')).not.toThrow();
  });
});

describe('cleanup', () => {
  it('removes done/error sessions inactive for over 5 minutes', () => {
    const now = new Date('2026-06-08T12:00:00Z');
    const tenMinsAgo  = new Date(now.getTime() - 10 * 60 * 1000);
    const twoMinsAgo  = new Date(now.getTime() -  2 * 60 * 1000);

    updateSession('stale-done',    { cwd: '/projects/a', state: 'done',    last_activity: tenMinsAgo });
    updateSession('stale-error',   { cwd: '/projects/b', state: 'error',   last_activity: tenMinsAgo });
    updateSession('recent-done',   { cwd: '/projects/c', state: 'done',    last_activity: twoMinsAgo });
    // active sessions are never touched by cleanup — the process poller owns them
    updateSession('stale-working', { cwd: '/projects/d', state: 'working', last_activity: tenMinsAgo });

    const removed = cleanup(now);

    expect(removed.sort()).toEqual(['stale-done', 'stale-error'].sort());
    expect(getSession('stale-done')).toBeUndefined();
    expect(getSession('stale-error')).toBeUndefined();
    expect(getSession('recent-done')).toBeDefined();
    expect(getSession('stale-working')).toBeDefined(); // poller handles active sessions
  });
});
