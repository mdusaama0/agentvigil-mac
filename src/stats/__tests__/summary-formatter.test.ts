import { describe, expect, it } from 'vitest';
import type { DailySummary } from '../daily-tracker.js';
import { buildSummaryObject, buildDailyStatsEvent } from '../summary-formatter.js';

function emptySummary(): DailySummary {
  return {
    date: '2026-06-15',
    totalSessions: 0,
    totalActiveTimeMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    totalTasksCompleted: 0,
    totalFilesModified: 0,
    totalPermissionPrompts: 0,
    permissionsApproved: 0,
    permissionsDenied: 0,
    topProject: 'none',
    topProjectCost: 0,
    topProjectTimeMs: 0,
    sessions: [],
    generatedAt: new Date(),
  };
}

describe('buildSummaryObject', () => {
  it('returns 0 averages when there are no sessions, without dividing by zero', () => {
    const wire = buildSummaryObject(emptySummary());

    expect(wire.average_tokens_per_session).toBe(0);
    expect(wire.average_spend_per_session).toBe(0);
    expect(wire.cost_is_api_estimate).toBe(true);
    expect(wire.usage_summary).toContain('0 tokens');
    expect(wire.sessions).toEqual([]);
  });

  it('computes averages across sessions', () => {
    const summary = emptySummary();
    summary.totalSessions = 2;
    summary.totalTokens = 480;
    summary.totalCostUsd = 2;

    const wire = buildSummaryObject(summary);

    expect(wire.average_tokens_per_session).toBe(240);
    expect(wire.average_spend_per_session).toBe(1);
  });

  it('does not throw when a session has invalid date fields', () => {
    const start = new Date('2026-06-15T10:00:00.000Z');
    const summary = emptySummary();
    summary.sessions = [{
      sessionId: 'bad-dates',
      projectName: 'my-app',
      agentType: 'claude-code',
      startTime: start,
      lastActivityAt: new Date(Number.NaN),
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
    }];

    const wire = buildSummaryObject(summary);

    expect(wire.sessions[0].last_activity).toBe(start.toISOString());
  });
});

describe('buildDailyStatsEvent', () => {
  it('wraps the summary in a daily_stats_update event', () => {
    const event = buildDailyStatsEvent(emptySummary());

    expect(event.type).toBe('daily_stats_update');
    expect(event.session_id).toBe('daily_stats');
    expect(event.summary?.date).toBe('2026-06-15');
  });
});
