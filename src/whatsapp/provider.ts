import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Credentials/config handed to every provider call (never stored on the provider). */
export interface WaConfig {
  phone_number_id: string;
  api_version: string;
  access_token: string;
  app_id?: string | null;
  app_secret?: string | null;
  /** WhatsApp Business Account id -- distinct from phone_number_id, needed for template
   * management (not ordinary message sending): stored since whatsapp_accounts was created, but
   * never surfaced here until now. */
  waba_id?: string | null;
}

export interface SendResult { success: boolean; provider_message_id: string | null; error: string | null }
export interface UploadResult { success: boolean; media_id: string | null; error: string | null }
export interface HeaderDocument { id: string; filename?: string | null }

/** Port of WhatsAppProviderInterface — swappable provider, Meta Cloud API is the only implementation. */
export interface WhatsAppProvider {
  sendTemplate(config: WaConfig, to: string, templateName: string, language: string, variables: string[], headerDocument?: HeaderDocument | null): Promise<SendResult>;
  sendText(config: WaConfig, to: string, text: string): Promise<SendResult>;
  sendMedia(config: WaConfig, to: string, mediaId: string, mediaType: string, caption?: string): Promise<SendResult>;
  uploadMedia(config: WaConfig, localFilePath: string, mimeType: string): Promise<UploadResult>;
  testConnection(config: WaConfig): Promise<{ success: boolean; error: string | null }>;
}

type FetchFn = typeof fetch;
type Raw = { success: true; data: any } | { success: false; error: string };

const GRAPH_HOST = 'https://graph.facebook.com';
const VERSION_PATTERN = /^v\d{1,3}\.\d$/;

/** Port of MetaCloudWhatsAppProvider. The access token is only ever used in the Authorization header. */
export class MetaCloudProvider implements WhatsAppProvider {
  constructor(private readonly fetchFn: FetchFn = fetch, private readonly timeoutMs = 20_000) {}

  private baseUrl(config: WaConfig): string {
    const version = config.api_version ?? '';
    if (!VERSION_PATTERN.test(version)) {
      throw new Error(`Configured Meta API version "${version}" doesn't look like a valid version string (expected e.g. "v21.0").`);
    }
    const id = config.phone_number_id ?? '';
    if (id === '') throw new Error('phone_number_id is required.');
    return `${GRAPH_HOST}/${version}/${encodeURIComponent(id)}`;
  }

  private async request(config: WaConfig, method: string, url: string, body?: unknown, form?: FormData): Promise<Raw> {
    const token = config.access_token ?? '';
    if (token === '') return { success: false, error: 'No access token configured for this WhatsApp account.' };
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let payload: string | FormData | undefined;
    if (form) payload = form;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
      text = await res.text();
    } catch (e) {
      return { success: false, error: `Could not reach Meta API: ${(e as Error).message}` };
    }
    let decoded: any = null;
    try { decoded = JSON.parse(text); } catch { /* non-JSON body */ }
    if (res.status >= 200 && res.status < 300 && decoded !== null && typeof decoded === 'object' && !('error' in decoded)) {
      return { success: true, data: decoded };
    }
    return { success: false, error: decoded?.error?.message ?? `Meta API request failed (HTTP ${res.status}).` };
  }

  private async send(config: WaConfig, body: unknown): Promise<SendResult> {
    let url: string;
    try { url = `${this.baseUrl(config)}/messages`; } catch (e) { return { success: false, provider_message_id: null, error: (e as Error).message }; }
    const r = await this.request(config, 'POST', url, body);
    if (!r.success) return { success: false, provider_message_id: null, error: r.error };
    return { success: true, provider_message_id: r.data?.messages?.[0]?.id ?? null, error: null };
  }

  sendTemplate(config: WaConfig, to: string, templateName: string, language: string, variables: string[], headerDocument: HeaderDocument | null = null) {
    const components: unknown[] = [];
    if (headerDocument && headerDocument.id) {
      const document: Record<string, string> = { id: headerDocument.id };
      if (headerDocument.filename) document.filename = headerDocument.filename; // array_filter drops empties
      components.push({ type: 'header', parameters: [{ type: 'document', document }] });
    }
    if (variables.length > 0) {
      components.push({ type: 'body', parameters: variables.map((v) => ({ type: 'text', text: String(v) })) });
    }
    return this.send(config, {
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: templateName, language: { code: language }, components },
    });
  }

  sendText(config: WaConfig, to: string, text: string) {
    return this.send(config, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
  }

  async sendMedia(config: WaConfig, to: string, mediaId: string, mediaType: string, caption = ''): Promise<SendResult> {
    if (mediaType !== 'image' && mediaType !== 'document') {
      return { success: false, provider_message_id: null, error: `Unsupported media type "${mediaType}".` };
    }
    const media: Record<string, string> = {};
    if (mediaId) media.id = mediaId;
    if (caption !== '') media.caption = caption;
    return this.send(config, { messaging_product: 'whatsapp', to, type: mediaType, [mediaType]: media });
  }

  async uploadMedia(config: WaConfig, localFilePath: string, mimeType: string): Promise<UploadResult> {
    let bytes: Buffer;
    try { bytes = await readFile(localFilePath); } catch { return { success: false, media_id: null, error: 'Local file not found.' }; }
    let url: string;
    try { url = `${this.baseUrl(config)}/media`; } catch (e) { return { success: false, media_id: null, error: (e as Error).message }; }
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), basename(localFilePath));
    const r = await this.request(config, 'POST', url, undefined, form);
    if (!r.success) return { success: false, media_id: null, error: r.error };
    return { success: true, media_id: r.data?.id ?? null, error: null };
  }

  async testConnection(config: WaConfig) {
    let url: string;
    try { url = this.baseUrl(config); } catch (e) { return { success: false, error: (e as Error).message }; }
    const r = await this.request(config, 'GET', url);
    return { success: r.success, error: r.success ? null : r.error };
  }
}
