/** Port of NotificationService::notify() — in-app notification row; never throws. */
export class NotificationService {
    db;
    log;
    constructor(db, log = console.error) {
        this.db = db;
        this.log = log;
    }
    async notify(templateKey, message, customerId = null, orderId = null, userId = null) {
        try {
            await this.db.execute(`INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, message, status, is_read)
         VALUES (?,?,?,?, 'In-App', ?, 'Sent', 0)`, [customerId, orderId, userId, templateKey, message]);
        }
        catch (e) {
            this.log(`NotificationService::notify failed: ${e.message}`);
        }
    }
}
