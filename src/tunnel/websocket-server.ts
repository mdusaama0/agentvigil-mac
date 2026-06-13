import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { logger } from '../utils/logger.js';
import { decrypt, encrypt } from '../crypto/encryption.js';
import type { AgentEvent, FullSyncEvent, PhoneCommand } from '../types.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

export interface PairRequest {
  type: 'pair';
  pub_key: string;
  device_name: string;
}

export interface AgentVigilWsServerOptions {
  /** The phone's first message after scanning the QR arrives unencrypted as this. */
  onPairRequest?: (request: PairRequest, socket: WebSocket) => void;
  /** Decrypted phone commands (approve/deny/send_prompt), once a shared secret is known. */
  onCommand?: (command: PhoneCommand) => void;
  /** Supplies the current session list for the full_sync sent on connect. */
  getSessions?: () => AgentEvent[];
  /**
   * AgentEvents forwarded in-process by short-lived `agentvigil hook` CLI
   * invocations (see hook-handler.ts) — the only way they can reach the live
   * phone connection the daemon is holding. Requires a matching `localToken`.
   */
  onHookEvent?: (event: AgentEvent) => void;
  /** Shared secret only the Mac's own processes know (its X25519 secret key) — authenticates `hook_event` messages so the tunnel-exposed phone can't forge them. */
  localToken?: string;
}

export class AgentVigilWsServer {
  private readonly wss: WebSocketServer;
  private readonly getSessions: () => AgentEvent[];
  private readonly onPairRequest?: (request: PairRequest, socket: WebSocket) => void;
  private readonly onCommand?: (command: PhoneCommand) => void;
  private readonly onHookEvent?: (event: AgentEvent) => void;
  private readonly localToken?: string;

  private phoneSocket: WebSocket | null = null;
  private sharedSecret: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // The phone derives the shared secret from the QR-code public key as soon
  // as it scans it, and may send encrypted messages (e.g. register_fcm_token)
  // before its `pair` message has been processed here. Buffer those rather
  // than dropping them, and replay once pairing completes.
  private static readonly MAX_PENDING_MESSAGES = 10;
  private pendingMessages: string[] = [];

  constructor(private readonly port: number = 3847, options: AgentVigilWsServerOptions = {}) {
    this.wss = new WebSocketServer({ port });
    this.getSessions = options.getSessions ?? (() => []);
    this.onPairRequest = options.onPairRequest;
    this.onCommand = options.onCommand;
    this.onHookEvent = options.onHookEvent;
    this.localToken = options.localToken;
  }

  start(): void {
    this.wss.on('connection', (ws: WebSocket, request?: IncomingMessage) => {
      // Short-lived connections forwarded by `agentvigil hook` CLI invocations
      // (see hook-handler.ts) hit a dedicated path so they're never mistaken
      // for the phone — otherwise they'd overwrite `phoneSocket` and the real
      // phone connection would be silently orphaned when the hook's socket closes.
      if (request?.url?.startsWith('/hook')) {
        ws.on('message', (data: RawData) => {
          try {
            this.onMessage(data.toString());
          } catch (err) {
            logger.error('Error handling hook_event message', err);
          }
        });
        ws.on('error', (err) => logger.error('Hook connection WS error', err));
        return;
      }

      logger.info('Phone connected via tunnel');
      this.phoneSocket = ws;

      ws.on('message', (data: RawData) => {
        try {
          this.onMessage(data.toString());
        } catch (err) {
          logger.error('Error handling phone message — keeping socket open', err);
        }
      });
      ws.on('close', () => {
        logger.warn('Phone disconnected');
        if (this.phoneSocket === ws) this.phoneSocket = null;
      });
      ws.on('error', (err) => logger.error('WS error', err));

      this.sendFullSync();
    });

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    logger.success(`WS server listening on port ${this.port}`);
  }

  /** Records the shared secret derived for the currently-paired device (or clears it). */
  setSharedSecret(secret: string | undefined): void {
    this.sharedSecret = secret;
    if (!secret || this.pendingMessages.length === 0) return;

    const queued = this.pendingMessages;
    this.pendingMessages = [];
    for (const raw of queued) {
      logger.dim('Replaying a message received before pairing completed');
      this.onMessage(raw);
    }
  }

  /** The NaCl shared secret for the paired phone, or undefined if not yet paired. */
  getSharedSecret(): string | undefined {
    return this.sharedSecret;
  }

  onMessage(raw: string): void {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn('Received a malformed WS message — ignoring');
      return;
    }

    // Forwarded by a short-lived `agentvigil hook` CLI process — authenticated
    // with a local-only token (the Mac's own secret key) rather than the
    // phone's shared secret, since the hook process isn't "paired".
    if (parsed?.type === 'hook_event') {
      if (this.localToken && parsed.token === this.localToken) {
        this.onHookEvent?.(parsed.event as AgentEvent);
      } else {
        logger.warn('Rejected hook_event message with an invalid local token');
      }
      return;
    }

    // The pairing handshake is the one message that travels unencrypted.
    if (parsed?.type === 'pair') {
      if (this.phoneSocket) {
        try {
          this.onPairRequest?.(
            { type: 'pair', pub_key: parsed.pub_key, device_name: parsed.device_name },
            this.phoneSocket
          );
        } catch (err) {
          logger.error('Pairing handshake failed', err);
          this.phoneSocket.send(JSON.stringify({ type: 'pairing_error', message: String(err) }));
          // DO NOT close the socket — let the phone retry
        }
      }
      return;
    }

    if (!this.sharedSecret) {
      logger.dim('Received a message before pairing was established — queuing until pairing completes');
      this.pendingMessages.push(raw);
      if (this.pendingMessages.length > AgentVigilWsServer.MAX_PENDING_MESSAGES) {
        this.pendingMessages.shift();
      }
      return;
    }

    try {
      const decrypted = decrypt(parsed.payload, this.sharedSecret);
      const command = JSON.parse(decrypted) as { type: string; session_id: string; payload?: string };
      // full_sync_request is a WS-layer concern — respond immediately with
      // the current session snapshot rather than forwarding to the relay.
      if (command.type === 'full_sync_request') {
        logger.dim('full_sync_request from phone — sending snapshot');
        this.sendFullSync();
        return;
      }
      this.onCommand?.(command as PhoneCommand);
    } catch (err) {
      logger.error('Failed to decrypt phone message', err);
    }
  }

  sendEvent(event: AgentEvent): void {
    if (!this.isPhoneConnected || !this.sharedSecret) return;
    const encrypted = encrypt(JSON.stringify(event), this.sharedSecret);
    this.phoneSocket!.send(JSON.stringify({ payload: encrypted }));
  }

  sendFullSync(): void {
    const sessions = this.getSessions();
    const event: FullSyncEvent = {
      type: 'full_sync',
      session_id: 'full_sync',
      project_name: 'AgentVigil',
      cwd: '',
      agent: 'claude-code',
      message: `${sessions.length} active session(s)`,
      timestamp: new Date().toISOString(),
      sessions,
    };
    this.sendEvent(event);
  }

  get isPhoneConnected(): boolean {
    return this.phoneSocket?.readyState === WebSocket.OPEN;
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.phoneSocket?.close();
    this.phoneSocket = null;
    this.wss.close();
  }

  private sendHeartbeat(): void {
    if (!this.isPhoneConnected) return;
    this.sendEvent({
      type: 'heartbeat',
      session_id: 'heartbeat',
      project_name: 'AgentVigil',
      cwd: '',
      agent: 'claude-code',
      message: 'heartbeat',
      timestamp: new Date().toISOString(),
    });
  }
}
