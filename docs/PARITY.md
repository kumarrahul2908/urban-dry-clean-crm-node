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
| WhatsApp `order_confirmation` enqueue | queued | queued (Phase 4c; same rows as PHP — see "WhatsApp / PDF parity") |


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

## Operations modules (Phase 4a/4b)
Same harness, 20+ more scenarios (uploads, QC/rework/packing, pickup/delivery, workshop + billing). Differences kept on purpose:
* wallet `created_by` and audit rows carry the actor / IP (PHP wrote NULL in mobile calls);
* unexpected errors are logged, never returned to the client;
* mobile `createChallan` enforces the token user's fixed store (PHP skipped it because it had no session);
* Workshop Staff **not linked to a workshop** get 403 on queue/schedule and empty bills (PHP's queue exposed everything);
* barcode/QR lookup audit rows carry the acting user;
* laundry `createLaundryOrder` writes no in-app notification (same as PHP).

## WhatsApp / PDF parity (Phase 4c)
* `order_confirmation`, `order_ready`, `pickup_scheduled`, `workshop_completed` and `password_reset_request` run through the
  real `api/mobile/*.php` and the Node routes; the resulting `whatsapp_outbound_queue` rows (payload decoded), `event_ref`s,
  `notification_logs` and reset-token columns are compared (mutation-checked).
* Sending itself (Meta HTTP calls) cannot run against PHP, so the provider, worker (backoff, claim race, permanent failure),
  webhook (verification, HMAC, forward-only status ranks, inbound dedupe) and `sendInvoice` are tested in `test/whatsapp.test.ts`
  with a fake `fetch`/provider.
* **Invoice PDF**: `test/invoice-pdf.test.ts` renders 12 invoices (plain, discount/urgent/tax/notes, cancelled, laundry,
  no items, unicode, 2–3 pages, totals overflow) with the real `InvoicePdfService::render()` (FPDF) and the Node renderer and
  requires **identical page content streams** (every operator, coordinate and colour), same font table.
* Bug-compatible: queue retry time is written with PHP `date()` in `APP_TIMEZONE` but compared with the DB's UTC `NOW()`
  (retry 1 therefore waits ~5h35m instead of 5m on an IST server); `totals()` adds a page without drawing the footer on
  the previous page; characters outside cp1252 print as `?` (`₹` → `INR`, as glibc transliterates it).
* Deliberate differences: the provider returns a failure instead of throwing on a bad API version / missing phone-number id
  (PHP's worker would abort the whole batch); webhook signature compare is timing-safe; cron entry points are CLI-only
  (no `?secret=` web trigger); the password-reset link still points at `APP_URL/modules/auth/reset-password.php`
  until the Node web UI exists.

## Web UI (Phase 5)
`test/web-*.test.ts` start the **real PHP app** (`php -S`) and the Node app on the same database and compare pages: HTTP status,
redirect target and the HTML (whitespace/comments/CSRF tokens normalised). Writes are run PHP-first, the database is rolled
back to a snapshot, then Node runs the same request; resulting rows and audit entries must match.
* Rows that tie on every `ORDER BY` key come back in unspecified order from MariaDB (PHP as much as Node); fixtures use
  distinct keys, or the comparison treats the rows of a `<tbody>` as a set.
* **PHP defect, not reproduced:** *Import Customers → Confirm* aborts with "There is already an active transaction" whenever
  at least one row has to be **created** (`generate_customer_code()` opens its own transaction inside the importer's). Updates
  and skips work. Node completes the import (the code counter simply joins the importer's transaction).
* **PHP defect, not reproduced:** *Import Orders (historical) → Confirm* aborts the same way (order/invoice/customer number generators open their own
  transaction inside the importer's) as soon as one valid order has to be created. Node runs the whole import in one transaction and completes it
  (tests: PHP aborts, Node succeeds).
* **PHP defect, fixed in Node:** `modules/barcode/garment_detail.php?laundry_garment_id=…` always dies with "Column 'id' in ORDER BY is ambiguous"
  (`LaundryGarmentService::getHistory()` orders by an unqualified `id` over a join with `users`), so the Laundry garment detail page never worked in
  PHP. Node orders by `gsh.id` and renders the page (test asserts PHP 500 / Node 200).
* **PHP quirk kept on purpose:** `QrEncoder` treats QR versions 6–9 as a single Reed-Solomon block (the standard uses two), so a payload longer than
  108 bytes yields a code most scanners cannot read. The Node port (`src/lib/qrEncoder.ts`) is byte-identical to the PHP SVG (property test against PHP,
  including `sprintf('%.3f')` round-half-even ties) so tags print exactly as before; tag payloads are well below that size.
* Audit rows written by Node store JSON without PHP's `\/` escaping (identical once parsed).

### Phase 5e notes
* `modules/pricelist/import.php` still carries "TEMPORARY DIAGNOSTIC" panels and a blocking `alert()` on upload in PHP; the Node page omits them (the parity test strips them from the PHP HTML).
* Web multipart uploads accept up to 200 files per request (bulk garment images); PHP's `max_file_uploads`/`post_max_size` silently cut such batches. The 8 MB `order_photo_upload` cap is not applied in Node (consistent with the mobile photo decision); WhatsApp media keeps its 10 MB cap (PHP's own 8 MB `post_max_size` rejects bigger bodies earlier, so that case cannot be compared).
* Queries use PHP's exact `ORDER BY`; ties are unspecified in both.
* Salted/random values (bcrypt hashes, AES-GCM ciphertexts, uploaded file names, tokens) are masked in the DB comparison.

## Changelog 2026-10-20..22 (live PHP CRM, `crm.urbandryclean.in`)
Ported from the changelog + the backup repo's commits after `39d2f4f`; compared with the REAL updated PHP (`scripts/make-php-parity-app.sh` rebuilds `/tmp/php-parity` from the backup repo).

| Item | Node | Test |
|---|---|---|
| Short Order Code is the user-facing identifier (≈34 PHP files): create/return values, every mobile list/detail/search/lookup endpoint, `WorkshopScope::ws_schedule_data`, `LaundryGarmentService::listByStatus`, web order pages/receipt/invoice/export, WhatsApp variables; searches match either format | `src/routes/mobile/*`, `src/services/{orderService,workshopScope,laundryGarmentService}.ts`, `src/web/pages/{orders,orderPorts}.ts` | `endpoint-parity` (all list endpoints + `Set garments + order_item_update + short code everywhere`), `parity`, `web-*` |
| Multi-piece Set garments: `garments.pieces_per_unit/piece_names`, copied onto `order_items`; tags = quantity × pieces with an order-wide running sequence; `barcodes.piece_index` + composite unique | `db/migrations/2026_10_21_*`, `GarmentTagService`, `OrderService` | `parity` (Set garments, laundry), `web-design` (tags print) |
| `OrderService::updateItem` + `order_item_update` (garment/service not editable, no tag regeneration, `order_created` only) | `OrderService.updateItem`, `routes/mobile/orders.ts` | `parity`, `endpoint-parity` |
| Tag Design / Invoice Design (data-driven printing; toggles, terms, 4 new invoice sections) | `src/web/pages/designPages.ts`, `barcodeTags.ts`, `orders.ts` (invoice), tables seeded to the previous hard-coded look | `web-design` |
| Dormant Customers report, `120/180+` segments, `inactiveDaysReport`, `daysSinceLastOrder`, customer "Days since last order" card | `customerSegments.ts`, `designPages.ts`, `customers.ts` | `web-design` |
| Workshop billing: "Whole Bill" basis (default) vs "Sent to Workshop Only", `billing_basis`, GST/`grand_total` balance fixes, `store_id=all` + `gst_mode` + `basis` in `workshop_billing_generate`, `bill_item_id`, "Mark Unprocessed" wording | `workshopInvoice.ts`, `routes/mobile/workshop.ts`, `workshopBilling.ts` | `endpoint-parity` (workshop), `web-workshop` |
| `garments_for_pos` / `pos_garments` return `pieces_per_unit`; POS summary shows Quantity vs Pieces and "(N pieces)"; manual wa.me popup removed (WhatsApp confirmation is queued by the order service); print-service prompt remembers a successful ping forever | `posApis.ts`, `catalog.ts`, `pos*.ts`, `layout.ts` | `web-accounts`, `endpoint-parity` |

Deliberate differences / things the PHP backup repo does not have yet:
* **Counters are `MAX(existing)+1`** (order number, short code, invoice, payment, refund, pickup, delivery, challan, customer code): a counter that fell behind real data (the live-CRM drift in changelog §1) heals itself instead of failing on a duplicate key. In PHP that still needs the one-off `UPDATE settings …` on the live database. (`test/changelog.test.ts`.)
* **Tag numbers after removing a middle item**: PHP's `addItem` uses "pieces on the other items + 1", which re-issues a number that is already on a printed tag and then fails with a duplicate `barcode_value`; Node also stays above `MAX(item_sequence)` on the order. Identical results wherever PHP succeeds.
* **`pos_garments.php` `pieces_per_unit`** is in the changelog (§9) but not in the backup repo: Node follows the changelog; the throw-away PHP copy is patched the same way.
* **Web POS defaults (changelog §8)** — due date suggestion already existed on the web; Service/Category pre-selection and the immediate garment grid are *new in Node only* (the live PHP web POS still lacks them). The same block (`test/parity/pos-defaults.js`) is inserted into the PHP parity copy so the HTML comparison stays meaningful. Port it to `modules/pos/index.php` if the PHP site is kept running.
* **Workshop invoice photos** (`workshop_billing_photos`, `…_photo_upload`, `…_photo_delete`): new table `workshop_bill_photos`; like the order photos there is no hard 8 MB cap (the configured upload limit applies). Node-only tests (`test/changelog.test.ts`) because the PHP side cannot be driven with multipart in the endpoint harness.
* Tie-breakers for rows with equal sort keys (`ORDER BY …, oi.id / wbi.id / t.wi_id`) — PHP leaves them unspecified; the parity copy gets the same ones.
* Migrations: `2026_10_21*` / `2026_10_22*` are idempotent — on the live `crm` database (where PHP's own ALTERs were applied by hand) `npm run migrate` just records them (`Duplicate column`/`already exists` are treated as applied).
