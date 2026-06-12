import { spawn, type ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const TUNNEL_URL_TIMEOUT_MS = 30_000;

export class TunnelManager {
  private process: ChildProcess | null = null;
  private tunnelUrl: string | null = null;

  async start(port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout>;

      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        action();
      };

      this.process = spawn('cloudflared', [
        'tunnel',
        '--url',
        `http://localhost:${port}`,
        '--no-autoupdate',
        '--logfile',
        '/dev/null',
      ]);

      this.process.stderr?.on('data', (data: Buffer) => {
        const match = data.toString().match(TUNNEL_URL_PATTERN);
        if (match && !this.tunnelUrl) {
          this.tunnelUrl = match[0].replace('https://', 'wss://');
          logger.success(`Tunnel established: ${this.tunnelUrl}`);
          settle(() => resolve(this.tunnelUrl!));
        }
      });

      this.process.on('exit', (code) => {
        if (!this.tunnelUrl) {
          settle(() => reject(new Error(`cloudflared exited with code ${code}`)));
        }
      });

      this.process.on('error', (err) => {
        settle(() => reject(err));
      });

      timeoutHandle = setTimeout(() => {
        settle(() => reject(new Error('Tunnel URL not received within 30s')));
      }, TUNNEL_URL_TIMEOUT_MS);
    });
  }

  getTunnelUrl(): string | null {
    return this.tunnelUrl;
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
    this.tunnelUrl = null;
  }
}
