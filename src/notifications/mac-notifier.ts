import path from 'node:path';
import { fileURLToPath } from 'node:url';
import notifier from 'node-notifier';
import { logger } from '../utils/logger.js';

const MAX_FIELD_LENGTH = 200;

// Repo root, two levels up from both src/notifications (dev) and
// dist/notifications (build) — the icon is shipped alongside dist/, not
// compiled into it.
const ICON_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'agentvigil-icon.png');

export interface MacNotification {
  title: string;
  subtitle?: string;
  body: string;
  sound?: string;
}

/** Truncates and strips line breaks so long tool output doesn't blow out the notification banner. */
function clip(value: string): string {
  return value.substring(0, MAX_FIELD_LENGTH).replace(/[\r\n]+/g, ' ');
}

/**
 * Shows a native macOS notification via node-notifier (terminal-notifier
 * under the hood), with the AgentVigil icon. node-notifier invokes the
 * notifier binary with `execFile` and an argument array — no shell is
 * involved, so no escaping is needed here. Best-effort: never throws, so it
 * never blocks the ntfy push.
 */
export function sendMacNotification(notification: MacNotification): Promise<void> {
  const { title, subtitle, body, sound = 'default' } = notification;

  return new Promise((resolve) => {
    notifier.notify(
      {
        title: clip(title),
        subtitle: subtitle ? clip(subtitle) : undefined,
        message: clip(body),
        sound,
        icon: ICON_PATH,
      },
      (err) => {
        if (err) logger.dim('Mac notification failed', err);
        resolve();
      }
    );
  });
}

// Convenience methods matching ntfy event types

export async function notifyPermission(projectName: string, permissionText: string): Promise<void> {
  await sendMacNotification({
    title: '⚠️ Permission Required',
    subtitle: projectName,
    body: permissionText,
    sound: 'Funk',
  });
}

export async function notifyTaskComplete(projectName: string, duration?: string): Promise<void> {
  await sendMacNotification({
    title: '✅ Task Complete',
    subtitle: projectName,
    body: duration ? `Completed in ${duration}` : 'Agent finished',
    sound: 'Glass',
  });
}

export async function notifySessionError(projectName: string, error: string): Promise<void> {
  await sendMacNotification({
    title: '❌ Session Error',
    subtitle: projectName,
    body: error,
    sound: 'Basso',
  });
}

export async function notifyIdle(projectName: string): Promise<void> {
  await sendMacNotification({
    title: '⏳ Waiting for Input',
    subtitle: projectName,
    body: 'Claude is waiting for your response',
    sound: 'Ping',
  });
}

export async function notifySessionEnded(projectName: string): Promise<void> {
  await sendMacNotification({
    title: 'Session closed',
    subtitle: projectName,
    body: 'Claude Code session ended',
    sound: 'Pop',
  });
}
