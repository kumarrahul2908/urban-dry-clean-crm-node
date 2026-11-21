import { unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { WebRedirect, WebText, webPage, type WebCtx } from '../context.js';
import { int, urlencode } from '../format.js';
import { e, html, raw } from '../html.js';
import { layout } from '../layout.js';

type Row = Record<string, any>;
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);

/**
 * Admin > Order Photos. The delete option for garment photos lives HERE (the order page, web and app, only VIEWS them). Lists every
 * photo taken in the app for an order (per garment or whole-order), newest first, searchable by order code, with a delete button that
 * removes the DB row AND the file and writes an audit-log entry. Same permission as the other Admin pages that change data.
 */
export function registerAdminOrderPhotoPages(app: FastifyInstance) {
  const { db, audit } = app.services;

  webPage(app, '/modules/admin/order_photos', { auth: 'admin.settings', methods: ['GET', 'POST'] }, async (ctx, req) => {
    const u = (p: string) => ctx.baseUrl(p);
    if (req.method === 'POST' && body(ctx).action === 'delete_photo') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const photoId = int(p.photo_id);
      const row = (await db.query<Row>('SELECT order_id, order_item_id, file_path FROM order_photos WHERE id = ?', [photoId]))[0];
      if (row) {
        await db.execute('DELETE FROM order_photos WHERE id = ?', [photoId]);
        // file_path is the server-generated name stored at upload time, never client input.
        await unlink(join(ctx.svc.storage.root, 'order_photos', basename(String(row.file_path)))).catch(() => {});
        await audit.record({ action: 'delete', module: 'order_photos', recordId: String(photoId), oldValue: { order_id: row.order_id, order_item_id: row.order_item_id }, newValue: null, userId: ctx.data.user_id ?? null, ip: req.ip });
        ctx.flashSet('success', 'Photo deleted.');
      } else {
        ctx.flashSet('danger', 'Photo not found.');
      }
      // Deleted from the order page itself (Admin only): go back to that order.
      if (p.back_order_id !== undefined && p.back_order_id !== '' && p.back_order_id !== '0') return new WebRedirect('modules/orders/view.php?id=' + int(p.back_order_id));
      return new WebRedirect('modules/admin/order_photos.php' + (p.q !== undefined && p.q !== '' ? '?q=' + urlencode(String(p.q)) : ''));
    }

    const query = req.query as Record<string, unknown>;
    const q = String(query.q ?? '').trim();
    let page = Math.max(1, int(query.page) || 1);
    const perPage = 24;
    let where = '';
    let params: unknown[] = [];
    if (q !== '') {
      where = 'WHERE (o.short_order_code LIKE ? OR o.order_number LIKE ? OR o.invoice_number LIKE ?)';
      const like = '%' + q + '%';
      params = [like, like, like];
    }
    const total = int((await db.query<Row>(`SELECT COUNT(*) AS n FROM order_photos p JOIN orders o ON o.id = p.order_id ${where}`, params))[0]!.n);
    const pages = Math.max(1, Math.ceil(total / perPage));
    page = Math.min(page, pages);
    const photos = await db.query<Row>(
      `SELECT p.id, p.order_id, p.order_item_id, p.file_path, p.caption, p.created_at,
              COALESCE(o.short_order_code, o.order_number) AS order_code, g.garment_name AS garment_name
       FROM order_photos p
       JOIN orders o ON o.id = p.order_id
       LEFT JOIN order_items oi ON oi.id = p.order_item_id
       LEFT JOIN garments g ON g.id = oi.garment_id
       ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, params);

    return layout(ctx, { title: 'Order Photos' }, html`
<div class="container-fluid py-3">
  <h4 class="fw-bold mb-1"><i class="fa-solid fa-images me-2"></i>Order Photos</h4>
  <p class="text-muted small mb-3">Photos taken in the app for orders and garments. Staff can only view them on the order page; deleting is done here.</p>

  <form method="GET" class="d-flex gap-2 mb-3" style="max-width:420px;">
    <input type="text" name="q" value="${q}" class="form-control" placeholder="Order code / number / invoice">
    <button class="btn btn-primary">Search</button>
    ${q !== '' ? html`<a href="${u('modules/admin/order_photos.php')}" class="btn btn-outline-secondary">Clear</a>` : ''}
  </form>

  ${photos.length === 0 ? html`
    <div class="alert alert-light border">No photos found.</div>` : html`
    <div class="row g-3">
      ${photos.map((p) => { const url = u('uploads/order_photos/' + p.file_path); return html`
        <div class="col-6 col-md-4 col-lg-3 col-xl-2">
          <div class="card h-100">
            <img src="${url}" alt="Order photo" loading="lazy" class="card-img-top adm-photo" data-full="${url}" style="height:150px;object-fit:cover;cursor:zoom-in;">
            <div class="card-body p-2 small">
              <a href="${u('modules/orders/view.php?id=' + int(p.order_id))}" class="fw-semibold text-decoration-none">${p.order_code}</a>
              <div class="text-muted">${p.order_item_id ? String(p.garment_name || 'Garment') : 'Whole order'}</div>
              ${p.caption ? html`<div class="text-muted">${p.caption}</div>` : ''}
              <div class="text-muted" style="font-size:11px;">${raw(ctx.datetime(p.created_at, 'd M Y, h:i A'))}</div>
              <form method="POST" class="mt-1" onsubmit="return confirm('Delete this photo permanently?');">
                ${ctx.csrfField()}
                <input type="hidden" name="action" value="delete_photo">
                <input type="hidden" name="photo_id" value="${int(p.id)}">
                <input type="hidden" name="q" value="${q}">
                <button class="btn btn-outline-danger btn-sm w-100"><i class="fa-solid fa-trash me-1"></i>Delete</button>
              </form>
            </div>
          </div>
        </div>`; })}
    </div>
    ${pages > 1 ? html`
      <nav class="mt-3"><ul class="pagination pagination-sm">
        ${Array.from({ length: pages }, (_, k) => k + 1).map((i) => html`
          <li class="page-item ${i === page ? 'active' : ''}"><a class="page-link" href="?q=${urlencode(q)}&page=${i}">${i}</a></li>`)}
      </ul></nav>` : ''}`}
</div>

<div class="modal fade" id="photoViewModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-lg modal-dialog-centered"><div class="modal-content bg-dark"><div class="modal-body p-1 text-center position-relative">
    <button type="button" class="btn-close btn-close-white position-absolute top-0 end-0 m-2" data-bs-dismiss="modal" style="z-index:2;"></button>
    <img id="photoViewImg" src="" alt="Photo" style="max-width:100%;max-height:80vh;">
  </div></div></div>
</div>
<script>
document.addEventListener('click', function (ev) {
  var img = ev.target.closest && ev.target.closest('.adm-photo');
  if (!img) return;
  document.getElementById('photoViewImg').src = img.getAttribute('data-full');
  bootstrap.Modal.getOrCreateInstance(document.getElementById('photoViewModal')).show();
});
</script>
`);
  });
}
