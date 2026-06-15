import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger.js';

const CONFIG_DIR = path.join(os.homedir(), '.agentvigil');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface PairedDevice {
  name: string;
  device_id: string;
  public_key: string;
  shared_secret: string;
  paired_at: string;
}

export interface Config {
  version: number;
  device_id: string;
  ntfy_topic: string;
  paired_devices: PairedDevice[];
  ws_port: number;
  tunnel_url?: string;
  /** Phone's FCM registration token — enables direct push when the app is killed. */
  fcm_token?: string;
  /** Hour (0-23, local time) the daily summary notification is sent. Defaults to 23. */
  dailySummaryHour: number;
  /** Minute (0-59, local time) the daily summary notification is sent. Defaults to 59. */
  dailySummaryMinute: number;
}

export function createDefaultConfig(): Config {
  return {
    version: 1,
    device_id: uuidv4(),
    ntfy_topic: `agentvigil-${randomBytes(16).toString('hex')}`,
    paired_devices: [],
    ws_port: 3847,
    dailySummaryHour: 23,
    dailySummaryMinute: 59,
  };
}

export async function getConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(raw) as Config;
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      logger.warn('~/.agentvigil/config.json is malformed — backing it up and starting fresh');
      await fs.copyFile(CONFIG_PATH, `${CONFIG_PATH}.bak`).catch(() => {});
    }
    const config = createDefaultConfig();
    await saveConfig(config);
    return config;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('which', [command], (error) => resolve(!error));
  });
}

export async function ensureCloudflared(): Promise<boolean> {
  if (await commandExists('cloudflared')) return true;

  logger.warn('cloudflared not found');
  logger.info('Install with: brew install cloudflared');
  logger.info('Or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  return false;
}

export function isCloudflaredInstalled(): Promise<boolean> {
  return commandExists('cloudflared');
}
