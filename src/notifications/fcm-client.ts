import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { encrypt } from '../crypto/encryption.js';
import type { AgentEvent } from '../types.js';

export const SERVICE_ACCOUNT_PATH = path.join(os.homedir(), '.agentvigil', 'firebase-service-account.json');

let app: import('firebase-admin/app').App | undefined;
let warnedMissing = false;

async function getMessagingApp(): Promise<import('firebase-admin/app').App | undefined> {
  if (app) return app;

  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    if (!warnedMissing) {
      logger.warn('Firebase service account not found — falling back to ntfy');
      printFcmSetupInstructions();
      warnedMissing = true;
    }
    return undefined;
  }

  const { initializeApp, cert } = await import('firebase-admin/app');
  const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
  app = initializeApp({ credential: cert(serviceAccount) }, 'agentvigil-fcm');
  return app;
}

/**
 * Sends an AgentEvent to the phone as an FCM data message, encrypted with the
 * pairing shared secret exactly like a WebSocket-delivered event — the phone's
 * existing `NotificationService.handleFcmMessage` decrypts and renders it the
 * same way regardless of transport. High-priority data messages are delivered
 * by FCM even when the app has been force-stopped (killed).
 *
 * Returns true if the message was handed to FCM, false if FCM isn't
 * configured or the send failed — the caller should fall back to ntfy.
 */
export async function sendFcmEvent(fcmToken: string, event: AgentEvent, sharedSecret: string): Promise<boolean> {
  const fcmApp = await getMessagingApp();
  if (!fcmApp) return false;

  try {
    const { getMessaging } = await import('firebase-admin/messaging');
    await getMessaging(fcmApp).send({
      token: fcmToken,
      data: {
        event_type: event.type,
        payload: encrypt(JSON.stringify(event), sharedSecret),
      },
      android: {
        priority: 'high',
        ttl: 300_000, // 5 minutes — long enough for a permission prompt to still be relevant
      },
    });
    logger.success(`FCM push sent: ${event.type} (${event.project_name})`);
    return true;
  } catch (err) {
    logger.warn('FCM push failed — falling back to ntfy', err);
    return false;
  }
}

export function printFcmSetupInstructions(): void {
  logger.info('');
  logger.info('To enable killed-app notifications:');
  logger.info('1. Go to Firebase Console → Project Settings');
  logger.info('2. Service Accounts → Generate new private key');
  logger.info('3. Save the JSON file to:');
  logger.info(`   ${SERVICE_ACCOUNT_PATH}`);
  logger.info('4. Restart AgentVigil: node dist/index.js start');
  logger.info('');
  logger.info('Without this step notifications only work when');
  logger.info('the app is open or backgrounded (not killed).');
}
