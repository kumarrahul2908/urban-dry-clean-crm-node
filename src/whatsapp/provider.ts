import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

/** Credentials/config handed to every provider call (never stored on the provider). */
export interface WaConfig {
  phone_number_id: string;
  api_version: string;
  access_token: string;
  app_id?: string | null;
  app_secret?: string | null;
  /** needed only for template management (POST /{waba_id}/message_templates) */
  waba_id?: string | null;
}

export interface SendResult { success: boolean; provider_message_id: string | null; error: string | null }
export interface UploadResult { success: boolean; media_id: string | null; error: string | null }
export interface TemplateSubmitResult { success: boolean; status: string | null; id?: string | null; error: string | null }
export interface HeaderDocument { id: string; filename?: string | null }

/** Port of WhatsAppProviderInterface — swappable provider, Meta Cloud API is the only implementation. */
export interface WhatsAppProvider {
  sendTemplate(config: WaConfig, to: string, templateName: string, language: string, variables: string[], headerDocument?: HeaderDocument | null): Promise<SendResult>;
  sendText(config: WaConfig, to: string, text: string): Promise<SendResult>;
  sendMedia(config: WaConfig, to: string, mediaId: string, mediaType: string, caption?: string): Promise<SendResult>;
  uploadMedia(config: WaConfig, localFilePath: string, mimeType: string): Promise<UploadResult>;
  testConnection(config: WaConfig): Promise<{ success: boolean; error: string | null }>;
  /** DOCUMENT-header template (example PDF uploaded via Meta's Resumable Upload API first) submitted for review. */
  createDocumentTemplate(config: WaConfig, name: string, language: string, category: string, bodyText: string, bodyExampleValues: string[], sampleFilePath: string, sampleMimeType: string): Promise<TemplateSubmitResult>;
  /** Text template (optional {{n}} body variables) submitted for Meta review. */
  createTextTemplate(config: WaConfig, name: string, language: string, category: string, bodyText: string, bodyExampleValues: string[]): Promise<TemplateSubmitResult>;
  /** Review status of every template on the account: name -> {status,id,reason}. */
  listTemplateStatuses(config: WaConfig): Promise<{ success: boolean; templates: Record<string, { status: string | null; id: string | null; reason: string | null }>; error: string | null }>;
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

  // ---- template management (Rahul, 21 Nov 2026) -------------------------------------------------
  async createDocumentTemplate(config: WaConfig, name: string, language: string, category: string, bodyText: string, bodyExampleValues: string[], sampleFilePath: string, sampleMimeType: string): Promise<TemplateSubmitResult> {
    const wabaId = config.waba_id ?? '';
    if (wabaId === '') return { success: false, status: null, error: 'No WABA ID configured for this account -- needed for template management (different from the phone_number_id used for sending).' };
    const appId = config.app_id ?? '';
    if (appId === '') return { success: false, status: null, error: 'No app_id configured for this account -- needed for the example-file upload.' };
    const up = await this.uploadTemplateExampleFile(config, appId, sampleFilePath, sampleMimeType);
    if (!up.success) return { success: false, status: null, error: `Example file upload failed: ${up.error}` };
    const body = {
      name, language, category,
      components: [
        { type: 'HEADER', format: 'DOCUMENT', example: { header_handle: [up.handle] } },
        { type: 'BODY', text: bodyText, example: { body_text: [bodyExampleValues] } },
      ],
    };
    const version = config.api_version ?? '';
    if (!VERSION_PATTERN.test(version)) return { success: false, status: null, error: `Configured Meta API version "${version}" doesn't look valid.` };
    const r = await this.request(config, 'POST', `${GRAPH_HOST}/${version}/${encodeURIComponent(wabaId)}/message_templates`, body);
    if (!r.success) return { success: false, status: null, error: r.error };
    return { success: true, status: r.data?.status ?? 'PENDING', error: null };
  }

  async createTextTemplate(config: WaConfig, name: string, language: string, category: string, bodyText: string, bodyExampleValues: string[]): Promise<TemplateSubmitResult> {
    const wabaId = config.waba_id ?? '';
    if (wabaId === '') return { success: false, status: null, id: null, error: 'No WABA ID configured for this account -- needed for template management.' };
    const version = config.api_version ?? '';
    if (!VERSION_PATTERN.test(version)) return { success: false, status: null, id: null, error: `Configured Meta API version "${version}" doesn't look valid.` };
    const bodyComponent: Record<string, unknown> = { type: 'BODY', text: bodyText };
    if (bodyExampleValues.length) bodyComponent.example = { body_text: [bodyExampleValues] };
    const r = await this.request(config, 'POST', `${GRAPH_HOST}/${version}/${encodeURIComponent(wabaId)}/message_templates`, { name, language, category, components: [bodyComponent] });
    if (!r.success) return { success: false, status: null, id: null, error: r.error };
    return { success: true, status: r.data?.status ?? 'PENDING', id: r.data?.id ?? null, error: null };
  }

  async listTemplateStatuses(config: WaConfig) {
    const wabaId = config.waba_id ?? '';
    const version = config.api_version ?? '';
    if (wabaId === '' || !VERSION_PATTERN.test(version)) return { success: false, templates: {}, error: 'WABA ID / API version not configured.' };
    const r = await this.request(config, 'GET', `${GRAPH_HOST}/${version}/${encodeURIComponent(wabaId)}/message_templates?fields=name,status,id,rejected_reason&limit=200`);
    if (!r.success) return { success: false, templates: {}, error: r.error };
    const out: Record<string, { status: string | null; id: string | null; reason: string | null }> = {};
    for (const t of (Array.isArray(r.data?.data) ? r.data.data : [])) {
      if (t?.name === undefined || t?.name === null) continue;
      out[String(t.name)] = { status: t.status ?? null, id: t.id ?? null, reason: t.rejected_reason ?? null };
    }
    return { success: true, templates: out, error: null };
  }

  /** Meta's Resumable Upload API: start a session (tied to the APP), then upload the bytes -> reusable file "handle" for a template header example. */
  private async uploadTemplateExampleFile(config: WaConfig, appId: string, filePath: string, mimeType: string): Promise<{ success: boolean; handle: string | null; error: string | null }> {
    let bytes: Buffer;
    try { bytes = await readFile(filePath); } catch { return { success: false, handle: null, error: 'Sample file not found.' }; }
    const token = config.access_token ?? '';
    if (token === '') return { success: false, handle: null, error: 'No access token configured.' };
    const sessionUrl = `${GRAPH_HOST}/${config.api_version ?? 'v21.0'}/${encodeURIComponent(appId)}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(mimeType)}&access_token=${encodeURIComponent(token)}`;
    let sessionData: any;
    try {
      const res = await this.fetchFn(sessionUrl, { method: 'POST', body: '', signal: AbortSignal.timeout(20_000) });
      sessionData = JSON.parse(await res.text());
    } catch (e) { return { success: false, handle: null, error: `Could not start upload session: ${(e as Error).message}` }; }
    const sessionId = sessionData?.id ?? null;
    if (!sessionId) return { success: false, handle: null, error: sessionData?.error?.message ?? 'Could not start upload session.' };
    // The session id already carries its own "?sig=..." suffix: used as-is, NOT url-encoded and not version-prefixed.
    let uploadData: any;
    try {
      const res = await this.fetchFn(`${GRAPH_HOST}/${sessionId}`, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_offset: '0' }, body: new Uint8Array(bytes), signal: AbortSignal.timeout(30_000) });
      uploadData = JSON.parse(await res.text());
    } catch (e) { return { success: false, handle: null, error: `Could not upload example file: ${(e as Error).message}` }; }
    const handle = uploadData?.h ?? null;
    if (!handle) return { success: false, handle: null, error: uploadData?.error?.message ?? 'Upload did not return a file handle.' };
    return { success: true, handle, error: null };
  }
}
