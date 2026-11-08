import { readFile, stat } from 'node:fs/promises';
import { WebRedirect, WebText, webPage } from '../context.js';
import { html, raw } from '../html.js';
import { layout } from '../layout.js';
import { urlencode } from '../format.js';
const str = (v) => (typeof v === 'string' ? v : '');
const clean = (v) => str(v).trim();
const body = (ctx) => (ctx.req.body ?? {});
const csrfFail = () => new WebText('Invalid or expired security token (CSRF). Please refresh the page and try again.', 419);
/** format_file_size() */
const formatFileSize = (bytes) => {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1048576)
        return `${Math.round((bytes / 1024) * 10) / 10} KB`;
    return `${Math.round((bytes / 1048576) * 100) / 100} MB`;
};
/**
 * Web-based local backup -- "Take Backup Now" button plus the list this page shows doubles as
 * what the nightly automated backup (same DatabaseBackupService.run()) also produces into, so
 * both paths land in the one list here. Files themselves live outside the web-servable tree --
 * downloads only ever go through this page's own download action, which checks the admin.settings
 * permission before streaming anything.
 */
export function registerAdminBackupPages(app) {
    const { backup, audit } = app.services;
    webPage(app, '/modules/admin/backup', { auth: 'admin.settings' }, async (ctx, req) => {
        const u = (p) => ctx.baseUrl(p);
        const uid = ctx.data.user_id ?? null;
        if (req.method === 'POST' && 'action' in body(ctx)) {
            if (!ctx.csrfValid())
                return csrfFail();
            const p = body(ctx);
            if (p.action === 'run_backup') {
                const result = await backup.run();
                if (result.success) {
                    await audit.record({ action: 'create', module: 'backup', recordId: result.file, newValue: { size_bytes: result.size_bytes, trigger: 'manual' }, userId: uid, ip: req.ip });
                    ctx.flashSet('success', `Backup created: ${result.file} (${formatFileSize(result.size_bytes)}).`);
                }
                else {
                    ctx.flashSet('danger', `Backup failed: ${result.errors.join(' ')}`);
                }
                return new WebRedirect('modules/admin/backup.php');
            }
            else if (p.action === 'delete_backup') {
                const filename = clean(p.filename);
                if (await backup.delete(filename)) {
                    await audit.record({ action: 'delete', module: 'backup', recordId: filename, userId: uid, ip: req.ip });
                    ctx.flashSet('success', 'Backup deleted.');
                }
                else {
                    ctx.flashSet('danger', 'Could not delete that backup.');
                }
                return new WebRedirect('modules/admin/backup.php');
            }
        }
        // Download: separate from the POST actions above since a download is a GET (browsers don't
        // let a download link be a form submit the same way) -- same permission gate still applies,
        // filename re-validated the same way (never trust a query string for a filesystem path).
        const q = req.query;
        if ('download' in q) {
            const filename = clean(q.download);
            const path = backup.pathFor(filename);
            if (!path)
                return new WebText('Invalid backup filename.', 400);
            const exists = await stat(path).catch(() => null);
            if (!exists)
                return new WebText('Backup not found.', 404);
            await audit.record({ action: 'lookup', module: 'backup', recordId: filename, newValue: { action: 'download' }, userId: uid, ip: req.ip });
            const buf = await readFile(path);
            return new WebText(buf, 200, 'application/gzip', { 'Content-Disposition': `attachment; filename="${filename}"` });
        }
        const backups = await backup.list();
        return layout(ctx, { title: 'Database Backup' }, html `
<div class="container-fluid py-3">
  <h4 class="fw-bold mb-3"><i class="fa-solid fa-database me-2"></i>Database Backup</h4>

  <div class="card mb-3">
    <div class="card-body">
      <p class="text-muted mb-3">Take a full backup of the database right now, or let the nightly automated backup (set up separately, once a day) handle it. Every backup here is a complete, self-contained copy -- safe to download and keep anywhere.</p>
      <form method="POST">
        ${ctx.csrfField()}
        <input type="hidden" name="action" value="run_backup">
        <button type="submit" class="btn btn-primary"><i class="fa-solid fa-circle-down me-1"></i>Take Backup Now</button>
      </form>
    </div>
  </div>

  <div class="card">
    <div class="card-header fw-bold">Existing Backups</div>
    <div class="table-responsive">
      <table class="table table-sm align-middle mb-0">
        <thead><tr><th>File</th><th>Date &amp; Time</th><th>Size</th><th style="width:160px;"></th></tr></thead>
        <tbody>
          ${backups.length === 0 ? html `
          <tr><td colspan="4" class="text-center text-muted py-4">No backups yet. Click "Take Backup Now" above to create the first one.</td></tr>` : backups.map((b) => html `
          <tr>
            <td><code>${b.filename}</code></td>
            <td>${raw(ctx.datetime(new Date(b.modified_at * 1000).toISOString().slice(0, 19).replace('T', ' '), 'd M Y, h:i A'))}</td>
            <td>${formatFileSize(b.size_bytes)}</td>
            <td>
              <a href="?download=${urlencode(b.filename)}" class="btn btn-sm btn-outline-primary"><i class="fa-solid fa-download"></i></a>
              <form method="POST" class="d-inline" onsubmit="return confirm('Delete this backup? This cannot be undone.');">
                ${ctx.csrfField()}
                <input type="hidden" name="action" value="delete_backup">
                <input type="hidden" name="filename" value="${b.filename}">
                <button type="submit" class="btn btn-sm btn-outline-danger"><i class="fa-solid fa-trash"></i></button>
              </form>
            </td>
          </tr>`)}
        </tbody>
      </table>
    </div>
  </div>
</div>
`);
    });
}
