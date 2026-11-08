import { createHash, randomBytes } from 'node:crypto';
import { getSetting } from './settings.js';
export const RESET_GENERIC = 'If these details match an account with a mobile number, a reset link has been sent on WhatsApp. The link is valid for 60 minutes.';
export const RESET_NOT_SET_UP = 'Password reset by WhatsApp is not set up yet. Please ask your administrator to reset your password.';
/** Port of includes/PasswordResetService.php. The emailed link still targets the PHP web app's reset page (APP_URL). */
export class PasswordResetService {
    db;
    wa;
    audit;
    appUrl;
    constructor(db, wa, audit, appUrl) {
        this.db = db;
        this.wa = wa;
        this.audit = audit;
        this.appUrl = appUrl;
    }
    async request(identifier, ip = null) {
        const template = ((await getSetting(this.db, 'password_reset_wa_template', '')) ?? '').trim();
        if (template === '')
            return { success: true, configured: false, message: RESET_NOT_SET_UP };
        identifier = identifier.trim();
        const generic = { success: true, configured: true, message: RESET_GENERIC };
        if (identifier === '' || Array.from(identifier).length > 150)
            return generic;
        const digits = identifier.replace(/\D+/g, '');
        const params = [identifier, identifier];
        let sql = "SELECT id, full_name, mobile, (reset_token_expires > DATE_ADD(NOW(), INTERVAL 55 MINUTE)) AS recently_sent FROM users WHERE is_active = 1 AND (username = ? OR email = ?";
        if (digits.length >= 10) {
            sql += " OR RIGHT(REGEXP_REPLACE(COALESCE(mobile,''), '[^0-9]', ''), 10) = ?";
            params.push(digits.slice(-10));
        }
        sql += ') LIMIT 2';
        const matches = await this.db.query(sql, params);
        if (matches.length !== 1)
            return generic;
        const user = matches[0];
        if ((user.mobile ?? '').trim() === '')
            return generic;
        if (Number(user.recently_sent) === 1)
            return generic;
        const raw = randomBytes(32).toString('hex');
        await this.db.execute('UPDATE users SET reset_token = ?, reset_token_expires = DATE_ADD(NOW(), INTERVAL 60 MINUTE) WHERE id = ?', [createHash('sha256').update(raw).digest('hex'), user.id]);
        const link = `${this.appUrl.replace(/\/+$/, '')}/modules/auth/reset-password.php?token=${raw}`;
        const name = (user.full_name ?? '').trim() !== '' ? user.full_name : 'there';
        const language = ((await getSetting(this.db, 'password_reset_wa_language', 'en')) ?? '').trim() || 'en';
        const send = await this.wa.sendTemplateNow(user.mobile, template, language, [name, link], 'password_reset', Number(user.id), 'Password reset link sent');
        await this.audit.record({ action: 'password_reset_request', module: 'auth', recordId: String(user.id), newValue: { channel: 'WhatsApp', sent: !!send.success }, userId: Number(user.id), ip });
        return generic;
    }
}
