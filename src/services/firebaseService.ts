import { createSign } from 'node:crypto';
import type { Db } from '../db/pool.js';
import type { Crypto } from '../lib/crypto.js';
import { getSetting } from './settings.js';

type Row = Record<string, any>;
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Port of includes/FirebaseService.php: push notifications through Firebase Cloud Messaging's HTTP v1 API. A service account's private
 * key signs a JWT that is exchanged for a short-lived OAuth2 token -- no firebase-admin SDK. The service-account JSON is stored
 * ENCRYPTED in the settings table (same Crypto helper WhatsApp's credentials use).
 */
export class FirebaseService {
  constructor(private readonly db: Db, private readonly crypto: Crypto, private readonly fetchFn: typeof fetch = fetch, private readonly log: (m: string) => void = console.error) {}

  /** The decrypted service account, or null when not configured / unreadable. */
  async getServiceAccount(): Promise<Row | null> {
    const encrypted = String((await getSetting(this.db, 'firebase_service_account_encrypted', '')) ?? '');
    if (encrypted === '') return null;
    let json: string;
    try { json = this.crypto.decrypt(encrypted); } catch (e) { this.log(`FirebaseService::getServiceAccount decrypt failed: ${(e as Error).message}`); return null; }
    try { const d = JSON.parse(json); return d && typeof d === 'object' && !Array.isArray(d) ? d : null; } catch { return null; }
  }

  /** Signs a JWT with the service account's private key and exchanges it for a 1-hour access token scoped to Firebase Messaging; null on any failure. */
  private async getAccessToken(sa: Row | null): Promise<string | null> {
    if (!sa || !sa.private_key || !sa.client_email) return null;
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now }));
    const signingInput = `${header}.${claims}`;
    let signature: Buffer;
    try { signature = createSign('RSA-SHA256').update(signingInput).sign(String(sa.private_key)); } catch { this.log('FirebaseService: openssl_sign failed -- check private_key format.'); return null; }
    const jwt = `${signingInput}.${b64url(signature)}`;
    try {
      const res = await this.fetchFn('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(), signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (res.status !== 200) { this.log(`FirebaseService: token exchange failed, HTTP ${res.status}: ${text}`); return null; }
      return JSON.parse(text)?.access_token ?? null;
    } catch (e) { this.log(`FirebaseService: token exchange failed: ${(e as Error).message}`); return null; }
  }

  /**
   * One push to one device token. A pure 'data' message (no 'notification' key) always reaches the app's onMessageReceived(), foreground or
   * background, so the app builds the notification AND its tap target itself. Dead tokens (404/UNREGISTERED) are removed.
   */
  async sendPushToToken(deviceToken: string, title: string, body: string, data: Record<string, unknown> = {}): Promise<boolean> {
    const sa = await this.getServiceAccount();
    const accessToken = await this.getAccessToken(sa);
    if (!sa || !accessToken || !sa.project_id) return false;
    const payload = { message: { token: deviceToken, data: Object.fromEntries(Object.entries({ ...data, title, body }).map(([k, v]) => [k, String(v ?? '')])) } };
    let status = 0; let raw = '';
    try {
      const res = await this.fetchFn(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      });
      status = res.status; raw = await res.text();
    } catch (e) { this.log(`FirebaseService::sendPushToToken failed: ${(e as Error).message}`); return false; }
    if (status !== 200) {
      this.log(`FirebaseService::sendPushToToken failed, HTTP ${status}: ${raw}`);
      if (status === 404 || raw.includes('UNREGISTERED')) { try { await this.db.execute('DELETE FROM fcm_tokens WHERE device_token = ?', [deviceToken]); } catch { /* best-effort */ } }
      return false;
    }
    return true;
  }

  /** Pushes to every registered device of every active staff member with billing.view (the permission the WhatsApp Messages feature needs). */
  async sendPushToAllStaff(title: string, body: string, data: Record<string, unknown> = {}): Promise<void> {
    if (!(await this.getServiceAccount())) return; // not configured yet -- silently skip, never fatal
    let tokens: string[];
    try {
      tokens = (await this.db.query<Row>(
        `SELECT DISTINCT ft.device_token FROM fcm_tokens ft
         JOIN users u ON u.id = ft.user_id AND u.is_active = 1
         JOIN role_permissions rp ON rp.role_id = u.role_id
         JOIN permissions p ON p.id = rp.permission_id AND p.permission_key = 'billing.view'`)).map((r) => String(r.device_token));
    } catch (e) { this.log(`FirebaseService::sendPushToAllStaff token lookup failed: ${(e as Error).message}`); return; }
    for (const t of tokens) await this.sendPushToToken(t, title, body, data);
  }
}
