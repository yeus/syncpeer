import * as tls from 'tls';
import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * Options required for establishing a TLS connection to a Syncthing peer.
 */
export interface NodeTransportOptions {
  host: string;
  port: number;
  /**
   * Path to the client certificate (PEM).  This is the same certificate used by
   * Syncthing itself.  You may also pass a Buffer containing the PEM data.
   */
  cert: string | Buffer;
  /**
   * Path to the client private key (PEM) or the key contents.
   */
  key: string | Buffer;
  /**
   * Optional CA certificate(s) to trust.  If omitted the TLS layer will not
   * verify the peer certificate and you must rely on the device ID check.
   */
  ca?: string | Buffer;
  /**
   * Optional expected device ID of the remote.  If provided the SHA‑256 based
   * ID of the peer certificate will be computed and compared against this
   * value (case insensitive).  If they do not match an error is thrown.
   */
  expectedDeviceId?: string;
}

/**
 * Compute the SHA‑256 hash of a certificate and return a base32 encoded string.
 * Syncthing device IDs are derived by taking the SHA‑256 digest of the DER
 * certificate and then encoding it using base32 without padding.  This
 * implementation omits the optional check digits and grouping dashes.
 */
export function computeDeviceId(certRaw: Buffer): string {
  const digest = crypto.createHash('sha256').update(certRaw).digest();
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Establish a TLS connection using the provided options.  The returned socket
 * will have `setKeepAlive(true)` enabled.  After the connection is
 * established, the peer certificate is hashed and compared against
 * `expectedDeviceId` if provided.
 */
export async function connectTLS(opts: NodeTransportOptions): Promise<tls.TLSSocket> {
  const { host, port, cert, key, ca, expectedDeviceId } = opts;
  const socket = tls.connect({
    host,
    port,
    cert: typeof cert === 'string' ? fs.readFileSync(cert) : cert,
    key: typeof key === 'string' ? fs.readFileSync(key) : key,
    ca: ca ? (typeof ca === 'string' ? fs.readFileSync(ca) : ca) : undefined,
    rejectUnauthorized: false,
  });
  socket.setKeepAlive(true);
  await new Promise<void>((resolve, reject) => {
    socket.once('secureConnect', () => resolve());
    socket.once('error', (err) => reject(err));
  });
  // Compute the device ID of the peer certificate
  const peerCert = socket.getPeerCertificate(true);
  if (!peerCert || !peerCert.raw) {
    throw new Error('Failed to obtain peer certificate');
  }
  const deviceId = computeDeviceId(peerCert.raw);
  if (expectedDeviceId) {
    // Compare ignoring case and dashes
    const sanitize = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (sanitize(deviceId) !== sanitize(expectedDeviceId)) {
      socket.destroy();
      throw new Error(`Remote device ID mismatch; expected ${expectedDeviceId}, got ${deviceId}`);
    }
  }
  return socket;
}