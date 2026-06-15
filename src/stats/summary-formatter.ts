import type { DailySummary } from './daily-tracker.js';
import type { AgentEvent } from '../types.js';

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return `${tokens}`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function toIsoString(value: Date, fallback: Date = new Date()): string {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : fallback;
  return date.toISOString();
}

export interface PhoneSummaryText {
  title: string;
}

/**
 * `Title` is sent as an ntfy HTTP header, which must be Latin-1 — keep it
 * emoji-free. The real notification text is rendered client-side by the
 * Flutter app from the JSON payload (see `buildSummaryPayload`).
 */
export function formatSummaryForPhone(summary: DailySummary): PhoneSummaryText {
  const projectLabel = summary.totalSessions === 1 ? 'project' : 'projects';
  return {
    title: `Daily Summary - ${summary.totalSessions} ${projectLabel}, ${formatTokenCount(summary.totalTokens)} tokens, ${formatDuration(summary.totalActiveTimeMs)}`,
  };
}

export interface MacSummaryText {
  title: string;
  subtitle: string;
  body: string;
}

export function formatSummaryForMac(summary: DailySummary): MacSummaryText {
  const projectLabel = summary.totalSessions === 1 ? 'project' : 'projects';
  const lines = [
    `${summary.totalSessions} ${projectLabel} · ${formatDuration(summary.totalActiveTimeMs)} active`,
    `${formatTokenCount(summary.totalTokens)} tokens (${formatTokenCount(summary.totalOutputTokens)} output)`,
    `${summary.totalTasksCompleted} tasks · ${summary.totalFilesModified} files modified`,
    `Est. API equivalent: ${formatCost(summary.totalCostUsd)} (not your subscription bill)`,
  ];

  if (summary.totalPermissionPrompts > 0) {
    lines.push(
      `${summary.totalPermissionPrompts} permission prompts (${summary.permissionsApproved} approved, ${summary.permissionsDenied} denied)`
    );
  }

  if (summary.topProject !== 'none') {
    lines.push(`Top project: ${summary.topProject} (${formatCost(summary.topProjectCost)} est.)`);
  }

  return {
    title: '📊 Daily Summary',
    subtitle: summary.date,
    body: lines.join('\n'),
  };
}

export interface SessionSummaryWire {
  session_id: string;
  project: string;
  agent: string;
  start_time: string;
  end_time: string | null;
  last_activity: string;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  tokens: number;
  cost_usd: number;
  tasks: number;
}

/** Wire shape shared by the once-daily ntfy payload and the live WS broadcast. */
export interface DailySummaryWirePayload {
  type: 'daily_summary';
  date: string;
  total_sessions: number;
  total_active_time_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  /** Human-readable usage line for subscription users — not a dollar bill. */
  usage_summary: string;
  cost_label: string;
  cost_note: string;
  cost_is_api_estimate: boolean;
  total_tasks_completed: number;
  total_files_modified: number;
  total_permission_prompts: number;
  permissions_approved: number;
  permissions_denied: number;
  average_tokens_per_session: number;
  average_spend_per_session: number;
  top_project: string;
  top_project_cost: number;
  top_project_time_ms: number;
  sessions: SessionSummaryWire[];
  generated_at: string;
}

/** Builds the wire shape shared by the once-daily ntfy payload and the live WS broadcast. */
export function buildSummaryObject(summary: DailySummary): DailySummaryWirePayload {
  const n = summary.totalSessions;
  const usageSummary = `${formatTokenCount(summary.totalTokens)} tokens · ${formatDuration(summary.totalActiveTimeMs)} · ${summary.totalTasksCompleted} tasks`;

  return {
    type: 'daily_summary',
    date: summary.date,
    total_sessions: n,
    total_active_time_ms: summary.totalActiveTimeMs,
    total_input_tokens: summary.totalInputTokens,
    total_output_tokens: summary.totalOutputTokens,
    total_cache_read_tokens: summary.totalCacheReadTokens,
    total_tokens: summary.totalTokens,
    total_cost_usd: summary.totalCostUsd,
    usage_summary: usageSummary,
    cost_label: 'Est. API equivalent',
    cost_note: 'Compares usage to pay-as-you-go API rates — not your Claude subscription bill.',
    cost_is_api_estimate: true,
    total_tasks_completed: summary.totalTasksCompleted,
    total_files_modified: summary.totalFilesModified,
    total_permission_prompts: summary.totalPermissionPrompts,
    permissions_approved: summary.permissionsApproved,
    permissions_denied: summary.permissionsDenied,
    average_tokens_per_session: n > 0 ? summary.totalTokens / n : 0,
    average_spend_per_session: n > 0 ? summary.totalCostUsd / n : 0,
    top_project: summary.topProject,
    top_project_cost: summary.topProjectCost,
    top_project_time_ms: summary.topProjectTimeMs,
    sessions: summary.sessions.map((s) => ({
      session_id: s.sessionId,
      project: s.projectName,
      agent: s.agentType,
      start_time: toIsoString(s.startTime),
      end_time: s.endTime ? toIsoString(s.endTime, s.startTime) : null,
      last_activity: toIsoString(s.lastActivityAt, s.endTime ?? s.startTime),
      duration_ms: s.durationMs,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      tokens: s.totalTokens,
      cost_usd: s.costUsd,
      tasks: s.tasksCompleted,
    })),
    generated_at: toIsoString(summary.generatedAt),
  };
}

/** JSON payload sent as the ntfy message body — parsed by the Flutter app's `DailySummary.fromJson`. */
export function buildSummaryPayload(summary: DailySummary): string {
  return JSON.stringify(buildSummaryObject(summary));
}

/** Live WS event broadcast to the phone whenever today's stats change. */
export function buildDailyStatsEvent(summary: DailySummary): AgentEvent {
  return {
    type: 'daily_stats_update',
    session_id: 'daily_stats',
    project_name: 'AgentVigil',
    cwd: '',
    agent: 'claude-code',
    message: 'daily_stats_update',
    timestamp: new Date().toISOString(),
    summary: buildSummaryObject(summary),
  };
}
