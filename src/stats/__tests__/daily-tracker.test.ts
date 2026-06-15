import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DailyTracker } from '../daily-tracker.js';
import type { TokenUsage } from '../../sessions/token-calculator.js';

let dir: string;
let statsFilePath: string;
let tracker: DailyTracker;

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

describe('trackSessionStart', () => {
  it('adds a zeroed session entry', async () => {
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');

    const summary = tracker.buildDailySummary();
    expect(summary.totalSessions).toBe(1);
    expect(summary.sessions[0]).toMatchObject({
      sessionId: 'sess-1',
      projectName: 'my-app',
      agentType: 'claude-code',
      durationMs: 0,
      totalTokens: 0,
      costUsd: 0,
      tasksCompleted: 0,
    });
  });

  it('is idempotent on repeat calls for the same session', async () => {
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');

    expect(tracker.buildDailySummary().totalSessions).toBe(1);
  });
});

describe('trackSessionEnd', () => {
  it('calculates duration correctly and increments tasksCompleted', async () => {
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    await tracker.trackSessionEnd('sess-1');

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.endTime).toBeInstanceOf(Date);
    expect(session.durationMs).toBeGreaterThanOrEqual(0);
    expect(session.tasksCompleted).toBe(1);
  });

  it('applies token usage fields when provided', async () => {
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    await tracker.trackSessionEnd('sess-1', SAMPLE_USAGE);

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.inputTokens).toBe(100);
    expect(session.outputTokens).toBe(50);
    expect(session.cacheReadTokens).toBe(10);
    expect(session.totalTokens).toBe(160);
    expect(session.costUsd).toBe(1.5);
    expect(session.filesModified).toBe(3);
  });

  it('sets lastActivityAt to endTime', async () => {
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    await tracker.trackSessionEnd('sess-1');

    const session = tracker.buildDailySummary().sessions[0];
    expect(session.lastActivityAt).toEqual(session.endTime);
  });

  it('does not overwrite token fields when usage.totalTokens is 0', async () => {
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    await tracker.trackSessionEnd('sess-1', {
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
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    const activity = new Date();

    await tracker.updateTokenUsage(
      'sess-1',
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
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    const activity = new Date();

    await tracker.updateTokenUsage('sess-1', SAMPLE_USAGE, activity);

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

    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');

    expect(sendEvent).toHaveBeenCalledTimes(1);
    const event = sendEvent.mock.calls[0][0];
    expect(event.type).toBe('daily_stats_update');
    expect(event.summary.sessions).toHaveLength(1);
  });

  it('does not send when the phone is not connected', async () => {
    const sendEvent = vi.fn();
    (tracker as any).broadcaster = { isPhoneConnected: false, sendEvent };

    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');

    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('does not throw when no broadcaster is set', async () => {
    await expect(tracker.trackSessionStart('sess-1', 'my-app', 'claude-code')).resolves.not.toThrow();
  });
});

describe('buildDailySummary', () => {
  it('aggregates all fields across multiple sessions', async () => {
    await tracker.trackSessionStart('sess-1', 'project-a', 'claude-code');
    await tracker.trackSessionStart('sess-2', 'project-b', 'codex');

    await tracker.updateTokenUsage('sess-1', SAMPLE_USAGE, new Date());
    await tracker.updateTokenUsage(
      'sess-2',
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

    await tracker.trackPermission('sess-1');
    await tracker.trackApproval('sess-1');
    await tracker.trackDenial('sess-2');
    await tracker.trackSessionEnd('sess-1');
    await tracker.trackSessionEnd('sess-2');

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

describe('resetForNewDay', () => {
  it('clears the tracker and persists the empty state', async () => {
    await tracker.trackSessionStart('sess-1', 'my-app', 'claude-code');
    expect(tracker.buildDailySummary().totalSessions).toBe(1);

    await (tracker as any).resetForNewDay();

    expect(tracker.buildDailySummary().totalSessions).toBe(0);

    // A fresh tracker reading the same (now-empty) file should not see sess-1.
    const reloaded = new DailyTracker(statsFilePath);
    await reloaded.trackSessionStart('sess-2', 'other-app', 'claude-code');

    const summary = reloaded.buildDailySummary();
    expect(summary.totalSessions).toBe(1);
    expect(summary.sessions[0].sessionId).toBe('sess-2');
  });
});
