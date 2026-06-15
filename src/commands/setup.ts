import { v4 as uuidv4 } from 'uuid';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { isCloudflaredInstalled, getConfig, saveConfig } from '../utils/config.js';
import type { PairedDevice } from '../utils/config.js';
import { buildHookCommand, registerHooks } from '../hooks/hook-manager.js';
import { deriveSharedSecret, encrypt, loadOrCreateKeyPair } from '../crypto/encryption.js';
import { buildQrPayload, generateQrCode } from '../utils/qr.js';
import { AgentVigilWsServer, type PairRequest } from '../tunnel/websocket-server.js';
import { TunnelManager } from '../tunnel/tunnel-manager.js';
import { RelayHandler } from '../relay/relay-handler.js';
import { getAllSessions } from '../sessions/session-manager.js';
import { SERVICE_ACCOUNT_PATH, printFcmSetupInstructions } from '../notifications/fcm-client.js';
import fs from 'node:fs';
import {
  getLocalIPv4,
  runDaemon,
  toAgentEvent,
} from './daemon.js';

export interface SetupOptions {
  dryRun?: boolean;
}

const MIN_NODE_MAJOR_VERSION = 18;

export async function runSetup(options: SetupOptions = {}): Promise<void> {
  logger.banner('AgentVigil Setup');
  logger.info('This will:');
  logger.info('  1. Register hooks with Claude Code and Codex');
  logger.info('  2. Generate encryption keys');
  logger.info('  3. Start a secure tunnel');
  logger.info('  4. Show a QR code to pair with your phone');
  logger.info('');

  if (!isNodeVersionSupported(process.version)) {
    logger.error(
      `Node.js >= ${MIN_NODE_MAJOR_VERSION} is required (found ${process.version}) — please upgrade and re-run setup.`
    );
    return;
  }

  const hasCloudflared = await isCloudflaredInstalled();
  if (!hasCloudflared) {
    logger.error('cloudflared is required but not installed.');
    logger.info('');
    logger.info('Install it with:');
    logger.info('  brew install cloudflared');
    logger.info('');
    logger.info('Then run setup again:');
    logger.info('  npx agentvigil setup');
    logger.info('');
    process.exit(1);
  }

  if (options.dryRun) {
    printDryRunPlan();
    return;
  }

  await registerHooks();
  logger.info(`Hook command: ${buildHookCommand('permission_prompt')}`);
  logger.info('Verify with: cat ~/.claude/settings.json | grep -A2 agentvigil');
  const keyPair = await loadOrCreateKeyPair();
  const config  = await getConfig();

  // ── Relay handler — wired up after pairing via closure reference ────────
  let relay: RelayHandler | undefined;

  let wsServer!: AgentVigilWsServer;
  let resolvePairing!: (device: PairedDevice) => void;
  const paired = new Promise<PairedDevice>((resolve) => {
    resolvePairing = resolve;
  });

  const handlePairRequest = (request: PairRequest, socket: WebSocket): void => {
    const sharedSecret = deriveSharedSecret(keyPair.secretKey, request.pub_key);
    wsServer.setSharedSecret(sharedSecret);

    const device: PairedDevice = {
      name:         request.device_name,
      device_id:    uuidv4(),
      public_key:   request.pub_key,
      shared_secret: sharedSecret,
      paired_at:    new Date().toISOString(),
    };

    // Encrypted confirmation — phone needs this to know pairing succeeded.
    const confirmation = encrypt(
      JSON.stringify({ type: 'paired', device_id: config.device_id }),
      sharedSecret,
    );
    socket.send(JSON.stringify({ payload: confirmation }));

    resolvePairing(device);
  };

  // Create the WS server with relay callbacks wired via closure so that
  // commands and hook events work immediately after pairing, without
  // needing to restart the server.
  wsServer = new AgentVigilWsServer(config.ws_port, {
    getSessions:  () => getAllSessions().map(toAgentEvent),
    onPairRequest: handlePairRequest,
    onCommand:    (command) => { void relay?.handlePhoneCommand(command); },
    onHookEvent:  (event)   => { void relay?.handleAgentEvent(event); },
    localToken:   keyPair.secretKey,
  });
  wsServer.start();

  // ── Tunnel ──────────────────────────────────────────────────────────────
  const tunnelManager = new TunnelManager();
  let tunnelUrl: string | undefined;

  try {
    tunnelUrl = await tunnelManager.start(config.ws_port);
  } catch (err) {
    logger.warn('Could not start cloudflared tunnel — pairing will only work on the local network', err);
  }

  if (tunnelUrl) {
    config.tunnel_url = tunnelUrl;
    await saveConfig(config);
  }

  // Use the Mac's real LAN IP when there is no internet tunnel, so the phone
  // (on the same Wi-Fi) can actually reach the WebSocket server.
  const localIp  = getLocalIPv4();
  const lanUrl   = localIp
    ? `ws://${localIp}:${config.ws_port}`
    : `ws://localhost:${config.ws_port}`;
  const qrUrl    = tunnelUrl ?? lanUrl;

  if (!tunnelUrl && localIp) {
    logger.info(`No tunnel — using LAN address ${lanUrl} (phone and Mac must share the same Wi-Fi).`);
  }

  const qrPayload = buildQrPayload({
    tunnelUrl:  qrUrl,
    ntfyTopic:  config.ntfy_topic,
    deviceId:   config.device_id,
    publicKey:  keyPair.publicKey,
  });

  logger.info('Scan this QR code with the AgentVigil mobile app:');
  generateQrCode(qrPayload);
  logger.info('Waiting for the app to pair...');

  // ── Wait for pairing ────────────────────────────────────────────────────
  const device = await paired;
  config.paired_devices = [
    ...config.paired_devices.filter((d) => d.public_key !== device.public_key),
    device,
  ];
  await saveConfig(config);

  logger.success(`✅ Paired with AgentVigil (${device.name})`);

  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    printFcmSetupInstructions();
  }

  logger.info('Daily summary scheduled for 23:59 (local time).');

  logger.info('');
  logger.success('Setup complete!');
  logger.info('');
  logger.info('Next steps:');
  logger.info('  1. Scan the QR code above with AgentVigil on your phone');
  logger.info('  2. Download AgentVigil: https://agentvigil.stacktreelabs.com/');
  logger.info('  3. Start the daemon: npx agentvigil start');
  logger.info('');
  logger.info('To start automatically on login:');
  logger.info('  npx agentvigil install-autostart');
  logger.info('');

  logger.info('Staying alive as daemon — watching for Claude Code sessions (Ctrl-C to quit).');

  // ── Activate relay and run as daemon ────────────────────────────────────
  // Assigning `relay` here makes the WS server's onCommand / onHookEvent
  // callbacks live; sessions are now forwarded in real time.
  relay = new RelayHandler(wsServer, config.ntfy_topic);

  await runDaemon({
    wsServer,
    tunnelManager: tunnelUrl ? tunnelManager : undefined,
    ntfyTopic: config.ntfy_topic,
  });
}

function isNodeVersionSupported(version: string): boolean {
  const major = Number(version.replace(/^v/, '').split('.')[0]);
  return Number.isFinite(major) && major >= MIN_NODE_MAJOR_VERSION;
}

function printDryRunPlan(): void {
  logger.info('Dry run — no changes will be made. `setup` would:');
  logger.info('  1. Register Claude Code hooks in ~/.claude/settings.json (merged, never overwritten)');
  logger.info('  2. Generate an X25519 keypair and save it to ~/.agentvigil/keys.json');
  logger.info('  3. Start a local WebSocket server and display a pairing QR code');
  logger.info('  4. Start a cloudflared tunnel so the phone can pair from anywhere');
  logger.info('  5. After pairing, run as daemon (no need to run `start` separately)');
}
