import qrcodeTerminal from 'qrcode-terminal';

const QR_PAYLOAD_VERSION = 1;
const EXPIRY_MS = 5 * 60 * 1000;

export interface QrPayload {
  v: typeof QR_PAYLOAD_VERSION;
  wss: string;
  ntfy: string;
  device_id: string;
  pub_key: string;
  expires: string;
}

export interface QrPayloadInput {
  tunnelUrl: string;
  ntfyTopic: string;
  deviceId: string;
  publicKey: string;
}

export function buildQrPayload(input: QrPayloadInput): QrPayload {
  return {
    v: QR_PAYLOAD_VERSION,
    wss: input.tunnelUrl,
    ntfy: input.ntfyTopic,
    device_id: input.deviceId,
    pub_key: input.publicKey,
    expires: new Date(Date.now() + EXPIRY_MS).toISOString(),
  };
}

export function generateQrCode(payload: QrPayload): void {
  qrcodeTerminal.generate(JSON.stringify(payload), { small: true });
}
