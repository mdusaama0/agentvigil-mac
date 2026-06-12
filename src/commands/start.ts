import { v4 as uuidv4 } from 'uuid';
import type { WebSocket } from 'ws';
import { logger } from '../utils/logger.js';
import { ensureCloudflared, getConfig, saveConfig } from '../utils/config.js';
import type { PairedDevice } from '../utils/config.js';
import { deriveSharedSecret, encrypt, loadOrCreateKeyPair } from '../crypto/encryption.js';
import { AgentVigilWsServer, type PairRequest } from '../tunnel/websocket-server.js';
import { TunnelManager } from '../tunnel/tunnel-manager.js';
import { RelayHandler } from '../relay/relay-handler.js';
import { getActiveSessions } from '../sessions/session-manager.js';
import {
  getLocalIPv4,
  runDaemon,
  toAgentEvent,
} from './daemon.js';

export async function runStart(): Promise<void> {
  logger.banner('AgentVigil');

  const config = await getConfig();

  if (config.paired_devices.length === 0) {
    logger.warn('No paired devices found — run `npx agentvigil setup` first.');
    return;
  }

  const keyPair       = await loadOrCreateKeyPair();
  const hasCloudflared = await ensureCloudflared();

  let wsServer!: AgentVigilWsServer;
  let relay!: RelayHandler;

  const handlePairRequest = (request: PairRequest, socket: WebSocket): void => {
    const sharedSecret = deriveSharedSecret(keyPair.secretKey, request.pub_key);
    wsServer.setSharedSecret(sharedSecret);

    const device: PairedDevice = {
      name:          request.device_name,
      device_id:     uuidv4(),
      public_key:    request.pub_key,
      shared_secret: sharedSecret,
      paired_at:     new Date().toISOString(),
    };

    const confirmation = encrypt(
      JSON.stringify({ type: 'paired', device_id: config.device_id }),
      sharedSecret,
    );
    socket.send(JSON.stringify({ payload: confirmation }));

    config.paired_devices = [
      ...config.paired_devices.filter((d) => d.public_key !== device.public_key),
      device,
    ];
    void saveConfig(config);
    logger.success(`Paired with a new device: ${device.name}`);
  };

  wsServer = new AgentVigilWsServer(config.ws_port, {
    getSessions: () => {
      // Deduplicate by cwd — poller and hook may both have created entries for
      // the same project.  Prefer blocked state so the permission card shows.
      const seen = new Set<string>();
      const deduped = getActiveSessions()
        .sort((a, b) => (a.state === 'blocked' ? -1 : b.state === 'blocked' ? 1 : 0))
        .filter(s => {
          if (seen.has(s.cwd)) return false;
          seen.add(s.cwd);
          return true;
        });
      logger.info(`Full sync: sending ${deduped.length} active session(s) to phone`);
      return deduped.map(toAgentEvent);
    },
    onPairRequest: handlePairRequest,
    onCommand:    (command) => { void relay.handlePhoneCommand(command); },
    onHookEvent:  (event)   => { void relay.handleAgentEvent(event); },
    localToken:   keyPair.secretKey,
  });
  relay = new RelayHandler(wsServer, config.ntfy_topic);

  // Resume the most recently paired device without requiring a re-scan.
  wsServer.setSharedSecret(config.paired_devices.at(-1)?.shared_secret);
  wsServer.start();

  // ── Tunnel ──────────────────────────────────────────────────────────────
  let tunnelManager: TunnelManager | undefined;

  if (hasCloudflared) {
    tunnelManager = new TunnelManager();
    try {
      const tunnelUrl = await tunnelManager.start(config.ws_port);
      config.tunnel_url = tunnelUrl;
      await saveConfig(config);
      logger.info(`Tunnel: ${tunnelUrl}`);
    } catch (err) {
      logger.warn('Could not start cloudflared tunnel — continuing with ntfy notifications only', err);
      tunnelManager = undefined;
    }
  } else {
    const localIp = getLocalIPv4();
    const lanUrl  = localIp ? `ws://${localIp}:${config.ws_port}` : undefined;
    logger.warn('cloudflared is not installed — continuing with ntfy notifications only.');
    if (lanUrl) logger.info(`LAN address (same Wi-Fi only): ${lanUrl}`);
  }

  await runDaemon({ wsServer, tunnelManager, ntfyTopic: config.ntfy_topic });
}
