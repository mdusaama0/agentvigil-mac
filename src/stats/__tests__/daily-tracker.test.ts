import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DailyTracker, isTrackableClaudeSession, mergeSessionsByProject } from '../daily-tracker.js';
import type { TokenUsage } from '../../sessions/token-calculator.js';

let dir: string;
let statsFilePath: string;
let tracker: DailyTracker;

const SESS_1 = '11111111-1111-4111-8111-111111111111';
const SESS_2 = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentvigil-stats-test-'));
  statsFilePath = path.join(dir, 'stats.json');
  tracker = new DailyTracker(statsFilePath);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const SAMPLE_USAGE: TokenUsage = {
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  totalTokens: 160,
  estimatedCostUsd: 1.5,
  filesModified: 3,
};

describe('isTrackableClaudeSession', () => {
  it('accepts Claude Code UUID session ids', () => {
    expect(isTrackableClaudeSession('1fc7fadb-705f-4c96-ab24-a88f47b95d2f')).toBe(true);
  });

  it('rejects test/dev ids like abc123 and stale-done', () => {
    expect(isTrackableClaudeSession('abc123')).toBe(false);
    expect(isTrackableClaudeSession('stale-done')).toBe(false);
  });
});

describe('trackSessionStart', () => {
  it('adds a zeroed session entry', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');

    const summary = tracker.buildDailySummary();
    expect(summary.totalSessions).toBe(1);
    expect(summary.sessions[0]).toMatchObject({
      sessionId: 'project:my-app',
      projectName: 'my-app',
      agentType: 'claude-code',
      durationMs: 0,
      totalTokens: 0,
      costUsd: 0,
      tasksCompleted: 0,
    });
  });

  it('is idempotent on repeat calls for the same session', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');

    expect(tracker.buildDailySummary().totalSessions).toBe(1);
  });

  it('ignores non-UUID session ids', async () => {
    await tracker.trackSessionStart('abc123', 'my-app', 'claude-code');
    expect(tracker.buildDailySummary().totalSessions).toBe(0);
  });
});

describe('trackSessionEnd', () => {
  it('calculates duration correctly and increments tasksCompleted', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    await new Promise((r) => setTimeout(r, 5));
    await tracker.trackSessionEnd(SESS_1);

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.endTime).toBeInstanceOf(Date);
    expect(session.durationMs).toBeGreaterThanOrEqual(0);
    expect(session.tasksCompleted).toBe(1);
  });

  it('applies token usage fields when provided', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    await tracker.trackSessionEnd(SESS_1, SAMPLE_USAGE);

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.inputTokens).toBe(100);
    expect(session.outputTokens).toBe(50);
    expect(session.cacheReadTokens).toBe(10);
    expect(session.totalTokens).toBe(160);
    expect(session.costUsd).toBe(1.5);
    expect(session.filesModified).toBe(3);
  });

  it('sets lastActivityAt to endTime', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    await tracker.trackSessionEnd(SESS_1);

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.lastActivityAt).toEqual(session.endTime);
  });

  it('does not overwrite token fields when usage.totalTokens is 0', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    await tracker.trackSessionEnd(SESS_1, {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      filesModified: 0,
    });

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.totalTokens).toBe(0);
    expect(session.costUsd).toBe(0);
  });
});

describe('updateTokenUsage', () => {
  it('sets lastActivityAt even when usage.totalTokens is 0, without touching token fields', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    const activity = new Date();

    await tracker.updateTokenUsage(
      SESS_1,
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
        filesModified: 0,
      },
      activity
    );

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.lastActivityAt).toEqual(activity);
    expect(session.totalTokens).toBe(0);
  });

  it('overwrites token/cost/files fields when usage.totalTokens > 0', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    const activity = new Date();

    await tracker.updateTokenUsage(SESS_1, SAMPLE_USAGE, activity);

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.lastActivityAt).toEqual(activity);
    expect(session.inputTokens).toBe(100);
    expect(session.outputTokens).toBe(50);
    expect(session.cacheReadTokens).toBe(10);
    expect(session.totalTokens).toBe(160);
    expect(session.costUsd).toBe(1.5);
    expect(session.filesModified).toBe(3);
  });
});

describe('broadcastStatsUpdate / StatsBroadcaster', () => {
  it('sends a daily_stats_update event when the phone is connected', async () => {
    const sendEvent = vi.fn();
    (tracker as any).broadcaster = { isPhoneConnected: true, sendEvent };

    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');

    expect(sendEvent).toHaveBeenCalledTimes(1);
    const event = sendEvent.mock.calls[0][0];
    expect(event.type).toBe('daily_stats_update');
    expect(event.summary.sessions).toHaveLength(1);
  });

  it('does not send when the phone is not connected', async () => {
    const sendEvent = vi.fn();
    (tracker as any).broadcaster = { isPhoneConnected: false, sendEvent };

    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');

    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('does not throw when no broadcaster is set', async () => {
    await expect(tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code')).resolves.not.toThrow();
  });
});

describe('buildDailySummary', () => {
  it('merges multiple Claude sessions in the same project into one row', async () => {
    await tracker.trackSessionStart(SESS_1, 'MeetingJets', 'claude-code');
    await tracker.trackSessionStart(SESS_2, 'MeetingJets', 'claude-code');
    await tracker.updateTokenUsage(
      SESS_1,
      { ...SAMPLE_USAGE, totalTokens: 100, estimatedCostUsd: 1 },
      new Date()
    );
    await tracker.updateTokenUsage(
      SESS_2,
      { ...SAMPLE_USAGE, totalTokens: 200, estimatedCostUsd: 2 },
      new Date()
    );

    const summary = tracker.buildDailySummary();

    expect(summary.totalSessions).toBe(1);
    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0].projectName).toBe('MeetingJets');
    expect(summary.sessions[0].totalTokens).toBe(300);
    expect(summary.sessions[0].costUsd).toBe(3);
    expect(summary.sessions[0].sessionId).toBe('project:MeetingJets');
  });

  it('aggregates all fields across multiple sessions', async () => {
    await tracker.trackSessionStart(SESS_1, 'project-a', 'claude-code');
    await tracker.trackSessionStart(SESS_2, 'project-b', 'codex');

    await tracker.updateTokenUsage(SESS_1, SAMPLE_USAGE, new Date());
    await tracker.updateTokenUsage(
      SESS_2,
      {
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        totalTokens: 320,
        estimatedCostUsd: 0.5,
        filesModified: 1,
      },
      new Date()
    );

    await tracker.trackPermission(SESS_1);
    await tracker.trackApproval(SESS_1);
    await tracker.trackDenial(SESS_2);
    await tracker.trackSessionEnd(SESS_1);
    await tracker.trackSessionEnd(SESS_2);

    const summary = tracker.buildDailySummary();

    expect(summary.totalSessions).toBe(2);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
    expect(summary.totalCacheReadTokens).toBe(30);
    expect(summary.totalTokens).toBe(480);
    expect(summary.totalCostUsd).toBe(2);
    expect(summary.totalTasksCompleted).toBe(2);
    expect(summary.totalFilesModified).toBe(4);
    expect(summary.totalPermissionPrompts).toBe(1);
    expect(summary.permissionsApproved).toBe(1);
    expect(summary.permissionsDenied).toBe(1);
    expect(summary.topProject).toBe('project-a');
    expect(summary.topProjectCost).toBe(1.5);
  });

  it('returns zeroed totals and "none" topProject when there are no sessions', () => {
    const summary = tracker.buildDailySummary();

    expect(summary.totalSessions).toBe(0);
    expect(summary.topProject).toBe('none');
    expect(summary.topProjectCost).toBe(0);
    expect(summary.topProjectTimeMs).toBe(0);
    expect(summary.sessions).toEqual([]);
  });
});

describe('loadFromDisk', () => {
  it('rehydrates date fields after save/reload so summary formatting does not crash', async () => {
    const activity = new Date('2026-06-15T12:00:00.000Z');
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    await tracker.updateTokenUsage(
      SESS_1,
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        totalTokens: 15,
        estimatedCostUsd: 0.1,
        filesModified: 1,
      },
      activity
    );

    const reloaded = new DailyTracker(statsFilePath);
    await (reloaded as any).loadFromDisk();

    const session = reloaded.buildDailySummary().sessions[0];
    expect(session.lastActivityAt).toBeInstanceOf(Date);
    expect(session.lastActivityAt.toISOString()).toBe(activity.toISOString());
  });

  it('rehydrates null lastActivityAt using endTime or startTime', async () => {
    const start = new Date('2026-06-15T10:00:00.000Z');
    const end = new Date('2026-06-15T11:00:00.000Z');
    await fs.writeFile(
      statsFilePath,
      JSON.stringify({
        date: new Date().toISOString().split('T')[0],
        sessions: [{
          sessionId: '33333333-3333-4333-8333-333333333333',
          projectName: 'my-app',
          agentType: 'claude-code',
          startTime: start.toISOString(),
          endTime: end.toISOString(),
          lastActivityAt: null,
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          totalTokens: 0,
          costUsd: 0,
          tasksCompleted: 0,
          filesModified: 0,
          permissionPrompts: 0,
          permissionsApproved: 0,
          permissionsDenied: 0,
        }],
      }, null, 2)
    );

    const reloaded = new DailyTracker(statsFilePath);
    await (reloaded as any).loadFromDisk();

    const session = reloaded.buildDailySummary().sessions[0];
    expect(session.lastActivityAt.toISOString()).toBe(end.toISOString());
  });

  it('drops junk session ids when loading from disk', async () => {
    await fs.writeFile(
      statsFilePath,
      JSON.stringify({
        date: new Date().toISOString().split('T')[0],
        sessions: [
          {
            sessionId: 'abc123',
            projectName: 'fake',
            agentType: 'claude-code',
            startTime: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            tasksCompleted: 0,
            filesModified: 0,
            permissionPrompts: 0,
            permissionsApproved: 0,
            permissionsDenied: 0,
          },
          {
            sessionId: SESS_1,
            projectName: 'real',
            agentType: 'claude-code',
            startTime: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
            durationMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            totalTokens: 0,
            costUsd: 0,
            tasksCompleted: 0,
            filesModified: 0,
            permissionPrompts: 0,
            permissionsApproved: 0,
            permissionsDenied: 0,
          },
        ],
      }, null, 2)
    );

    const reloaded = new DailyTracker(statsFilePath);
    await (reloaded as any).loadFromDisk();

    const summary = reloaded.buildDailySummary();
    expect(summary.totalSessions).toBe(1);
    expect(summary.sessions[0].sessionId).toBe('project:real');
  });

  it('backfills an empty project name from the transcript path', async () => {
    const sessionId = 'eb369977-e06e-4cfc-86cb-c12625f2b97d';
    const projectsDir = path.join(dir, '.claude', 'projects', '-Users-Usama-MeetingJets');
    await fs.mkdir(projectsDir, { recursive: true });
    await fs.writeFile(
      path.join(projectsDir, `${sessionId}.jsonl`),
      '{"message":"working"}\n'
    );

    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    await tracker.trackSessionStart(sessionId, '', 'claude-code');
    await (tracker as any).backfillMissingProjectNames();

    expect(tracker.buildDailySummary().sessions[0].projectName).toBe('MeetingJets');
    vi.restoreAllMocks();
  });
});

describe('resetForNewDay', () => {
  it('clears the tracker and persists the empty state', async () => {
    await tracker.trackSessionStart(SESS_1, 'my-app', 'claude-code');
    expect(tracker.buildDailySummary().totalSessions).toBe(1);

    await (tracker as any).resetForNewDay();

    expect(tracker.buildDailySummary().totalSessions).toBe(0);

    // A fresh tracker reading the same (now-empty) file should not see sess-1.
    const reloaded = new DailyTracker(statsFilePath);
    await reloaded.trackSessionStart(SESS_2, 'other-app', 'claude-code');

    const summary = reloaded.buildDailySummary();
    expect(summary.totalSessions).toBe(1);
    expect(summary.sessions[0].sessionId).toBe('project:other-app');
  });
});
