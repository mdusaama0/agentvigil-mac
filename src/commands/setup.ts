import { v4 as uuidv4 } from 'uuid';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { ensureCloudflared, getConfig, saveConfig } from '../utils/config.js';
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

  if (!isNodeVersionSupported(process.version)) {
    logger.error(
      `Node.js >= ${MIN_NODE_MAJOR_VERSION} is required (found ${process.version}) — please upgrade and re-run setup.`
    );
    return;
  }

  const hasCloudflared = await ensureCloudflared();

  if (options.dryRun) {
    printDryRunPlan(hasCloudflared);
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

  if (hasCloudflared) {
    try {
      tunnelUrl = await tunnelManager.start(config.ws_port);
    } catch (err) {
      logger.warn('Could not start cloudflared tunnel — pairing will only work on the local network', err);
    }
  } else {
    logger.warn('cloudflared is not installed — pairing requires the phone to be on the same Wi-Fi network.');
    logger.info('Install with: brew install cloudflared');
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

function printDryRunPlan(hasCloudflared: boolean): void {
  logger.info('Dry run — no changes will be made. `setup` would:');
  logger.info('  1. Register Claude Code hooks in ~/.claude/settings.json (merged, never overwritten)');
  logger.info('  2. Generate an X25519 keypair and save it to ~/.agentvigil/keys.json');
  logger.info('  3. Start a local WebSocket server and display a pairing QR code');
  logger.info(
    hasCloudflared
      ? '  4. Start a cloudflared tunnel so the phone can pair from anywhere'
      : '  4. Skip the tunnel (cloudflared not found) — pairing would be limited to the local network'
  );
  logger.info('  5. After pairing, run as daemon (no need to run `start` separately)');
}
