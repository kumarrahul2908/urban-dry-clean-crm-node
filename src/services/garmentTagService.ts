import { randomBytes } from 'node:crypto';
import type { AuditLog } from '../audit/auditLog.js';
import type { Db } from '../db/pool.js';
import { getSetting } from './settings.js';

export interface BarcodeRow {
  id: number; barcode_value: string; qr_token: string; short_qr_payload: string | null;
  order_id: number; order_item_id?: number | null; laundry_garment_id?: number | null; item_sequence: number; piece_index?: number;
}

/** Port of GarmentTagService (barcode + tag creation). Pass a transaction Db to join it. */
export class GarmentTagService {
  constructor(private readonly db: Db) {}

  private async padding(): Promise<number> {
    return Math.max(1, parseInt((await getSetting(this.db, 'garment_seq_padding', '2')) ?? '2', 10) || 0);
  }

  async buildIdentifier(code: string, sequence: number): Promise<string> {
    return `${code}-${String(sequence).padStart(await this.padding(), '0')}`;
  }

  private async buildShortQrPayload(shortOrderCode: string | null, sequence: number): Promise<string | null> {
    if (shortOrderCode === null) return null;
    return `${shortOrderCode}-${String(sequence).padStart(await this.padding(), '0')}`;
  }

  private async insertBarcode(kind: 'item' | 'laundry', orderId: number, refId: number, sequence: number, barcodeValue: string, shortQr: string | null, pieceIndex?: number) {
    const col = kind === 'item' ? 'order_item_id' : 'laundry_garment_id';
    for (let attempt = 1; ; attempt++) {
      const qrToken = randomBytes(16).toString('hex'); // 32 hex chars -> CHAR(32)
      try {
        const r = pieceIndex === undefined
          ? await this.db.execute(
            `INSERT INTO barcodes (barcode_value, qr_token, short_qr_payload, order_id, ${col}, item_sequence) VALUES (?,?,?,?,?,?)`,
            [barcodeValue, qrToken, shortQr, orderId, refId, sequence],
          )
          : await this.db.execute(
            `INSERT INTO barcodes (barcode_value, qr_token, short_qr_payload, order_id, ${col}, item_sequence, piece_index) VALUES (?,?,?,?,?,?,?)`,
            [barcodeValue, qrToken, shortQr, orderId, refId, sequence, pieceIndex],
          );
        return { id: r.insertId, qrToken };
      } catch (e) {
        if ((e as { code?: string }).code === 'ER_DUP_ENTRY' && attempt < 5) continue;
        throw e;
      }
    }
  }

  /**
   * Idempotent per PIECE: creates only the missing tags of an item. A Set garment is one ordered unit
   * but several physical pieces, so an item gets `pieceCount` (= quantity x pieces_per_unit) tags with
   * order-wide sequences startSequence .. startSequence+pieceCount-1 (the caller advances its running
   * counter by pieceCount). Returns one barcode row per piece, ordered by piece_index.
   */
  async generateForItem(orderId: number, orderNumber: string, orderItemId: number, startSequence: number, pieceCount = 1): Promise<BarcodeRow[]> {
    pieceCount = Math.max(1, pieceCount);
    const existing = await this.db.query<BarcodeRow>('SELECT * FROM barcodes WHERE order_item_id = ? ORDER BY piece_index', [orderItemId]);
    const byPiece = new Map(existing.map((r) => [Number(r.piece_index), r]));
    if (byPiece.size >= pieceCount) return [...byPiece.values()];
    // the Short Order Code is THE identifier (tag text, QR payload, scan key); order_number only if the feature is off
    const [o] = await this.db.query<{ short_order_code: string | null }>('SELECT short_order_code FROM orders WHERE id = ?', [orderId]);
    const shortCode = o?.short_order_code || null;
    const code = shortCode ?? orderNumber;
    const out: BarcodeRow[] = [];
    for (let pieceIndex = 1; pieceIndex <= pieceCount; pieceIndex++) {
      const have = byPiece.get(pieceIndex);
      if (have) { out.push(have); continue; }
      const sequence = startSequence + pieceIndex - 1;
      const value = await this.buildIdentifier(code, sequence);
      const shortQr = await this.buildShortQrPayload(shortCode, sequence);
      const { id, qrToken } = await this.insertBarcode('item', orderId, orderItemId, sequence, value, shortQr, pieceIndex);
      await this.db.execute('INSERT INTO garment_tags (order_item_id, barcode_id, printed_count) VALUES (?, ?, 0)', [orderItemId, id]);
      out.push({ id, barcode_value: value, qr_token: qrToken, short_qr_payload: shortQr, order_id: orderId, order_item_id: orderItemId, item_sequence: sequence, piece_index: pieceIndex });
    }
    return out;
  }

  async generateForLaundryGarment(orderId: number, orderNumber: string, laundryGarmentId: number, sequence: number): Promise<BarcodeRow> {
    const ex = await this.db.query<BarcodeRow>('SELECT * FROM barcodes WHERE laundry_garment_id = ?', [laundryGarmentId]);
    if (ex[0]) return ex[0];
    const [o] = await this.db.query<{ short_order_code: string | null }>('SELECT short_order_code FROM orders WHERE id = ?', [orderId]);
    const value = await this.buildIdentifier(o?.short_order_code || orderNumber, sequence);
    const shortQr = await this.buildShortQrPayload(o?.short_order_code || null, sequence);
    const { id, qrToken } = await this.insertBarcode('laundry', orderId, laundryGarmentId, sequence, value, shortQr);
    await this.db.execute('INSERT INTO garment_tags (laundry_garment_id, barcode_id, printed_count) VALUES (?, ?, 0)', [laundryGarmentId, id]);
    return { id, barcode_value: value, qr_token: qrToken, short_qr_payload: shortQr, order_id: orderId, laundry_garment_id: laundryGarmentId, item_sequence: sequence };
  }

  /**
   * GarmentTagService::ensureBarcodeExists(): lazy fallback for an item without (all of) its barcodes. The start sequence is the
   * sum of quantity x pieces_per_unit of every earlier item on the order, so a preceding Set pushes this item's tags along.
   * Returns one row per physical piece, or null when the item does not exist.
   */
  async ensureBarcodeExists(orderItemId: number): Promise<BarcodeRow[] | null> {
    const existing = await this.db.query<BarcodeRow>('SELECT * FROM barcodes WHERE order_item_id = ? ORDER BY piece_index', [orderItemId]);
    const [item] = await this.db.query<{ order_id: number; quantity: string; pieces_per_unit: number; order_number: string }>(
      'SELECT oi.order_id, oi.quantity, oi.pieces_per_unit, o.order_number FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ?', [orderItemId]);
    if (!item) return null;
    const pieceCount = Math.max(1, Math.round(Number(item.quantity) * Math.max(1, Number(item.pieces_per_unit))));
    if (existing.length >= pieceCount) return existing;
    const [pre] = await this.db.query<{ n: string | number }>('SELECT COALESCE(SUM(quantity * pieces_per_unit), 0) AS n FROM order_items WHERE order_id = ? AND id < ?', [item.order_id, orderItemId]);
    const startSequence = Math.round(Number(pre?.n ?? 0)) + 1;
    return this.generateForItem(Number(item.order_id), item.order_number, orderItemId, startSequence, pieceCount);
  }

  /** GarmentTagService::recordPrint(): bookkeeping once print/reprint is authorized. */
  async recordPrint(barcodeId: number, userId: number, audit: AuditLog, ip: string | null = null): Promise<void> {
    const [tag] = await this.db.query<Record<string, any>>('SELECT * FROM garment_tags WHERE barcode_id = ?', [barcodeId]);
    if (!tag) return;
    const isReprint = Number(tag.printed_count) > 0;
    await this.db.execute('UPDATE garment_tags SET printed_count = printed_count + 1, last_printed_at = NOW(), last_printed_by = ? WHERE id = ?', [userId, tag.id]);
    await audit.record({ action: isReprint ? 'reprint' : 'print', module: 'garment_tags', recordId: tag.order_item_id === null || tag.order_item_id === undefined ? '' : String(tag.order_item_id), newValue: { barcode_id: barcodeId, printed_count: Number(tag.printed_count) + 1 }, userId, ip });
  }
}
