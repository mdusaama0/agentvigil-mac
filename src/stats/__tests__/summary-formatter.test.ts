import { describe, expect, it } from 'vitest';
import { buildSummaryObject, buildDailyStatsEvent } from '../summary-formatter.js';
import type { DailySummary } from '../daily-tracker.js';

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
});

describe('buildDailyStatsEvent', () => {
  it('wraps the summary in a daily_stats_update event', () => {
    const event = buildDailyStatsEvent(emptySummary());

    expect(event.type).toBe('daily_stats_update');
    expect(event.session_id).toBe('daily_stats');
    expect(event.summary?.date).toBe('2026-06-15');
  });
});
