# PHP ↔ Node parity notes (OrderService, wallet, customers)

`test/parity.test.ts` runs identical scenarios through the **real PHP `OrderService`** (copied from the
backup repo by `scripts/make-php-parity-app.sh`) and the Node port on freshly seeded databases, then compares
the results and orders, items, barcodes, tags, payments, receivables, wallet, counters, notifications and audit
rows. Mutation checks confirmed it catches rounding and discount-remainder regressions.

```bash
scripts/make-php-parity-app.sh ../urban-dry-clean-crm-backup /tmp/php-parity
PARITY_PHP_APP=/tmp/php-parity TEST_DB_NAME=... TEST_DB_USER=... TEST_DB_PASS=... TEST_DB_PORT=... npm test
```
(Compared on PHP 8.3 locally; production PHP is 7.2 — `round()` pre-rounding behaves the same for money values.)

## Reproduced on purpose (bug-compatible)
- **`discount_type` omitted by the client** → PHP stores `NULL` and prices the discount as **Flat**
  (`NULL !== 'Percent'`). Node does the same, so an old client's totals never change. Worth fixing in both
  apps later (default to `'Percent'`).
- Payment/refund/order/invoice numbers come from the same `settings` counters under a row lock; a counter is
  not burned when there is nothing to record.
- Customer barcode = `barcode_prefix + '-CUST-' + substr(code, -6)` (double dash when the prefix ends in `-`).
- `createLaundryOrder` writes no in-app `order_created` notification (only `createOrder` does).

## Deliberate differences
| Area | PHP | Node |
|---|---|---|
| Wallet ledger `created_by` for order-driven wallet movements (payment redeem, refund credit) | `NULL` (no session in mobile) | the acting user id |
| Audit rows from order services | `user_id`/`ip` `NULL` unless passed | acting user + request IP |
| Unexpected errors (SQL etc.) in order/payment/refund | message text (incl. SQL fragments) returned to the client | logged server-side; client sees "An unexpected error occurred." |
| `client_request_id` on order creation | written by a second UPDATE after commit | written in the INSERT (race-free); a duplicate falls back to the idempotent replay |
| Replay response `grand_total` | string from the DB | number (same as a fresh create) |
| WhatsApp `order_confirmation` enqueue | queued | **not yet** — `OrderHooks` is a logged no-op until the WhatsApp service is ported (Phase 4) |

## Not in this phase
Order photo upload/delete/list (file storage), rework endpoints, delivery/pickup/packing/QC/workshop
actions — Phase 4 (operations modules).

## Endpoint-level parity (Phase 3)
`test/endpoint-parity.test.ts` runs the real `api/mobile/<name>.php` (through `test/parity/endpoint.php`, which feeds
GET query / JSON body / bearer token exactly like the web server) and the Node route against the **same seeded
database** and compares HTTP status + JSON; write endpoints are run on two identically rebuilt databases and the
resulting rows are compared too. 50 cases: dashboards, reports, ageing, daily collection, customer history, audit
log (incl. redaction), feedback, expenses/income, notifications, garments, barcode/QR lookups, permission failures.

Notes
- Numbers vs numeric strings are treated as equal (PHP's PDO returned many columns as strings).
- When rows tie on every ORDER BY key MariaDB returns them in unspecified order on each execution, for PHP as much
  as for Node; the harness accepts a difference only in the order of such tied rows (same multiset).
- Differences kept on purpose: barcode/QR lookup audit rows now carry the acting user (PHP wrote NULL);
  `garment_image`, `order_photo_*` (file storage), `password_reset_request` and `whatsapp_send_invoice`
  (WhatsApp) are Phase 4.
