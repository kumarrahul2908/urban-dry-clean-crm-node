import type { Db } from '../db/pool.js';

/** Port of NotificationService::notify() — in-app notification row; never throws. */
export class NotificationService {
  constructor(private readonly db: Db, private readonly log: (m: string) => void = console.error) {}

  async notify(templateKey: string, message: string, customerId: number | null = null, orderId: number | null = null, userId: number | null = null): Promise<void> {
    try {
      await this.db.execute(
        `INSERT INTO notification_logs (customer_id, order_id, user_id, template_key, channel, message, status, is_read)
         VALUES (?,?,?,?, 'In-App', ?, 'Sent', 0)`,
        [customerId, orderId, userId, templateKey, message],
      );
    } catch (e) {
      this.log(`NotificationService::notify failed: ${(e as Error).message}`);
    }
  }
}
