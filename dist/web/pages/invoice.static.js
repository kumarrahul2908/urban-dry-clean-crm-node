// GENERATED from modules/orders/invoice.php (style + script blocks with their PHP conditionals) — do not edit by hand.
export const invoiceStyle = (cfg) => {
    const page = cfg.isDefaultA4
        ? `    /* No store-specific config saved yet -> exact previous hard-coded behavior, unchanged. */
    @page { size: A4; margin: 12mm; }`
        : cfg.isThermal
            ? `    /* REQUIREMENT 2: thermal roll — width from config, height auto/continuous. */
    @page { size: ${cfg.widthMm}mm auto; margin: 3mm; }`
            : `    /* REQUIREMENT 2: laser/sheet — configured width x height (Letter or custom). */
    @page { size: ${cfg.widthMm}mm ${cfg.heightMm ?? '297.00'}mm; margin: 10mm; }`;
    const thermal = cfg.isThermal ? `
  /* REQUIREMENT 2: thermal receipt is a real narrow roll, both on screen preview and in print —
     the same 10-column item table is kept (no redesign of the table itself, per "do not break
     the existing layout"/"minimum controls" scope) but the sheet narrows to the configured roll
     width and scrolls horizontally, the same technique already used for small mobile screens
     above. This is a functional compact-width invoice, not yet a fully re-flowed single-column
     thermal receipt layout — flagged in the implementation report as a scoped simplification. */
  .sheet { max-width: ${cfg.widthMm}mm; padding: 4mm; }
  .items-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; margin-bottom: 14px; }
  table.items { min-width: 640px; margin-bottom: 0; font-size: 11px; }
  table.summary { width: 100%; }
  .invoice-meta { text-align: left; }
  .header { flex-direction: column; gap: 8px; }
  @media print {
    .sheet { max-width: ${cfg.widthMm}mm; padding: 2mm; }
  }
` : '';
    return `<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background:#eef1f6; margin:0; padding:20px; color:#1c2230; }
  .sheet { max-width:800px; margin:0 auto; background:#fff; padding:36px; box-shadow:0 2px 12px rgba(0,0,0,.08); }
  .header { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #0b3d91; padding-bottom:16px; margin-bottom:16px; }
  .brand-name { font-size:24px; font-weight:800; color:#0b3d91; }
  .brand-sub { font-size:12.5px; color:#555; margin-top:4px; line-height:1.5; }
  .invoice-meta { text-align:right; font-size:13px; }
  .invoice-meta .title { font-size:20px; font-weight:700; color:#0b3d91; }
  .grid2 { display:flex; justify-content:space-between; gap:24px; margin-bottom:20px; }
  .box { flex:1; font-size:13px; }
  .box h4 { font-size:12px; text-transform:uppercase; color:#888; margin:0 0 6px; letter-spacing:.05em; }
  table.items { width:100%; border-collapse:collapse; margin-bottom:20px; font-size:12.5px; }
  table.items th { background:#f1f5f9; text-align:left; padding:8px 6px; border-bottom:2px solid #dde3ec; font-size:11px; text-transform:uppercase; color:#556; }
  table.items td { padding:7px 6px; border-bottom:1px solid #eef1f6; }
  .right { text-align:right; }
  table.summary { width:280px; margin-left:auto; font-size:13px; border-collapse:collapse; }
  table.summary td { padding:5px 0; }
  table.summary tr.total td { font-weight:800; font-size:16px; border-top:2px solid #0b3d91; padding-top:8px; color:#0b3d91; }
  .footer-note { margin-top:30px; font-size:11.5px; color:#888; border-top:1px solid #eee; padding-top:12px; }
  .actions { text-align:center; margin:20px 0; }
  .actions button, .actions a { border:0; background:#0b3d91; color:#fff; padding:9px 18px; border-radius:6px; text-decoration:none; font-size:13px; margin:0 4px; cursor:pointer; }
  @media print {
    body { background:#fff; padding:0; }
    .sheet { box-shadow:none; padding:10mm; }
    .actions { display:none; }
${page}
  }
  /* Mobile responsive — screen only, the @media print block above is completely untouched, so
     the printed/PDF layout is unaffected by any of this. Tested against 320/360/390/412px. */
  @media screen and (max-width: 480px) {
    body { padding: 8px; overflow-x: hidden; }
    .sheet { padding: 14px; }
    .header { flex-direction: column; gap: 10px; }
    .invoice-meta { text-align: left; }
    .grid2 { flex-direction: column; gap: 14px; }
    /* The 10-column items table cannot be safely compressed to fit a 320-412px screen without
       making amounts unreadably tiny — scrolls horizontally INSIDE its own container instead of
       letting the whole page overflow. */
    .items-scroll { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; margin-bottom: 14px; }
    table.items { min-width: 640px; margin-bottom: 0; }
    table.summary { width: 100%; }
    .actions button, .actions a { display: block; width: 100%; margin: 6px 0; box-sizing: border-box; }
  }
${thermal}</style>`;
};
export const invoiceScriptBase = () => `<script>
// Same optional Local Print Service integration as modules/barcode/tags_print.php -- see that
// file's comments for the full explanation. No pairing/token step needed. Falls back to the
// normal Print Invoice button above with zero change in behavior if the service isn't reachable
// on this computer.
(function () {
  const BASE = 'http://127.0.0.1:9294';
  fetch(BASE + '/printers')
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(data => {
      if (!data.success || !data.printers || !data.printers.length) return;
      const sel = document.getElementById('localPrintPrinter');
      data.printers.forEach(function (name) {
        const opt = document.createElement('option');
        opt.value = name; opt.textContent = name;
        if (name === data.defaultPrinter) opt.selected = true;
        sel.appendChild(opt);
      });
      document.getElementById('localPrintWrap').style.display = '';
    })
    .catch(function () {});

  document.getElementById('localPrintBtn')?.addEventListener('click', function () {
    const btn = this;
    btn.disabled = true; btn.textContent = 'Printing…';
    fetch(BASE + '/print', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<!DOCTYPE html>\\n' + document.documentElement.outerHTML, printerName: document.getElementById('localPrintPrinter').value, copies: 1 }),
    })
      .then(r => r.json())
      .then(function (result) {
        btn.disabled = false; btn.textContent = 'Print via Local Service';
        if (!result.success) alert('Print failed: ' + (result.message || result.error));
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Print via Local Service';
        alert('Could not reach the Local Print Service.');
      });
  });
})();
`;
export const invoiceScriptWhatsapp = (u, j, h, id, csrf) => `document.getElementById('sendWhatsappInvoiceBtn').addEventListener('click', function () {
  const btn = this;
  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = 'Sending...';
  const formData = new FormData();
  formData.append('order_id', ${id});
  formData.append('csrf_token', ${j(csrf)});
  fetch('${h(u('api/whatsapp_send_invoice.php'))}', { method: 'POST', body: formData })
    .then(r => r.json())
    .then(function (result) {
      btn.disabled = false; btn.textContent = originalText;
      if (result.success) {
        alert('Invoice sent via WhatsApp.');
      } else {
        alert('Could not send: ' + (result.error || 'Unknown error.'));
      }
    })
    .catch(function () {
      btn.disabled = false; btn.textContent = originalText;
      alert('Could not reach the server. Please try again.');
    });
});`;
export const invoiceScriptEnd = '\n</script>';
/**
 * Rahul: a real one-click PDF download for the customer invoice -- the browser's own "Print >
 * Save as PDF" always technically worked but wasn't obvious/discoverable. No server-side PDF
 * library exists in this app (would need a Composer install on shared hosting) -- html2pdf.js
 * (client-side, renders the .sheet element itself) avoids that entirely and needs nothing
 * server-side beyond this one CDN script tag.
 */
export const invoicePdfScriptTag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"></script>';
export const invoiceScriptPdf = (sanitizedInvoiceNumber) => `// Rahul: a real one-click PDF download for the customer invoice -- the browser's own
// "Print > Save as PDF" always technically worked but wasn't obvious/discoverable. No
// server-side PDF library exists in this app (would need a Composer install on shared
// hosting) -- html2pdf.js (client-side, renders the .sheet element itself) avoids that
// entirely and needs nothing server-side beyond this one CDN script tag.
document.getElementById('downloadInvoicePdfBtn').addEventListener('click', function () {
  const btn = this;
  const original = btn.textContent;
  btn.textContent = 'Preparing...';
  btn.disabled = true;
  const filename = 'Invoice-${sanitizedInvoiceNumber}.pdf';
  html2pdf().set({
    margin: 10,
    filename: filename,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true },
    jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
  }).from(document.getElementById('invoiceSheet')).save().finally(function () {
    btn.textContent = original;
    btn.disabled = false;
  });
});`;
