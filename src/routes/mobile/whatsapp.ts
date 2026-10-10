import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, ok } from '../../lib/http.js';
import { toInt } from '../../lib/php.js';

/** Ports of api/mobile/password_reset_request.php and api/mobile/whatsapp_send_invoice.php. */
export async function registerMobileWhatsAppRoutes(app: FastifyInstance) {
  const { db, passwordReset, whatsapp } = app.services;
  const both = (name: string, handler: (req: FastifyRequest) => Promise<unknown>) => {
    app.post(`/${name}`, handler);
    app.post(`/${name}.php`, handler);
  };

  // Unauthenticated by design (the user cannot log in). Always answers the same generic message.
  both('password_reset_request', async (req) => {
    const p = req.body as Record<string, unknown> | null;
    const raw = p && typeof p === 'object' && !Array.isArray(p) ? p.identifier : undefined;
    const identifier = typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
    const r = await passwordReset.request(identifier, req.ip);
    return ok({ configured: r.configured, message: r.message });
  });

  both('whatsapp_send_invoice', async (req) => {
    const ctx = await app.requireToken(req);
    app.requirePermission(ctx, 'billing.view');
    const p = req.body;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ApiError('invalid_request', 'Invalid request payload.', 400);
    const orderId = toInt((p as Record<string, unknown>).order_id);
    if (!orderId) throw new ApiError('invalid_request', 'A valid order_id is required.', 422);
    const rows = await db.query<{ mobile: string | null }>('SELECT o.customer_id, o.invoice_number, c.mobile FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?', [orderId]);
    const order = rows[0];
    if (!order) throw new ApiError('not_found', 'Order not found.', 404);
    if (!order.mobile) throw new ApiError('invalid_request', 'This customer has no mobile number on file.', 422);
    const r = await whatsapp.sendInvoice(orderId, ctx.id);
    if (!r.success) {
      const pdf = r.code === 'pdf_failed';
      throw new ApiError(pdf ? 'server_error' : 'send_failed', r.error ?? 'Could not send the invoice.', pdf ? 500 : 502);
    }
    return ok({ sent: true, mode: r.mode });
  });
}
