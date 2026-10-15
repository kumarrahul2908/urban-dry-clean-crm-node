import { describe, expect, it, vi } from 'vitest';
import { writeCompare } from './web/dbstate.js';
import { expectSameHtml, webEnabled, webHarness } from './web/harness.js';

vi.setConfig({ testTimeout: 240_000 });

describe.skipIf(!webEnabled)('track.php (public QR landing): PHP ↔ Node parity', () => {
  const { h, seedRich, login } = webHarness();
  it('found / not found / laundry, anonymous', async () => {
    await seedRich();
    const { php, node } = await login(null);
    const write = writeCompare(h.db, h.env.APP_URL);
    const rows = await h.db.query<any>('SELECT b.qr_token, o.order_mode FROM barcodes b JOIN orders o ON o.id = b.order_id ORDER BY b.id');
    const piece = rows.find((r: any) => r.order_mode !== 'weight'), lw = rows.find((r: any) => r.order_mode === 'weight');
    const toks = [piece?.qr_token, lw?.qr_token, 'a'.repeat(32), 'zzz', ''].filter((t) => t !== undefined);
    expect(piece && lw).toBeTruthy();
    for (const t of toks) {
      const p = `/track.php?token=${t}`;
      await write('track ' + t, php, node, (c) => c.get(p), { sortRows: true });
      expectSameHtml(await node.get(p), await php.get(p), h.env.APP_URL, p);
    }
    expectSameHtml(await node.get('/track.php'), await php.get('/track.php'), h.env.APP_URL, 'no token');
    expect((await node.get(`/track.php?token=${piece.qr_token}`)).body).toContain('Garment 1');
  });
});
