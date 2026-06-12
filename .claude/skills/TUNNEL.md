# SKILL: Cloudflared Tunnel + WebSocket Server
# Read before touching tunnel-manager.ts or websocket-server.ts

## Architecture
```
Phone (AgentVigil app)
      ↕ WSS (encrypted)
Cloudflare Edge
      ↕ WS (encrypted, same payload)
cloudflared process (on Mac)
      ↕ WS (localhost)
AgentVigil WebSocket server (port 3847)
      ↕ in-process
Hook handler / session manager
```

## Local WebSocket Server (src/tunnel/websocket-server.ts)
```typescript
import { WebSocketServer, WebSocket } from 'ws';

export class AgentVigilWsServer {
  private wss: WebSocketServer;
  private phoneSocket: WebSocket | null = null;

  constructor(private port: number = 3847) {
    this.wss = new WebSocketServer({ port });
  }

  start(): void {
    this.wss.on('connection', (ws) => {
      logger.info('Phone connected via tunnel');
      this.phoneSocket = ws;

      ws.on('message', (data) => this.onMessage(data.toString()));
      ws.on('close', () => {
        logger.warn('Phone disconnected');
        this.phoneSocket = null;
      });
      ws.on('error', (err) => logger.error('WS error', err));

      // Send full state sync on connect
      this.sendFullSync();
    });

    logger.success(`WS server listening on port ${this.port}`);
  }

  sendEvent(event: AgentEvent): void {
    if (!this.phoneSocket || this.phoneSocket.readyState !== WebSocket.OPEN) return;
    const encrypted = encryption.encrypt(JSON.stringify(event));
    this.phoneSocket.send(JSON.stringify({ payload: encrypted }));
  }

  get isPhoneConnected(): boolean {
    return this.phoneSocket?.readyState === WebSocket.OPEN;
  }
}
```

## Cloudflared Manager (src/tunnel/tunnel-manager.ts)
```typescript
import { spawn, ChildProcess } from 'child_process';

export class TunnelManager {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;

  async start(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.process = spawn('cloudflared', [
        'tunnel', '--url', `http://localhost:${port}`,
        '--no-autoupdate', '--logfile', '/dev/null'
      ]);

      // URL comes from stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !this.tunnelUrl) {
          this.tunnelUrl = match[0].replace('https://', 'wss://');
          resolve(this.tunnelUrl);
        }
      });

      this.process.on('exit', (code) => {
        if (!this.tunnelUrl) reject(new Error(`cloudflared exited with code ${code}`));
      });

      // Timeout after 30s
      setTimeout(() => {
        if (!this.tunnelUrl) reject(new Error('Tunnel URL not received within 30s'));
      }, 30_000);
    });
  }

  stop(): void {
    this.process?.kill();
    this.tunnelUrl = null;
  }
}
```

## Checking cloudflared Installation
```typescript
export async function ensureCloudflared(): Promise<boolean> {
  try {
    await exec('which cloudflared');
    return true;
  } catch {
    logger.warn('cloudflared not found');
    logger.info('Install with: brew install cloudflared');
    logger.info('Or: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    return false;
  }
}
```

## Heartbeat
Send heartbeat every 30s to keep tunnel alive:
```typescript
setInterval(() => {
  if (wsServer.isPhoneConnected) {
    wsServer.sendEvent({ type: 'heartbeat', timestamp: new Date().toISOString() });
  }
}, 30_000);
```

## Reconnection (phone side handles this)
The Mac companion does NOT need reconnection logic — it's always the server.
The phone reconnects to the tunnel URL. If the tunnel URL changes (cloudflared restart),
the phone needs to re-scan the QR code. Keep this in mind for UX.

## Port Conflicts
If port 3847 is taken, try 3848, 3849, etc:
```typescript
async function findFreePort(start: number): Promise<number> {
  // try net.createServer().listen(port) — if EADDRINUSE, try port+1
}
```
