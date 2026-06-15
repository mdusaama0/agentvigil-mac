import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { sendDailySummaryToPhone } from '../notifications/ntfy-client.js';
import { sendDailySummaryToMac } from '../notifications/mac-notifier.js';
import { getActiveSessions } from '../sessions/session-manager.js';
import { findSessionFileForCwd, findSessionFileBySessionId, resolveProjectNameFromTranscript } from '../sessions/process-detector.js';
import { calculateTokenUsage, type TokenUsage } from '../sessions/token-calculator.js';
import { isTrackableClaudeSession } from './session-utils.js';
import {
  inferTaskCount,
  listTranscriptsForDate,
  timelineForStatsDate,
} from './transcript-sync.js';
import { buildDailyStatsEvent } from './summary-formatter.js';
import type { AgentEvent } from '../types.js';

/**
 * Minimal interface for pushing a live daily-stats snapshot to the phone.
 * `AgentVigilWsServer` structurally satisfies this — no import needed,
 * avoiding a circular dependency (mirrors `RelayWsServer` in relay-handler.ts).
 */
export interface StatsBroadcaster {
  readonly isPhoneConnected: boolean;
  sendEvent(event: AgentEvent): void;
}

export interface SessionStat {
  sessionId: string;
  projectName: string;
  agentType: string;
  startTime: Date;
  endTime?: Date;
  lastActivityAt: Date;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  tasksCompleted: number;
  filesModified: number;
  permissionPrompts: number;
  permissionsApproved: number;
  permissionsDenied: number;
}

export interface DailySummary {
  date: string; // YYYY-MM-DD
  totalSessions: number;
  totalActiveTimeMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  totalTasksCompleted: number;
  totalFilesModified: number;
  totalPermissionPrompts: number;
  permissionsApproved: number;
  permissionsDenied: number;
  topProject: string;
  topProjectCost: number;
  topProjectTimeMs: number;
  sessions: SessionStat[];
  generatedAt: Date;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Active sessions go quiet for long stretches between hook events (no
// permission prompts, not yet stopped) — poll their transcripts directly so
// the stats screen doesn't sit empty for the whole session.
const ACTIVE_SESSION_SYNC_INTERVAL_MS = 60_000;
const ACTIVE_SESSION_SYNC_INITIAL_DELAY_MS = 5_000;

export { isTrackableClaudeSession } from './session-utils.js';

function refreshDuration(stat: SessionStat, force = false): void {
  if (!force && stat.durationMs > 0) return;
  const end = stat.endTime ?? stat.lastActivityAt ?? stat.startTime;
  const ms = end.getTime() - stat.startTime.getTime();
  stat.durationMs = ms > 0 ? ms : 0;
}

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

/** Parses persisted or in-memory values into a valid Date (Invalid Date → fallback). */
function coerceDate(value: unknown, fallback: Date = new Date()): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value != null && value !== '') {
    const parsed = new Date(value as string | number);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback;
}

function zeroedSessionStat(sessionId: string, projectName: string, agentType: string): SessionStat {
  return {
    sessionId,
    projectName,
    agentType,
    startTime: new Date(),
    lastActivityAt: new Date(),
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
  };
}

function projectMergeKey(stat: SessionStat): string {
  if (stat.projectName && stat.projectName !== '.') {
    return stat.projectName;
  }
  return stat.sessionId;
}

/** Rolls up multiple Claude sessions in the same project into one stats row for the phone. */
export function mergeSessionsByProject(sessions: SessionStat[]): SessionStat[] {
  const merged = new Map<string, SessionStat>();

  for (const s of sessions) {
    const key = projectMergeKey(s);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...s });
      continue;
    }

    if (s.startTime < existing.startTime) existing.startTime = s.startTime;
    if (!s.endTime) {
      existing.endTime = undefined;
    } else if (!existing.endTime || s.endTime > existing.endTime) {
      existing.endTime = s.endTime;
    }
    if (s.lastActivityAt > existing.lastActivityAt) existing.lastActivityAt = s.lastActivityAt;

    existing.durationMs += s.durationMs;
    existing.inputTokens += s.inputTokens;
    existing.outputTokens += s.outputTokens;
    existing.cacheReadTokens += s.cacheReadTokens;
    existing.totalTokens += s.totalTokens;
    existing.costUsd += s.costUsd;
    existing.tasksCompleted += s.tasksCompleted;
    existing.filesModified += s.filesModified;
    existing.permissionPrompts += s.permissionPrompts;
    existing.permissionsApproved += s.permissionsApproved;
    existing.permissionsDenied += s.permissionsDenied;
  }

  for (const [key, stat] of merged) {
    if (stat.projectName && stat.projectName !== '.') {
      stat.sessionId = `project:${key}`;
    }
    refreshDuration(stat, true);
  }

  return [...merged.values()];
}

/**
 * Tracks coding-session activity throughout the day and sends an end-of-day
 * summary to the phone (ntfy) and Mac (native notification).
 *
 * `agentvigil hook <type>` runs as a short-lived CLI process separate from
 * the long-running daemon, so every public method reloads `stats.json`
 * before mutating and saves immediately after — this is how state survives
 * across those separate processes.
 */
class DailyTracker {
  private todayStats = new Map<string, SessionStat>();
  private broadcaster?: StatsBroadcaster;

  constructor(
    private readonly statsFilePath: string = path.join(os.homedir(), '.agentvigil', 'stats.json')
  ) {}

  async initialize(broadcaster?: StatsBroadcaster): Promise<void> {
    this.broadcaster = broadcaster;
    await this.loadFromDisk();
    if (this.purgeInvalidSessions()) {
      await this.saveToDisk();
      logger.info('Removed non-Claude session entries from daily stats');
    }
    await this.backfillMissingProjectNames();
    await this.reconcileFromTranscripts();
    this.scheduleEndOfDaySummary();
    this.scheduleMidnightReset();
    this.scheduleActiveSessionSync();
  }

  async trackSessionStart(sessionId: string, projectName: string, agentType: string): Promise<void> {
    if (!isTrackableClaudeSession(sessionId)) return;
    await this.loadFromDisk();
    if (this.todayStats.has(sessionId)) return;
    this.todayStats.set(sessionId, zeroedSessionStat(sessionId, projectName, agentType));
    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** True if `sessionId` already has a tracked stat for today (in-memory). */
  hasSession(sessionId: string): boolean {
    return this.todayStats.has(sessionId);
  }

  /** Called when a session's token usage/cost/files-modified is known (e.g. from the Stop hook). */
  async updateTokenUsage(
    sessionId: string,
    usage: TokenUsage,
    lastActivity: Date,
    transcriptPath?: string
  ): Promise<void> {
    if (!isTrackableClaudeSession(sessionId)) return;
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;

    await this.ensureProjectName(stat, transcriptPath);
    stat.lastActivityAt = coerceDate(lastActivity, stat.lastActivityAt ?? stat.endTime ?? stat.startTime);

    if (usage.totalTokens > 0) {
      stat.inputTokens = usage.inputTokens;
      stat.outputTokens = usage.outputTokens;
      stat.cacheReadTokens = usage.cacheReadTokens;
      stat.totalTokens = usage.totalTokens;
      stat.costUsd = usage.estimatedCostUsd;
      stat.filesModified = usage.filesModified;
    }

    if (transcriptPath) {
      await this.applyTranscriptTimeline(stat, transcriptPath, usage.totalTokens);
    } else {
      refreshDuration(stat);
    }

    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Called when a permission prompt fires. */
  async trackPermission(sessionId: string): Promise<void> {
    if (!isTrackableClaudeSession(sessionId)) return;
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;
    stat.permissionPrompts++;
    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Called when a permission prompt is approved from the phone. */
  async trackApproval(sessionId: string): Promise<void> {
    if (!isTrackableClaudeSession(sessionId)) return;
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;
    stat.permissionsApproved++;
    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Called when a permission prompt is denied from the phone. */
  async trackDenial(sessionId: string): Promise<void> {
    if (!isTrackableClaudeSession(sessionId)) return;
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;
    stat.permissionsDenied++;
    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Called when the Stop hook fires for a session. */
  async trackSessionEnd(sessionId: string, usage?: TokenUsage, transcriptPath?: string): Promise<void> {
    if (!isTrackableClaudeSession(sessionId)) return;
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;

    await this.ensureProjectName(stat, transcriptPath);
    stat.endTime = new Date();
    stat.lastActivityAt = stat.endTime;
    stat.durationMs = stat.endTime.getTime() - stat.startTime.getTime();
    stat.tasksCompleted++;

    if (usage && usage.totalTokens > 0) {
      stat.inputTokens = usage.inputTokens;
      stat.outputTokens = usage.outputTokens;
      stat.cacheReadTokens = usage.cacheReadTokens;
      stat.totalTokens = usage.totalTokens;
      stat.costUsd = usage.estimatedCostUsd;
      stat.filesModified = usage.filesModified;
    }

    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Pushes the current daily summary to the phone over the live WS tunnel, if connected. */
  private broadcastStatsUpdate(): void {
    if (!this.broadcaster?.isPhoneConnected) return;
    try {
      this.broadcaster.sendEvent(buildDailyStatsEvent(this.buildDailySummary()));
    } catch (err) {
      logger.warn('Failed to broadcast daily stats update', err);
    }
  }

  buildDailySummary(): DailySummary {
    for (const stat of this.todayStats.values()) {
      refreshDuration(stat);
    }

    const sessions = mergeSessionsByProject(Array.from(this.todayStats.values()));

    const topProject = sessions.reduce<SessionStat | undefined>(
      (top, s) => (s.costUsd > (top?.costUsd ?? 0) ? s : top),
      undefined
    );

    return {
      date: todayDateString(),
      totalSessions: sessions.length,
      totalActiveTimeMs: sessions.reduce((s, x) => s + x.durationMs, 0),
      totalInputTokens: sessions.reduce((s, x) => s + x.inputTokens, 0),
      totalOutputTokens: sessions.reduce((s, x) => s + x.outputTokens, 0),
      totalCacheReadTokens: sessions.reduce((s, x) => s + x.cacheReadTokens, 0),
      totalTokens: sessions.reduce((s, x) => s + x.totalTokens, 0),
      totalCostUsd: sessions.reduce((s, x) => s + x.costUsd, 0),
      totalTasksCompleted: sessions.reduce((s, x) => s + x.tasksCompleted, 0),
      totalFilesModified: sessions.reduce((s, x) => s + x.filesModified, 0),
      totalPermissionPrompts: sessions.reduce((s, x) => s + x.permissionPrompts, 0),
      permissionsApproved: sessions.reduce((s, x) => s + x.permissionsApproved, 0),
      permissionsDenied: sessions.reduce((s, x) => s + x.permissionsDenied, 0),
      topProject: topProject?.projectName ?? 'none',
      topProjectCost: topProject?.costUsd ?? 0,
      topProjectTimeMs: topProject?.durationMs ?? 0,
      sessions,
      generatedAt: new Date(),
    };
  }

  async sendDailySummary(): Promise<void> {
    const summary = this.buildDailySummary();

    if (summary.totalSessions === 0) {
      logger.dim('No sessions today — skipping daily summary');
      return;
    }

    const config = await getConfig();

    logger.info('Sending daily summary...');
    await Promise.all([
      sendDailySummaryToPhone(config.ntfy_topic, summary),
      sendDailySummaryToMac(summary),
    ]);
    logger.success('Daily summary sent');
  }

  private async scheduleEndOfDaySummary(): Promise<void> {
    const config = await getConfig();
    const summaryHour = config.dailySummaryHour ?? 21;
    const summaryMinute = config.dailySummaryMinute ?? 0;

    const now = new Date();
    const target = new Date();
    target.setHours(summaryHour, summaryMinute, 0, 0);

    // If today's slot already passed, schedule for tomorrow.
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    const msUntilSummary = target.getTime() - now.getTime();
    logger.info(`Daily summary scheduled for ${target.toLocaleTimeString()}`);

    setTimeout(() => {
      void this.sendDailySummary();
      setInterval(() => void this.sendDailySummary(), MS_PER_DAY);
    }, msUntilSummary);
  }

  /**
   * Polls every active session's transcript so the stats screen reflects
   * running sessions, not just ones that have fired a hook. Runs once
   * shortly after startup, then every ACTIVE_SESSION_SYNC_INTERVAL_MS.
   */
  private scheduleActiveSessionSync(): void {
    setTimeout(() => {
      void syncActiveSessionStats();
      setInterval(() => void syncActiveSessionStats(), ACTIVE_SESSION_SYNC_INTERVAL_MS);
    }, ACTIVE_SESSION_SYNC_INITIAL_DELAY_MS);
  }

  private scheduleMidnightReset(): void {
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const msUntilMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
      void this.resetForNewDay();
      setInterval(() => void this.resetForNewDay(), MS_PER_DAY);
    }, msUntilMidnight);
  }

  private async resetForNewDay(): Promise<void> {
    logger.info('Midnight reset — clearing daily stats');
    this.todayStats.clear();
    await this.saveToDisk();
  }

  private async applyTranscriptTimeline(
    stat: SessionStat,
    transcriptPath: string,
    totalTokens: number
  ): Promise<void> {
    const timeline = await timelineForStatsDate(transcriptPath, todayDateString());

    if (timeline.firstActivity) {
      stat.startTime = timeline.firstActivity;
    }
    if (timeline.lastActivity) {
      stat.lastActivityAt = timeline.lastActivity;
      if (timeline.stopCount > 0) {
        stat.endTime = timeline.lastActivity;
      }
    }

    const tasks = inferTaskCount(timeline.stopCount, totalTokens);
    if (tasks > stat.tasksCompleted) stat.tasksCompleted = tasks;

    refreshDuration(stat);
  }

  /** Scans today's transcripts so every project with Claude activity appears in stats. */
  async reconcileFromTranscriptsPublic(): Promise<void> {
    await this.loadFromDisk();
    await this.reconcileFromTranscripts();
    this.broadcastStatsUpdate();
  }

  /** Scans today's transcripts so every project with Claude activity appears in stats. */
  private async reconcileFromTranscripts(): Promise<void> {
    const date = todayDateString();
    const transcripts = await listTranscriptsForDate(date);
    let changed = false;

    for (const { sessionId, filePath } of transcripts) {
      let stat = this.todayStats.get(sessionId);

      if (!stat) {
        const projectName = (await resolveProjectNameFromTranscript(filePath)) ?? '';
        stat = zeroedSessionStat(sessionId, projectName, 'claude-code');
        this.todayStats.set(sessionId, stat);
        changed = true;
      }

      await this.ensureProjectName(stat, filePath);

      const usage = await calculateTokenUsage(filePath);
      if (usage.totalTokens > 0) {
        stat.inputTokens = usage.inputTokens;
        stat.outputTokens = usage.outputTokens;
        stat.cacheReadTokens = usage.cacheReadTokens;
        stat.totalTokens = usage.totalTokens;
        stat.costUsd = usage.estimatedCostUsd;
        stat.filesModified = usage.filesModified;
        changed = true;
      }

      await this.applyTranscriptTimeline(stat, filePath, usage.totalTokens);
      refreshDuration(stat);
      changed = true;
    }

    if (changed) {
      await this.saveToDisk();
      logger.info(`Reconciled daily stats from ${transcripts.length} transcript(s)`);
    }
  }

  private async ensureProjectName(stat: SessionStat, transcriptPath?: string): Promise<void> {
    if (stat.projectName && stat.projectName !== '.') return;

    const filePath =
      transcriptPath
      ?? (await findSessionFileBySessionId(stat.sessionId))?.filePath;
    if (!filePath) return;

    const name = await resolveProjectNameFromTranscript(filePath);
    if (name) stat.projectName = name;
  }

  private async backfillMissingProjectNames(): Promise<void> {
    let changed = false;
    for (const stat of this.todayStats.values()) {
      const before = stat.projectName;
      await this.ensureProjectName(stat);
      if (stat.projectName !== before) changed = true;
    }
    if (changed) {
      await this.saveToDisk();
      logger.info('Backfilled missing project names in daily stats');
    }
  }

  private purgeInvalidSessions(): boolean {
    let removed = false;
    for (const id of [...this.todayStats.keys()]) {
      if (!isTrackableClaudeSession(id)) {
        this.todayStats.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statsFilePath, 'utf-8');
      const data = JSON.parse(raw);
      const today = todayDateString();
      if (data.date === today && Array.isArray(data.sessions)) {
        for (const s of data.sessions) {
          if (!isTrackableClaudeSession(s.sessionId)) continue;
          s.startTime = coerceDate(s.startTime);
          if (s.endTime != null) s.endTime = coerceDate(s.endTime, s.startTime);
          s.lastActivityAt = coerceDate(s.lastActivityAt, s.endTime ?? s.startTime);
          this.todayStats.set(s.sessionId, s);
        }
      }
      this.purgeInvalidSessions();
    } catch {
      // No stats file yet, or it's malformed/stale — start fresh.
    }
  }

  private async saveToDisk(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.statsFilePath), { recursive: true });
      await fs.writeFile(
        this.statsFilePath,
        JSON.stringify(
          {
            date: todayDateString(),
            sessions: Array.from(this.todayStats.values()),
          },
          null,
          2
        )
      );
    } catch (err) {
      logger.warn('Failed to save daily stats', err);
    }
  }
}

export { DailyTracker };
export const dailyTracker = new DailyTracker();

/**
 * Brings today's stats up to date for every currently-active session,
 * regardless of whether a hook has fired for it yet — a long `working`
 * session can otherwise go hours without appearing on the stats screen.
 */
export async function syncActiveSessionStats(): Promise<void> {
  await dailyTracker.reconcileFromTranscriptsPublic();

  for (const session of getActiveSessions()) {
    if (!isTrackableClaudeSession(session.session_id, session.cwd)) continue;

    const fileInfo =
      (await findSessionFileBySessionId(session.session_id))
      ?? (session.cwd ? await findSessionFileForCwd(session.cwd) : null);
    if (!fileInfo) continue;

    if (!dailyTracker.hasSession(session.session_id)) {
      const projectName =
        session.project_name && session.project_name !== '.'
          ? session.project_name
          : (await resolveProjectNameFromTranscript(fileInfo.filePath)) ?? session.project_name;
      await dailyTracker.trackSessionStart(session.session_id, projectName, session.agent);
    }

    const usage = await calculateTokenUsage(fileInfo.filePath);
    await dailyTracker.updateTokenUsage(
      session.session_id,
      usage,
      session.last_activity,
      fileInfo.filePath
    );
  }
}
