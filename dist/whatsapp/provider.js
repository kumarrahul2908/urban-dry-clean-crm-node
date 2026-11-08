import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
const GRAPH_HOST = 'https://graph.facebook.com';
const VERSION_PATTERN = /^v\d{1,3}\.\d$/;
/** Port of MetaCloudWhatsAppProvider. The access token is only ever used in the Authorization header. */
export class MetaCloudProvider {
    fetchFn;
    timeoutMs;
    constructor(fetchFn = fetch, timeoutMs = 20_000) {
        this.fetchFn = fetchFn;
        this.timeoutMs = timeoutMs;
    }
    baseUrl(config) {
        const version = config.api_version ?? '';
        if (!VERSION_PATTERN.test(version)) {
            throw new Error(`Configured Meta API version "${version}" doesn't look like a valid version string (expected e.g. "v21.0").`);
        }
        const id = config.phone_number_id ?? '';
        if (id === '')
            throw new Error('phone_number_id is required.');
        return `${GRAPH_HOST}/${version}/${encodeURIComponent(id)}`;
    }
    async request(config, method, url, body, form) {
        const token = config.access_token ?? '';
        if (token === '')
            return { success: false, error: 'No access token configured for this WhatsApp account.' };
        const headers = { Authorization: `Bearer ${token}` };
        let payload;
        if (form)
            payload = form;
        else if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        let res;
        let text;
        try {
            res = await this.fetchFn(url, { method, headers, body: payload, signal: AbortSignal.timeout(this.timeoutMs) });
            text = await res.text();
        }
        catch (e) {
            return { success: false, error: `Could not reach Meta API: ${e.message}` };
        }
        let decoded = null;
        try {
            decoded = JSON.parse(text);
        }
        catch { /* non-JSON body */ }
        if (res.status >= 200 && res.status < 300 && decoded !== null && typeof decoded === 'object' && !('error' in decoded)) {
            return { success: true, data: decoded };
        }
        return { success: false, error: decoded?.error?.message ?? `Meta API request failed (HTTP ${res.status}).` };
    }
    async send(config, body) {
        let url;
        try {
            url = `${this.baseUrl(config)}/messages`;
        }
        catch (e) {
            return { success: false, provider_message_id: null, error: e.message };
        }
        const r = await this.request(config, 'POST', url, body);
        if (!r.success)
            return { success: false, provider_message_id: null, error: r.error };
        return { success: true, provider_message_id: r.data?.messages?.[0]?.id ?? null, error: null };
    }
    sendTemplate(config, to, templateName, language, variables, headerDocument = null) {
        const components = [];
        if (headerDocument && headerDocument.id) {
            const document = { id: headerDocument.id };
            if (headerDocument.filename)
                document.filename = headerDocument.filename; // array_filter drops empties
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
    sendText(config, to, text) {
        return this.send(config, { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
    }
    async sendMedia(config, to, mediaId, mediaType, caption = '') {
        if (mediaType !== 'image' && mediaType !== 'document') {
            return { success: false, provider_message_id: null, error: `Unsupported media type "${mediaType}".` };
        }
        const media = {};
        if (mediaId)
            media.id = mediaId;
        if (caption !== '')
            media.caption = caption;
        return this.send(config, { messaging_product: 'whatsapp', to, type: mediaType, [mediaType]: media });
    }
    async uploadMedia(config, localFilePath, mimeType) {
        let bytes;
        try {
            bytes = await readFile(localFilePath);
        }
        catch {
            return { success: false, media_id: null, error: 'Local file not found.' };
        }
        let url;
        try {
            url = `${this.baseUrl(config)}/media`;
        }
        catch (e) {
            return { success: false, media_id: null, error: e.message };
        }
        const form = new FormData();
        form.set('messaging_product', 'whatsapp');
        form.set('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), basename(localFilePath));
        const r = await this.request(config, 'POST', url, undefined, form);
        if (!r.success)
            return { success: false, media_id: null, error: r.error };
        return { success: true, media_id: r.data?.id ?? null, error: null };
    }
    async testConnection(config) {
        let url;
        try {
            url = this.baseUrl(config);
        }
        catch (e) {
            return { success: false, error: e.message };
        }
        const r = await this.request(config, 'GET', url);
        return { success: r.success, error: r.success ? null : r.error };
    }
}
