import { execFile } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { formatSummaryForMac } from '../stats/summary-formatter.js';
import type { DailySummary } from '../stats/daily-tracker.js';

export interface MacNotification {
  title: string;
  subtitle?: string;
  body: string;
  sound?: string;
}

/** Escapes a string for safe interpolation into an AppleScript string literal. */
function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Shows a native macOS notification via `osascript`. Never throws — logs and swallows failures. */
export async function sendMacNotification(notification: MacNotification): Promise<void> {
  const { title, subtitle, body, sound } = notification;

  let script = `display notification "${escapeAppleScriptString(body)}" with title "${escapeAppleScriptString(title)}"`;
  if (subtitle) script += ` subtitle "${escapeAppleScriptString(subtitle)}"`;
  if (sound) script += ` sound name "${escapeAppleScriptString(sound)}"`;

  await new Promise<void>((resolve) => {
    execFile('osascript', ['-e', script], (err) => {
      if (err) logger.warn('Mac notification failed', err);
      resolve();
    });
  });
}

export async function sendDailySummaryToMac(summary: DailySummary): Promise<void> {
  const { title, subtitle, body } = formatSummaryForMac(summary);
  await sendMacNotification({ title, subtitle, body, sound: 'Glass' });
}
