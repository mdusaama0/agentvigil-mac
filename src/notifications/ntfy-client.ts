import fetch from 'node-fetch';
import { logger } from '../utils/logger.js';
import { notifyIdle, notifyPermission, notifySessionEnded, notifySessionError, notifyTaskComplete } from './mac-notifier.js';

const NTFY_BASE = 'https://ntfy.sh';

async function publish(topic: string, headers: Record<string, string>, body: string): Promise<void> {
  try {
    await fetch(`${NTFY_BASE}/${topic}`, { method: 'POST', headers, body });
  } catch (err) {
    logger.warn('ntfy push failed (offline?)', err);
  }
}

export async function sendPermissionNotification(
  topic: string,
  projectName: string,
  command: string,
  sessionId: string
): Promise<void> {
  await Promise.all([
    publish(
      topic,
      {
        // HTTP header values must be Latin-1 — emoji render from `Tags` instead (see NOTIFICATIONS.md).
        'Title': `[${projectName}] Permission Required`,
        'Priority': 'urgent',
        'Tags': 'warning,rotating_light',
        'Click': `agentvigil://session/${sessionId}`,
        'Actions': `http, APPROVE, https://ntfy.sh/${topic}/approve/${sessionId}; http, DENY, https://ntfy.sh/${topic}/deny/${sessionId}`,
      },
      command
    ),
    notifyPermission(projectName, command),
  ]);
}

export async function sendTaskCompleteNotification(
  topic: string,
  projectName: string,
  duration: string
): Promise<void> {
  await Promise.all([
    publish(
      topic,
      {
        'Title': `[${projectName}] Task Complete`,
        'Priority': 'default',
        'Tags': 'white_check_mark',
      },
      `Completed in ${duration}`
    ),
    notifyTaskComplete(projectName, duration),
  ]);
}

export async function sendErrorNotification(
  topic: string,
  projectName: string,
  error: string
): Promise<void> {
  await Promise.all([
    publish(
      topic,
      {
        'Title': `[${projectName}] Session Error`,
        'Priority': 'high',
        'Tags': 'x,red_circle',
      },
      error
    ),
    notifySessionError(projectName, error),
  ]);
}

export async function sendIdleNotification(
  topic: string,
  projectName: string,
  sessionId: string
): Promise<void> {
  await Promise.all([
    publish(
      topic,
      {
        'Title': `[${projectName}] Waiting for Input`,
        'Priority': 'default',
        'Tags': 'information_source',
        'Click': `agentvigil://session/${sessionId}`,
      },
      'Claude is waiting for your input'
    ),
    notifyIdle(projectName),
  ]);
}

export async function sendSessionEndedNotification(
  topic: string,
  projectName: string
): Promise<void> {
  await Promise.all([
    publish(
      topic,
      {
        'Title': `[${projectName}] Session closed`,
        'Priority': 'low',
        'Tags': 'white_check_mark',
      },
      'Claude Code session ended'
    ),
    notifySessionEnded(projectName),
  ]);
}
