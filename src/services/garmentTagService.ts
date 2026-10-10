import { randomBytes } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { getSetting } from './settings.js';

export interface BarcodeRow {
  id: number; barcode_value: string; qr_token: string; short_qr_payload: string | null;
  order_id: number; order_item_id?: number | null; laundry_garment_id?: number | null; item_sequence: number;
}

/** Port of GarmentTagService (barcode + tag creation). Pass a transaction Db to join it. */
export class GarmentTagService {
  constructor(private readonly db: Db) {}

  private async padding(): Promise<number> {
    return Math.max(1, parseInt((await getSetting(this.db, 'garment_seq_padding', '2')) ?? '2', 10) || 0);
  }

  async buildIdentifier(orderNumber: string, sequence: number): Promise<string> {
    return `${orderNumber}-${String(sequence).padStart(await this.padding(), '0')}`;
  }

  private async buildShortQrPayload(shortOrderCode: string | null, sequence: number): Promise<string | null> {
    if (shortOrderCode === null) return null;
    return `${shortOrderCode}-${String(sequence).padStart(await this.padding(), '0')}`;
  }

  private async insertBarcode(kind: 'item' | 'laundry', orderId: number, refId: number, sequence: number, barcodeValue: string, shortQr: string | null) {
    const col = kind === 'item' ? 'order_item_id' : 'laundry_garment_id';
    for (let attempt = 1; ; attempt++) {
      const qrToken = randomBytes(16).toString('hex'); // 32 hex chars -> CHAR(32)
      try {
        const r = await this.db.execute(
          `INSERT INTO barcodes (barcode_value, qr_token, short_qr_payload, order_id, ${col}, item_sequence) VALUES (?,?,?,?,?,?)`,
          [barcodeValue, qrToken, shortQr, orderId, refId, sequence],
        );
        return { id: r.insertId, qrToken };
      } catch (e) {
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY' && attempt < 5) continue;
        throw e;
      }
    }
  }

  async generateForItem(orderId: number, orderNumber: string, orderItemId: number, sequence: number): Promise<BarcodeRow> {
    const ex = await this.db.query<BarcodeRow>('SELECT * FROM barcodes WHERE order_item_id = ?', [orderItemId]);
    if (ex[0]) return ex[0];
    const value = await this.buildIdentifier(orderNumber, sequence);
    const [o] = await this.db.query<{ short_order_code: string | null }>('SELECT short_order_code FROM orders WHERE id = ?', [orderId]);
    const shortQr = await this.buildShortQrPayload(o?.short_order_code || null, sequence);
    const { id, qrToken } = await this.insertBarcode('item', orderId, orderItemId, sequence, value, shortQr);
    await this.db.execute('INSERT INTO garment_tags (order_item_id, barcode_id, printed_count) VALUES (?, ?, 0)', [orderItemId, id]);
    return { id, barcode_value: value, qr_token: qrToken, short_qr_payload: shortQr, order_id: orderId, order_item_id: orderItemId, item_sequence: sequence };
  }

  async generateForLaundryGarment(orderId: number, orderNumber: string, laundryGarmentId: number, sequence: number): Promise<BarcodeRow> {
    const ex = await this.db.query<BarcodeRow>('SELECT * FROM barcodes WHERE laundry_garment_id = ?', [laundryGarmentId]);
    if (ex[0]) return ex[0];
    const value = await this.buildIdentifier(orderNumber, sequence);
    const [o] = await this.db.query<{ short_order_code: string | null }>('SELECT short_order_code FROM orders WHERE id = ?', [orderId]);
    const shortQr = await this.buildShortQrPayload(o?.short_order_code || null, sequence);
    const { id, qrToken } = await this.insertBarcode('laundry', orderId, laundryGarmentId, sequence, value, shortQr);
    await this.db.execute('INSERT INTO garment_tags (laundry_garment_id, barcode_id, printed_count) VALUES (?, ?, 0)', [laundryGarmentId, id]);
    return { id, barcode_value: value, qr_token: qrToken, short_qr_payload: shortQr, order_id: orderId, laundry_garment_id: laundryGarmentId, item_sequence: sequence };
  }
}
