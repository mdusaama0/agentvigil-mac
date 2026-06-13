import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// dist/commands/autostart.js → go up one level to reach dist/
const __filename = fileURLToPath(import.meta.url);
const distDir    = path.dirname(path.dirname(__filename));
const entryPoint = path.join(distDir, 'index.js');

const LABEL      = 'com.agentvigil.daemon';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG_PATH   = path.join(os.homedir(), '.agentvigil', 'agentvigil.log');

function buildPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entryPoint}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

export async function runInstallAutostart(): Promise<void> {
  await fs.mkdir(path.dirname(PLIST_PATH), { recursive: true });
  await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
  await fs.writeFile(PLIST_PATH, buildPlist(), 'utf8');

  // Reload in case it's already registered from a previous install.
  await execFileAsync('launchctl', ['unload', PLIST_PATH]).catch(() => {});
  await execFileAsync('launchctl', ['load', '-w', PLIST_PATH]);

  logger.success('AgentVigil will now start automatically on login.');
  logger.info(`Launch agent: ${PLIST_PATH}`);
  logger.info(`Logs: ${LOG_PATH}`);
}

export async function runUninstallAutostart(): Promise<void> {
  await execFileAsync('launchctl', ['unload', PLIST_PATH]).catch(() => {});
  await fs.rm(PLIST_PATH, { force: true });

  logger.success('AgentVigil autostart removed.');
}
