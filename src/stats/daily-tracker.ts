import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { getConfig } from '../utils/config.js';
import { sendDailySummaryToPhone } from '../notifications/ntfy-client.js';
import { sendDailySummaryToMac } from '../notifications/mac-notifier.js';
import { getActiveSessions } from '../sessions/session-manager.js';
import { findSessionFileForCwd } from '../sessions/process-detector.js';
import { calculateTokenUsage, type TokenUsage } from '../sessions/token-calculator.js';
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

function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
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
    this.scheduleEndOfDaySummary();
    this.scheduleMidnightReset();
    this.scheduleActiveSessionSync();
  }

  async trackSessionStart(sessionId: string, projectName: string, agentType: string): Promise<void> {
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
  async updateTokenUsage(sessionId: string, usage: TokenUsage, lastActivity: Date): Promise<void> {
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;

    stat.lastActivityAt = lastActivity;

    if (usage.totalTokens > 0) {
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

  /** Called when a permission prompt fires. */
  async trackPermission(sessionId: string): Promise<void> {
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;
    stat.permissionPrompts++;
    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Called when a permission prompt is approved from the phone. */
  async trackApproval(sessionId: string): Promise<void> {
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;
    stat.permissionsApproved++;
    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Called when a permission prompt is denied from the phone. */
  async trackDenial(sessionId: string): Promise<void> {
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;
    stat.permissionsDenied++;
    await this.saveToDisk();
    this.broadcastStatsUpdate();
  }

  /** Called when the Stop hook fires for a session. */
  async trackSessionEnd(sessionId: string, usage?: TokenUsage): Promise<void> {
    await this.loadFromDisk();
    const stat = this.todayStats.get(sessionId);
    if (!stat) return;

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
    this.broadcaster.sendEvent(buildDailyStatsEvent(this.buildDailySummary()));
  }

  buildDailySummary(): DailySummary {
    const sessions = Array.from(this.todayStats.values());

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

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statsFilePath, 'utf-8');
      const data = JSON.parse(raw);
      const today = todayDateString();
      if (data.date === today && Array.isArray(data.sessions)) {
        for (const s of data.sessions) {
          s.startTime = new Date(s.startTime);
          if (s.endTime) s.endTime = new Date(s.endTime);
          this.todayStats.set(s.sessionId, s);
        }
      }
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
  for (const session of getActiveSessions()) {
    if (!dailyTracker.hasSession(session.session_id)) {
      await dailyTracker.trackSessionStart(session.session_id, session.project_name, session.agent);
    }

    const fileInfo = await findSessionFileForCwd(session.cwd);
    if (!fileInfo) continue;

    const usage = await calculateTokenUsage(fileInfo.filePath);
    await dailyTracker.updateTokenUsage(session.session_id, usage, session.last_activity);
  }
}
