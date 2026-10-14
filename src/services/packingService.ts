import { randomBytes } from 'node:crypto';
import type { AuditLog } from '../audit/auditLog.js';
import type { Db } from '../db/pool.js';
import { getSetting } from './settings.js';

type Raw = Record<string, any>;

/** Port of includes/PackingService.php: declares packages for an order and tracks sticker prints. */
export class PackingService {
  constructor(private readonly db: Db, private readonly audit: AuditLog) {}

  async buildPackageBarcode(orderNumber: string, packageNumber: number): Promise<string> {
    const padding = Math.max(1, parseInt((await getSetting(this.db, 'garment_seq_padding', '2')) ?? '2', 10) || 0);
    return `${orderNumber}-PKG-${String(packageNumber).padStart(padding, '0')}`;
  }

  async createPackages(orderId: number, additional: number, garmentCount: number, userId: number, ip: string | null = null) {
    if (additional <= 0) return { success: false as const, errors: ['Number of packages must be at least 1.'] };
    const [o] = await this.db.query<Raw>('SELECT order_number FROM orders WHERE id = ?', [orderId]);
    if (!o || !o.order_number) return { success: false as const, errors: ['Order not found.'] };
    try {
      return await this.db.tx(async (t) => {
        const [m] = await t.query<Raw>('SELECT COALESCE(MAX(package_number), 0) AS m FROM packing WHERE order_id = ? FOR UPDATE', [orderId]);
        const currentMax = Number(m!.m);
        const newTotal = currentMax + additional;
        await t.execute('UPDATE packing SET total_packages = ? WHERE order_id = ?', [newTotal, orderId]);
        const ids: number[] = [];
        for (let i = 1; i <= additional; i++) {
          const n = currentMax + i;
          const r = await t.execute('INSERT INTO packing (order_id, package_number, total_packages, garment_count, barcode_value, qr_token, created_by) VALUES (?,?,?,?,?,?,?)',
            [orderId, n, newTotal, garmentCount, await this.buildPackageBarcode(String(o.order_number), n), randomBytes(16).toString('hex'), userId]);
          ids.push(r.insertId);
        }
        await this.audit.using(t).record({ action: 'create', module: 'packing', recordId: String(orderId), newValue: { packages_added: additional, total_packages: newTotal }, userId, ip });
        return { success: true as const, package_ids: ids, total_packages: newTotal };
      });
    } catch (e) {
      return { success: false as const, errors: ['Could not create packages: ' + (e as Error).message] };
    }
  }

  async recordPrint(packageId: number, userId: number, ip: string | null = null): Promise<void> {
    const [pkg] = await this.db.query<Raw>('SELECT * FROM packing WHERE id = ?', [packageId]);
    if (!pkg) return;
    const isReprint = Number(pkg.printed_count) > 0;
    await this.db.execute("UPDATE packing SET printed_count = printed_count + 1, last_printed_at = NOW(), last_printed_by = ?, status = 'Printed' WHERE id = ?", [userId, packageId]);
    await this.audit.record({ action: isReprint ? 'reprint' : 'print', module: 'packing', recordId: String(pkg.order_id), newValue: { package_id: packageId, package_number: pkg.package_number, printed_count: Number(pkg.printed_count) + 1 }, userId, ip });
  }
}
