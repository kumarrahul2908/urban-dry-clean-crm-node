import type { FastifyInstance } from 'fastify';
import { code128Svg } from '../../lib/barcodeCode128.js';
import { phpEmpty } from '../../lib/php.js';
import { qrSvg } from '../../lib/qrEncoder.js';
import { GarmentTagService } from '../../services/garmentTagService.js';
import { WebRedirect, WebText, forbiddenPage, webPage, type WebCtx } from '../context.js';
import { formArray, int, numberFormat, urlencode } from '../format.js';
import { e, html, jsonEncode, raw } from '../html.js';
import { layout } from '../layout.js';
import { scanScript, scanStyle } from './barcode.static.js';
import { tagsAutoPrintJs, tagsPrintScript, tagsPrintStyle } from './barcodeTags.static.js';

type Row = Record<string, any>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const clean = (v: unknown) => str(v).trim();
const body = (ctx: WebCtx) => (ctx.req.body ?? {}) as Record<string, unknown>;
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
const orDash = (v: unknown) => { const s = String(v ?? ''); return s === '' || s === '0' ? '—' : s; };
const mm = (n: number) => numberFormat(n, 2).replace(/,/g, '');

const addslashes = (v: string) => v.replace(/[\\'"]/g, '\\$&').replace(/\0/g, '\\0');

export function registerBarcodeTagPages(app: FastifyInstance) {
  const { db, printConfig, audit, workshop, laundry } = app.services;

  // ---- Garment tag print page --------------------------------------------------------------------
  webPage(app, '/modules/barcode/tags_print', { auth: 'login' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const u = (p: string) => ctx.baseUrl(p);
    let autoPrint = false, format = 'thermal', barcodeIds: number[] = [], orderId = 0;
    if (req.method === 'POST') {
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      barcodeIds = formArray(p, 'barcode_ids').map((x) => int(x)).filter((x) => x !== 0);
      format = ['thermal', 'label', 'a4'].includes(str(p.format)) ? str(p.format) : 'thermal';
    } else {
      orderId = int(q.order_id);
      autoPrint = 'auto_print' in q;
      if (orderId) barcodeIds = (await db.query<Row>('SELECT id FROM barcodes WHERE order_id = ? ORDER BY item_sequence', [orderId])).map((r) => int(r.id));
    }
    const noTags = (msg: string) => new WebText(`<p style="font-family:sans-serif;padding:20px;">${msg} <a href="${e(u('modules/barcode/tags.php'))}">Go back</a></p>`, 200);
    if (!barcodeIds.length) return noTags('No garment tags were selected.');

    const ph = barcodeIds.map(() => '?').join(',');
    const anchors = await db.query<Row>(`SELECT id, (order_item_id IS NOT NULL) AS is_piece FROM barcodes WHERE id IN (${ph})`, barcodeIds);
    const pieceIds: number[] = [], laundryIds: number[] = [];
    for (const r of anchors) (r.is_piece ? pieceIds : laundryIds).push(int(r.id));
    const byId = new Map<number, Row>();
    if (pieceIds.length) {
      for (const r of await db.query<Row>(
        `SELECT bc.id AS barcode_id, bc.barcode_value, bc.qr_token, bc.short_qr_payload, bc.item_sequence, bc.piece_index, oi.id AS order_item_id, oi.remarks, oi.quantity, oi.weight, oi.unit, oi.pieces_per_unit, oi.piece_names,
         o.order_number, o.order_date, o.due_date, o.due_time, o.store_id AS order_store_id, g.garment_name, s.service_name, col.color_name, br.brand_name, c.full_name AS customer_name, c.customer_code,
         COALESCE(gt.printed_count, 0) AS printed_count, (SELECT COALESCE(SUM(quantity * pieces_per_unit), 0) FROM order_items WHERE order_id = o.id) AS total_items
         FROM barcodes bc JOIN order_items oi ON oi.id = bc.order_item_id JOIN orders o ON o.id = bc.order_id JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = oi.garment_id
         JOIN services s ON s.id = oi.service_id LEFT JOIN colors col ON col.id = oi.color_id LEFT JOIN brands br ON br.id = oi.brand_id LEFT JOIN garment_tags gt ON gt.barcode_id = bc.id
         WHERE bc.id IN (${pieceIds.map(() => '?').join(',')})`, pieceIds)) byId.set(int(r.barcode_id), r);
    }
    if (laundryIds.length) {
      for (const r of await db.query<Row>(
        `SELECT bc.id AS barcode_id, bc.barcode_value, bc.qr_token, bc.short_qr_payload, bc.item_sequence, 1 AS piece_index, NULL AS order_item_id, NULL AS remarks, oi.quantity AS quantity, NULL AS weight, 'Pcs' AS unit, 1 AS pieces_per_unit, NULL AS piece_names,
         o.order_number, o.order_date, o.due_date, o.due_time, o.store_id AS order_store_id, g.garment_name, s.service_name, NULL AS color_name, NULL AS brand_name, c.full_name AS customer_name, c.customer_code,
         COALESCE(gt.printed_count, 0) AS printed_count, oi.quantity AS total_items
         FROM barcodes bc JOIN laundry_garments lg ON lg.id = bc.laundry_garment_id JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = bc.order_id JOIN customers c ON c.id = o.customer_id
         JOIN garments g ON g.id = lg.garment_id JOIN services s ON s.id = oi.service_id LEFT JOIN garment_tags gt ON gt.barcode_id = bc.id WHERE bc.id IN (${laundryIds.map(() => '?').join(',')})`, laundryIds)) byId.set(int(r.barcode_id), r);
    }
    const tags: Row[] = [];
    for (const bid of barcodeIds) { const t = byId.get(bid); if (t) tags.push(t); }
    if (!tags.length) return noTags('Selected garment tags were not found.');

    const cfgCache = new Map<number, Awaited<ReturnType<typeof printConfig.getTagConfig>>>();
    const getCfg = async (storeId: number | null) => { const k = storeId ?? 0; if (!cfgCache.has(k)) cfgCache.set(k, await printConfig.getTagConfig(k)); return cfgCache.get(k)!; };
    const primary = await getCfg(tags[0]!.order_store_id ?? null);

    const defectsByItem = new Map<number, string[]>();
    const itemIds = tags.map((t) => t.order_item_id).filter((x) => !phpEmpty(x)).map((x) => Number(x));
    if (itemIds.length) {
      for (const r of await db.query<Row>(`SELECT oid.order_item_id, d.defect_name FROM order_item_defects oid JOIN defects d ON d.id = oid.defect_id WHERE oid.order_item_id IN (${itemIds.map(() => '?').join(',')})`, itemIds)) {
        const k = Number(r.order_item_id);
        (defectsByItem.get(k) ?? defectsByItem.set(k, []).get(k)!).push(r.defect_name);
      }
    }

    let needsPrint = false, needsReprint = false;
    for (const t of tags) { if (Number(t.printed_count) > 0) needsReprint = true; else needsPrint = true; }
    const missing: string[] = [];
    if (needsPrint && !ctx.can('garment_tags.print')) missing.push('print a new garment tag (garment_tags.print)');
    if (needsReprint && !ctx.can('garment_tags.reprint')) missing.push('reprint an already-printed garment tag (garment_tags.reprint)');
    if (missing.length) {
      return new WebText(`<div style="font-family:sans-serif;padding:20px;"><h3>403 - Access Denied</h3><p>Your selection includes tags that require permission(s) you do not have: ${e(missing.join('; '))}.</p><p>Nothing was printed.</p><p><a href="${e(u('modules/barcode/tags.php'))}">Go back</a></p></div>`, 403);
    }
    const tagSvc = new GarmentTagService(db);
    for (const t of tags) await tagSvc.recordPrint(Number(t.barcode_id), ctx.data.user_id!, audit, req.ip);

    const businessName = (await ctx.setting('business_name', ctx.svc.env.APP_NAME)) ?? '';
    const logoPath = (await ctx.setting('logo_path', '')) ?? '';
    // Tag Design (Admin > Tag Design): per-field show/hide + font/size/style. Seeded with the previous hard-coded look.
    const tagFields = new Map<string, Row>();
    for (const r of await db.query<Row>('SELECT * FROM tag_design_fields')) tagFields.set(String(r.field_key), r);
    const visible = (key: string) => !tagFields.has(key) || !!Number(tagFields.get(key)!.show_field);
    const fieldStyle = (key: string, extra = '') => {
      const f = tagFields.get(key);
      if (!f) return raw(extra);
      let css = `font-family:'${addslashes(String(f.font_family))}';font-size:${int(f.font_size)}px;text-align:${e(String(f.text_align))};`;
      if (Number(f.is_bold)) css += 'font-weight:700;';
      if (Number(f.is_italic)) css += 'font-style:italic;';
      if (Number(f.is_underline)) css += 'text-decoration:underline;';
      css += Number(f.has_box) ? 'border:1.5px solid #000;border-radius:2px;padding:4px;' : 'border:none;';
      return raw(css + extra);
    };
    const tagBlocks: unknown[] = [];
    for (const t of tags) {
      const qrContent = t.short_qr_payload ?? u('track.php?token=' + t.qr_token);
      const tCfg = await getCfg(t.order_store_id ?? null);
      let inline = '';
      if (format === 'thermal' && (t.order_store_id ?? null) !== (tags[0]!.order_store_id ?? null)) inline = ` style="width:${mm(tCfg.tag_width_mm)}mm;height:${mm(tCfg.tag_height_mm)}mm;"`;
      const extras: string[] = [];
      extras.push(t.weight !== null ? e(String(t.weight)) + ' KG' : e(String(t.quantity)) + ' ' + e(t.unit));
      if (!phpEmpty(t.color_name)) extras.push(e(t.color_name));
      if (!phpEmpty(t.brand_name)) extras.push(e(t.brand_name));
      const defects = t.order_item_id !== null ? defectsByItem.get(Number(t.order_item_id)) : undefined;
      if (defects && defects.length) extras.push(e(defects.join(', ')));
      // a Set garment prints ONE tag per physical piece: show the garment name AND (when Piece Names are set) this piece's own name.
      // With quantity > 1 of the same Set garment, piece_index keeps counting past pieces_per_unit (e.g. 1..9 for 3 outfits of 3), so the
      // within-set name must cycle: ((piece_index - 1) % pieces_per_unit) + 1, not piece_index itself.
      const pieceNameList = !phpEmpty(t.piece_names) ? String(t.piece_names).split(',').map((x) => x.trim()) : [];
      const piecesPerUnit = int(t.pieces_per_unit);
      const withinSetIndex = ((int(t.piece_index) - 1) % piecesPerUnit) + 1;
      const pieceParticular = pieceNameList[withinSetIndex - 1] ?? null;
      const totalPieces = Math.round(Number(t.quantity) * piecesPerUnit);
      tagBlocks.push(html`
  <div class="tag"${raw(inline)}>
    ${visible('brand_name') ? html`<div class="brand" style="${fieldStyle('brand_name', 'margin-bottom:6px;letter-spacing:.3px;')}">${businessName}</div>` : ''}
    ${!phpEmpty(logoPath) && visible('logo') ? html`<div style="text-align:center;margin-bottom:4px;"><img src="${u('uploads/logo/' + logoPath)}" style="max-height:22px;"></div>` : ''}

    ${visible('qr_code') ? html`<div class="qr-wrap">${raw(qrSvg(qrContent, 130))}</div>` : ''}
    ${visible('tag_id') ? html`<div class="tag-id" style="${fieldStyle('tag_id', 'margin-bottom:4px;')}">${t.barcode_value}</div>` : ''}

    ${visible('sequence') ? html`
    <div class="seq-order-line" style="${fieldStyle('sequence', 'margin-bottom:2px;')}">
      <span class="seq">${int(t.item_sequence)} / ${int(t.total_items)}</span>
    </div>` : ''}

    ${visible('customer_name') ? html`<div class="customer-name" style="${fieldStyle('customer_name', 'margin-bottom:2px;')}">${t.customer_name}</div>` : ''}
    ${visible('service_name') ? html`<div class="service-line" style="${fieldStyle('service_name', 'margin-bottom:6px;')}">${t.service_name}</div>` : ''}

    ${!phpEmpty(t.remarks) && visible('remark') ? html`<div class="remark" style="${fieldStyle('remark', 'margin-bottom:2px;')}">${t.remarks}</div>` : ''}
    ${visible('create_date') ? html`<div class="create-date" style="${fieldStyle('create_date', 'margin-bottom:6px;')}">${raw(ctx.date(t.order_date, 'd M y D'))}</div>` : ''}

    <!-- a specific piece particular (e.g. "Kameez") replaces the combined garment name on this tag, redundant once it's shown; a garment with
         no particular (ordinary, or a Set with no piece_names configured) still shows garment_name as its only identifying text -->
    ${pieceParticular === null && visible('garment_name') ? html`<div class="garment-name" style="${fieldStyle('garment_name', 'margin-bottom:4px;')}">${t.garment_name}</div>` : ''}
    <!-- unconditional (not gated by the piece_of_set toggle): which physical piece this is, is load-bearing for a Set garment, not decorative --
         the toggle still controls styling via fieldStyle() below. "(item_sequence/total_items)" is the order-wide piece position, same numbers
         as the tag-id's own "X / Y" line above, not which numbered instance of a repeated outfit this is. -->
    ${pieceParticular !== null ? html`<div class="piece-of-set" style="${fieldStyle('piece_of_set', 'margin-bottom:2px;')}">${pieceParticular} (${int(t.item_sequence)}/${int(t.total_items)})</div>` : ''}
    ${visible('due_date') ? html`<div class="due-date" style="${fieldStyle('due_date', 'margin-top:4px;')}">${raw(ctx.date(t.due_date, 'd M y D'))}${!phpEmpty(t.due_time) ? raw(' ' + ctx.date(t.due_time, 'h:i A')) : ''}</div>` : ''}

    ${extras.length && visible('extra_details') ? html`<div class="extra-details" style="${fieldStyle('extra_details', 'margin-top:6px;')}">${raw(extras.join(' &middot; '))}</div>` : ''}
    ${piecesPerUnit > 1 && pieceParticular === null && visible('piece_of_set') ? html`<div class="piece-of-set" style="${fieldStyle('piece_of_set', 'margin-top:4px;')}">Piece ${int(t.piece_index)} of ${totalPieces}</div>` : ''}

    ${visible('barcode_linear') ? html`<div class="barcode-row">${raw(code128Svg(t.barcode_value, 150, 34))}</div>` : ''}
  </div>`);
    }
    return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Garment Tags</title>
${raw(tagsPrintStyle(u, jsonEncode, e))}
${format === 'thermal' ? html`
<style>
  @media print {
    @page { size: ${mm(primary.tag_width_mm)}mm ${mm(primary.tag_height_mm)}mm; margin: 0; }
    /* BUG FIX: the base stylesheet's .tags-thermal .tag rule carries margin:0 auto 18px (meant only for the on-screen multi-tag preview, giving visible gaps between stacked tags before printing). At print time each .tag is ALSO set to the exact @page height (no page margin), so that 18px bottom margin was never being neutralized here and pushed the box's total height past the page boundary -- the tag's own lower content (due-date, extra-details, barcode-row) overflowed onto the START of the NEXT tag's page. page-break-after:always already gives correct separation between tags on its own; this margin was never needed for print, only screen. Zeroing it here (not globally) keeps the screen-preview gap intact. */
    .tags-thermal .tag { margin: 0; }
  }
  .tags-thermal .tag {
    width: ${mm(primary.tag_width_mm)}mm;
    height: ${mm(primary.tag_height_mm)}mm;
  }
</style>` : ''}
</head>
<body>
<div class="actions">
  <button class="btn-print" onclick="window.print()">Print</button>
  <span id="localPrintWrap" style="display:none;">
    <select id="localPrintPrinter" style="padding:8px;border-radius:4px;border:1px solid #ccc;"></select>
    <button class="btn-print" id="localPrintBtn" type="button">Print via Local Service</button>
  </span>
  <button class="btn-close" onclick="window.close()">Close</button>
  ${orderId ? html`
    <a class="btn-link" href="${u('modules/orders/view.php?id=' + orderId)}">Back to Order</a>
    <a class="btn-link" href="${u('modules/orders/invoice.php?id=' + orderId)}">View Invoice</a>` : html`
    <a class="btn-link" href="${u('modules/barcode/tags.php')}">Back to List</a>`}
</div>
<div class="tags-${format}">
${tagBlocks}
</div>

${raw(tagsPrintScript(u, jsonEncode, e, {}, [autoPrint ? tagsAutoPrintJs : '']))}
</body>
</html>`;
  });

  // ---- QR scan page ------------------------------------------------------------------------------
  webPage(app, '/modules/barcode/scan', { auth: 'garment_tags.view' }, async (ctx, req) => {
    const prefill = clean((req.query as Record<string, unknown>).token);
    const u = (p: string) => ctx.baseUrl(p);
    const prefillLookup = prefill !== '' && prefill !== '0' ? `doLookup(${jsonEncode(prefill)});` : '';
    return layout(ctx, { title: 'QR Scan' }, html`
<div class="col-md-6">
  <div class="card">
    <div class="card-body">
      <h6 class="fw-bold">Scan QR Code</h6>
      <div id="cameraArea">
        <!-- v7: scanFrame wraps the video ONLY so the animated scan line can be absolutely
             positioned over it. The line and box are separate CSS layers with pointer-events
             none — they never touch the <video> or the offscreen <canvas>, so they cannot
             interfere with frame capture or decoding. -->
        <div id="scanFrame" style="position:relative;width:100%;max-width:360px;display:none;">
          <video id="scanVideo" playsinline muted style="width:100%;display:block;background:#000;"></video>
          <div id="scanBox"></div>
          <div id="scanLine"></div>
        </div>
        <canvas id="scanCanvas" style="display:none;"></canvas>
        <button class="btn btn-outline-primary btn-sm mt-2" id="startCameraBtn"><i class="fa-solid fa-camera me-1"></i>Start Camera Scan</button>
        <button class="btn btn-outline-secondary btn-sm mt-2 d-none" id="stopCameraBtn">Stop Camera</button>
        <div class="text-muted small mt-1" id="cameraStatusMsg">If your browser/device doesn't support camera scanning, use manual entry below.</div>
        <pre class="small bg-light border rounded p-2 mt-2 d-none" id="cameraDiag" style="white-space:pre-wrap;"></pre>
      </div>
      <hr>
      <label class="form-label small">Manual Token Entry</label>
      <div class="input-group mb-3">
        <input type="text" id="tokenInput" class="form-control" placeholder="Paste secure token..." value="${prefill}">
        <button class="btn btn-primary" id="lookupBtn"><i class="fa-solid fa-magnifying-glass"></i></button>
      </div>

      <div id="result" class="d-none">
        <table class="table table-sm">
          <tr><th style="width:150px">Order Number</th><td id="rOrder"></td></tr>
          <tr><th>Customer</th><td id="rCustomer"></td></tr>
          <tr><th>Garment</th><td id="rGarment"></td></tr>
          <tr><th>Service</th><td id="rService"></td></tr>
          <tr><th>Status</th><td id="rStatus"></td></tr>
          <tr><th>Due Date</th><td id="rDue"></td></tr>
        </table>
        <a href="#" id="openOrderBtn" class="btn btn-outline-primary btn-sm" target="_blank">Open Order</a>
        <a href="#" id="openGarmentBtn" class="btn btn-outline-secondary btn-sm">Garment Detail</a>
      </div>
      <div id="notFound" class="alert alert-warning d-none mt-3">No garment found for this QR code / token.</div>
    </div>
  </div>
</div>

${raw(scanStyle(u, jsonEncode, e))}

${raw(scanScript(u, jsonEncode, e, {}, [prefillLookup]))}
`);
  });

  // ---- Garment detail ----------------------------------------------------------------------------
  webPage(app, '/modules/barcode/garment_detail', { auth: 'garment_tags.view' }, async (ctx, req) => {
    const q = req.query as Record<string, unknown>;
    const itemId = int(q.item_id), laundryId = int(q.laundry_garment_id);
    const u = (p: string) => ctx.baseUrl(p);
    const tagSvc = new GarmentTagService(db);
    const dt = (v: unknown) => raw(ctx.datetime(v));

    if (laundryId > 0) {
      const item = (await db.query<Row>(
        `SELECT lg.id, lg.sequence, g.garment_name, oi.id AS order_item_id, oi.quantity AS total_garments, oi.weight AS batch_weight, oi.weight_rate AS batch_rate,
         o.id AS order_id, o.order_number, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile AS customer_mobile, s.service_name, ul.level_name AS urgent_level_name,
         bc.id AS barcode_id, bc.barcode_value, bc.qr_token, bc.created_at AS identifier_created_at, gt.printed_count, gt.last_printed_at, gt.last_printed_by, u.full_name AS last_printed_by_name
         FROM laundry_garments lg JOIN order_items oi ON oi.id = lg.order_item_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id JOIN garments g ON g.id = lg.garment_id
         JOIN services s ON s.id = oi.service_id LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id LEFT JOIN barcodes bc ON bc.laundry_garment_id = lg.id LEFT JOIN garment_tags gt ON gt.barcode_id = bc.id
         LEFT JOIN users u ON u.id = gt.last_printed_by WHERE lg.id = ?`, [laundryId]))[0];
      if (!item) { ctx.flashSet('danger', 'Laundry garment not found.'); return new WebRedirect('modules/orders/list.php'); }
      if (!item.barcode_id) {
        const g = await tagSvc.generateForLaundryGarment(Number(item.order_id), item.order_number, laundryId, Number(item.sequence));
        if (g) return new WebRedirect('modules/barcode/garment_detail.php?laundry_garment_id=' + laundryId);
      }
      const currentStatus = await laundry.getCurrentStatus(laundryId);
      const history = await laundry.getHistory(laundryId);
      const qrContent = u('modules/barcode/scan.php?token=' + item.qr_token);
      return layout(ctx, { title: 'Laundry Garment Detail' }, html`
    <div class="col-md-7">
      <div class="card">
        <div class="card-body">
          <h5 class="fw-bold">${item.garment_name} <span class="badge bg-secondary">${int(item.sequence)} / ${int(item.total_garments)}</span></h5>
          <table class="table table-sm">
            <tr><th style="width:180px">Garment ID</th><td><code>${item.barcode_value}</code></td></tr>
            <tr><th>Order</th><td><a href="${u('modules/orders/view.php?id=' + item.order_id)}">${item.order_number}</a></td></tr>
            <tr><th>Customer</th><td>${item.customer_name} (${item.customer_mobile})</td></tr>
            <tr><th>Service</th><td>${item.service_name}</td></tr>
            <tr><th>Batch Weight / Rate</th><td>${String(item.batch_weight ?? '')} KG @ ${raw((await ctx.loadMoney())(item.batch_rate))}/kg <span class="text-muted small">(shared across all ${int(item.total_garments)} garments in this batch — not priced individually)</span></td></tr>
            <tr><th>Due Date</th><td>${raw(ctx.date(item.due_date))}${!phpEmpty(item.due_time) ? raw(' at ' + ctx.date(item.due_time, 'h:i A')) : ''}</td></tr>
            <tr><th>Urgent Level</th><td>${item.urgent_level_name ? html`<span class="badge bg-danger">${item.urgent_level_name}</span>` : 'Normal'}</td></tr>
            <tr><th>Current Status</th><td><span class="badge bg-primary">${currentStatus}</span> <span class="text-muted small">(derived from this garment's own history, independent of the other ${int(item.total_garments) - 1} garments in the batch)</span></td></tr>
            <tr><th>Print Count</th><td>${int(item.printed_count)}${item.last_printed_at ? html` &middot; last printed ${dt(item.last_printed_at)} by ${String(item.last_printed_by_name ?? '')}` : ''}</td></tr>
          </table>

          <h6 class="fw-bold mt-3">History</h6>
          ${history.length === 0 ? html`
            <p class="text-muted small">No status changes recorded yet — still at the initial Pending state.</p>` : html`
            <ul class="list-group list-group-flush">
              ${history.map((h) => html`
                <li class="list-group-item px-0">
                  <span class="small text-muted">${dt(h.changed_at)}</span> —
                  ${orDash(h.previous_status) === '—' ? '(start)' : h.previous_status} → <strong>${h.new_status}</strong>
                  <span class="badge bg-light text-dark">${String(h.module ?? '')}</span>
                  ${h.changed_by_name ? html`<span class="text-muted small"> by ${h.changed_by_name}</span>` : ''}
                  ${!phpEmpty(h.remarks) ? html`<div class="small text-muted">${h.remarks}</div>` : ''}
                </li>`)}
            </ul>`}
        </div>
      </div>
    </div>
    <div class="col-md-5">
      <div class="card">
        <div class="card-body text-center">
          <h6 class="fw-bold">Barcode</h6>
          <svg id="barcodeSvg"></svg>
          <hr>
          <h6 class="fw-bold">QR Code</h6>
          <div id="qrCode" class="d-flex justify-content-center"></div>
          <div class="text-muted small mt-2">Scanning opens: ${qrContent}</div>
        </div>
      </div>
    </div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/JsBarcode/3.11.5/JsBarcode.all.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
    ${raw(`<script>
    JsBarcode("#barcodeSvg", ${jsonEncode(item.barcode_value)}, { format: "CODE128", width: 2, height: 60, fontSize: 14 });
    new QRCode(document.getElementById("qrCode"), { text: ${jsonEncode(qrContent)}, width: 140, height: 140 });
    </script>`)}
    `);
    }

    const item = (await db.query<Row>(
      `SELECT oi.*, g.garment_name, g.sku, s.service_name, s.billing_unit, b.brand_name, col.color_name, o.order_number, o.due_date, o.due_time, c.full_name AS customer_name, c.mobile AS customer_mobile,
       ul.level_name AS urgent_level_name, bc.id AS barcode_id, bc.barcode_value, bc.qr_token, bc.item_sequence, bc.created_at AS identifier_created_at, gt.printed_count, gt.last_printed_at, gt.last_printed_by,
       u.full_name AS last_printed_by_name, wi.id AS workshop_item_id, wi.status AS workshop_status
       FROM order_items oi JOIN garments g ON g.id = oi.garment_id JOIN services s ON s.id = oi.service_id JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
       LEFT JOIN urgent_levels ul ON ul.id = o.urgent_level_id LEFT JOIN brands b ON b.id = oi.brand_id LEFT JOIN colors col ON col.id = oi.color_id LEFT JOIN barcodes bc ON bc.order_item_id = oi.id
       LEFT JOIN garment_tags gt ON gt.barcode_id = bc.id LEFT JOIN users u ON u.id = gt.last_printed_by LEFT JOIN workshop_items wi ON wi.order_item_id = oi.id AND wi.status NOT IN ('Completed','Rejected')
       WHERE oi.id = ?`, [itemId]))[0];
    if (!item) { ctx.flashSet('danger', 'Garment not found.'); return new WebRedirect('modules/orders/list.php'); }

    if (req.method === 'POST' && 'workshop_action' in body(ctx)) {
      if (!ctx.can('workshop.manage')) return forbiddenPage(ctx);
      if (!ctx.csrfValid()) return csrfFail();
      const p = body(ctx);
      const wsId = int(p.workshop_item_id);
      const a = { userId: ctx.data.user_id!, ip: req.ip };
      const action = str(p.workshop_action);
      const r = action === 'start_processing' ? await workshop.startProcessing(wsId, a) : action === 'complete_processing' ? await workshop.completeProcessing(wsId, a)
        : action === 'accept' ? await workshop.acceptItem(wsId, a) : action === 'return_to_store' ? await workshop.returnToStore(wsId, a) : { success: false, errors: ['Unknown action.'] };
      ctx.flashSet(r.success ? 'success' : 'danger', r.success ? 'Status updated.' : (r.errors ?? []).join(' '));
      return new WebRedirect('modules/barcode/garment_detail.php?item_id=' + itemId);
    }
    if (!item.barcode_id) {
      const g = await tagSvc.ensureBarcodeExists(itemId);
      if (g) return new WebRedirect('modules/barcode/garment_detail.php?item_id=' + itemId);
    }
    const defects = (await db.query<Row>('SELECT d.defect_name FROM order_item_defects oid JOIN defects d ON d.id = oid.defect_id WHERE oid.order_item_id = ?', [itemId])).map((r) => String(r.defect_name));
    const derived = item.workshop_item_id ? await workshop.getCurrentStatus(Number(item.workshop_item_id)) : null;
    const history = await db.query<Row>(
      `SELECT changed_at, previous_status, new_status, module, remarks, u.full_name AS changed_by_name FROM garment_status_history gsh LEFT JOIN users u ON u.id = gsh.changed_by
       WHERE gsh.order_item_id = ? ORDER BY changed_at ASC, gsh.id ASC`, [itemId]);
    const totalItems = int((await db.query<Row>('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', [item.order_id]))[0]!.n);
    const qrContent = u('modules/barcode/scan.php?token=' + item.qr_token);
    const wsForm = (action: string, label: string, cls: string, extra = '') => html`
          <form method="POST" class="d-inline${extra}">
            ${ctx.csrfField()}
            <input type="hidden" name="workshop_action" value="${action}">
            <input type="hidden" name="workshop_item_id" value="${item.workshop_item_id}">
            <button type="submit" class="btn ${cls} btn-sm">${label}</button>
          </form>`;
    return layout(ctx, { title: 'Garment Detail' }, html`
<div class="col-md-7">
  <div class="card">
    <div class="card-body">
      <h5 class="fw-bold">${item.garment_name} <span class="badge bg-secondary">${String(item.item_sequence ?? '')} / ${totalItems}</span></h5>
      <table class="table table-sm">
        <tr><th style="width:180px">Garment ID</th><td><code>${item.barcode_value}</code></td></tr>
        <tr><th>Order</th><td><a href="${u('modules/orders/view.php?id=' + item.order_id)}">${item.order_number}</a></td></tr>
        <tr><th>Customer</th><td>${item.customer_name} (${item.customer_mobile})</td></tr>
        <tr><th>Service</th><td>${item.service_name}</td></tr>
        <tr><th>Quantity</th><td>${item.weight !== null ? String(item.weight) + ' kg' : String(item.quantity) + ' ' + String(item.unit ?? '')}</td></tr>
        <tr><th>Color</th><td>${orDash(item.color_name)}</td></tr>
        <tr><th>Brand</th><td>${orDash(item.brand_name)}</td></tr>
        <tr><th>Defects</th><td>${defects.length ? defects.join(', ') : '—'}</td></tr>
        <tr><th>Remarks</th><td>${orDash(item.remarks)}</td></tr>
        <tr><th>Due Date</th><td>${raw(ctx.date(item.due_date))}${!phpEmpty(item.due_time) ? raw(' at ' + ctx.date(item.due_time, 'h:i A')) : ''}</td></tr>
        <tr><th>Urgent Level</th><td>${item.urgent_level_name ? html`<span class="badge bg-danger">${item.urgent_level_name}</span>` : 'Normal'}</td></tr>
        <tr><th>Current Status</th><td><span class="badge bg-primary">${item.item_status}</span></td></tr>
        ${derived ? html`
        <tr><th>Workshop Status</th><td><span class="badge bg-info text-dark">${derived}</span></td></tr>` : ''}
        <tr><th>Print Count</th><td>${int(item.printed_count)}${item.last_printed_at ? html` &middot; last printed ${dt(item.last_printed_at)} by ${String(item.last_printed_by_name ?? '')}` : ''}</td></tr>
      </table>
      ${ctx.can('garment_tags.print') || ctx.can('garment_tags.reprint') ? html`
        <a href="${u('modules/barcode/tags.php?barcode=' + urlencode(String(item.barcode_value ?? '')))}" class="btn btn-outline-primary btn-sm"><i class="fa-solid fa-tag me-1"></i>Print / Reprint Tag</a>` : ''}

      ${ctx.can('workshop.manage') && item.workshop_item_id ? html`
        <hr>
        <h6 class="fw-bold">Workshop Actions</h6>
        ${derived === 'Sent' || derived === 'Received' ? html`${wsForm('accept', 'Accept', 'btn-outline-primary', ' me-1')}${wsForm('start_processing', 'Start Processing', 'btn-primary')}`
          : derived === 'Accepted' ? wsForm('start_processing', 'Start Processing', 'btn-primary')
          : derived === 'Processing' ? wsForm('complete_processing', 'Mark Processing Completed', 'btn-success')
          : derived === 'Completed' ? wsForm('return_to_store', 'Return to Store', 'btn-outline-success')
          : derived === 'Returned' ? html`<p class="text-muted small mb-0">Awaiting the store to confirm receipt — see Workshop Returns.</p>` : ''}` : ''}

      ${history.length ? html`
        <hr>
        <h6 class="fw-bold">History</h6>
        <ul class="list-group list-group-flush">
          ${history.map((h) => html`
            <li class="list-group-item px-0">
              <span class="small text-muted">${dt(h.changed_at)}</span> —
              ${orDash(h.previous_status) === '—' ? '(start)' : h.previous_status} → <strong>${h.new_status}</strong>
              <span class="badge bg-light text-dark">${String(h.module ?? '')}</span>
              ${h.changed_by_name ? html`<span class="text-muted small"> by ${h.changed_by_name}</span>` : ''}
              ${!phpEmpty(h.remarks) ? html`<div class="small text-muted">${h.remarks}</div>` : ''}
            </li>`)}
        </ul>` : ''}
    </div>
  </div>
</div>
<div class="col-md-5">
  <div class="card">
    <div class="card-body text-center">
      <h6 class="fw-bold">Barcode</h6>
      <svg id="barcodeSvg"></svg>
      <hr>
      <h6 class="fw-bold">QR Code</h6>
      <div id="qrCode" class="d-flex justify-content-center"></div>
      <div class="text-muted small mt-2">Scanning opens: ${qrContent}</div>
    </div>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/JsBarcode/3.11.5/JsBarcode.all.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
${raw(`<script>
JsBarcode("#barcodeSvg", ${jsonEncode(item.barcode_value)}, { format: "CODE128", width: 2, height: 60, fontSize: 14 });
new QRCode(document.getElementById("qrCode"), { text: ${jsonEncode(qrContent)}, width: 140, height: 140 });
</script>`)}
`);
  });
}
