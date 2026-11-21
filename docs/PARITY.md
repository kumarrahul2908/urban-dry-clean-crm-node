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

## Changelog 2026-10-23..24 (live PHP CRM)
Ported from the 2nd changelog + the backup repo's commits `aebc87c..4bb0fa2`; compared with the real updated PHP.

| Item | Node | Test |
|---|---|---|
| `OrderService.removeItem` renumbers every remaining tag to a gapless 1..N (sequence AND the pre-built `barcode_value`/`short_qr_payload` text) — new business rule, accepted tradeoff that an already-printed tag may no longer match | `OrderService.renumberTagSequences` | `parity` ("removing a MIDDLE item renumbers…"), `changelog.test.ts` |
| Tag print: `total_items` denominator is `SUM(quantity*pieces_per_unit)` (physical pieces), not a line `COUNT(*)`; `piece_names` cycles within a Set via `((piece_index-1) % pieces_per_unit)+1` for `quantity > 1`; the piece particular is unconditional (not gated by the Tag Design toggle, which still only controls its styling and the generic "Piece X of Y" fallback); combined `garment_name` is omitted once a particular is shown, replaced by `"<particular> (<item_sequence>/<total_items>)"` | `barcodeTags.ts` | `web-design` (tags print), `parity` (Set garments) |
| Workshop piece-vs-line undercount, fixed in 4 places independently in PHP: dashboard badges/store-wise summary/queue-card badges, `challan_print`/`challan_view` (+ new Amount column, laundry "once per batch", `challan_print`'s Driver Name/Signature line), `report.php`'s Bill Summary garments column + short order code. Centralized into one helper (`piecesInLine`) instead of repeating the pattern | `lib/garmentPieces.ts`, `workshop.ts`, `workshopReport.ts` | `web-workshop` ("Set garments through the workshop…") |
| Customer invoice "Download PDF" (html2pdf.js, client-side, zero server dependency) | `invoice.static.ts` (`invoicePdfScriptTag`, `invoiceScriptPdf`), `orders.ts` | `web-orders` (byte-identical against PHP) |
| "Send Invoice" on WhatsApp button added to Order Details (same endpoint the Invoice page already used) | `orders.static.ts` (`orderViewScript`), `orders.ts` | `web-orders` |
| New services Starching + Polishing (piece, garment-scoped) + price_list_items at every existing garment × price list, seeded at 0.00 | `db/migrations/2026_10_24_starching_polishing_services.sql` | smoke-tested via migration run; exercised incidentally by every parity test that reads `services` |

Not ported (PHP itself hasn't done them, so Node stays bug-for-bug consistent with PHP rather than fixing ahead of it):
* `modules/workshop/index.php`'s own counts — explicitly flagged in the changelog as "not yet audited" even in PHP.
* Customer bulk import (one-off `phpMyAdmin` SQL run against the live DB, not a feature — nothing to port). The self-correcting `customer_code` pattern it uses was already adopted in Node for the first changelog's counter-drift fix.
* Android-only items (camera permission fix, backup-script commit message) — not applicable to the web/Node port.

## Backend fixes 2026-11-01 (mobile API gaps found while auditing the WPF client, not ported from a PHP changelog)
These close 4 gaps the WPF client's own "Known Gaps" notes had flagged as unfixable from the client side; the PHP backup
repo was not consulted (see note below), so this is a Node-side correctness pass rather than a parity port.

| Item | Node | Test |
|---|---|---|
| `laundry_orders_create` never read `store_id` from its payload, so a floating-store account (`users.store_id IS NULL`) could never create a Per-Weight order — `pos_orders_create` already accepted it the same way `createOrder` does | `routes/mobile/orders.ts` (`resolveAuthorizedStoreId(db, ctx, requested)` + `store_required`/`needs_selection` on the same shape `pos_orders_create` uses) | `orders.integration.test.ts` ("accepts an explicit store_id for a floating-store…") |
| `createLaundryOrder`'s batch loop trusted the client-supplied `batch.rate` instead of resolving it from the price list, the way `priceLine()` already does for piece orders | `OrderService.createLaundryOrder` (`PricingEngine.getUniversalRate`) | `orders.integration.test.ts` ("rate is resolved server-side, never trusted from the client", "rejects a service with no universal (per-weight) rate configured") |
| `priceLine()`'s non-override branch still read `rate_override` when a price was already configured, so sending `rate_override` **without** `manual_override: true` silently applied it with neither the `pos.manual_rate_override` permission check nor the audit trail (`is_manual_override`) that the override path requires | `OrderService.priceLine` (`rate_override` now only ever takes effect together with `manual_override`; `rate_overridden` in the response now always equals `is_manual_override`) | `orders.integration.test.ts` ("rate_override only ever takes effect together with manual_override…") |
| `workshop_queue`'s `laundry_in_progress` rows never exposed the raw `workshop_items.status` column, unlike piece items' `workshop_status` — mobile clients had no state-aware way to gate Laundry workshop actions | `routes/mobile/workshop.ts` (`mapLaundry` adds `workshop_status`) | `test/mobile-workshop.test.ts` (new file) |

Not verified against PHP: whether `laundry_orders_create.php` ever accepted a store override for floating-store accounts
could not be checked (`add_repo` for the backup repo was denied this session). The fix is additive-only and carries no
regression risk for the common case — `resolveAuthorizedStoreId` ignores the new parameter entirely once a user has a
fixed `store_id`, which is unchanged by this fix either way.

## Changelog 2026-10-31..11-21 (live PHP CRM) — ported 21 Nov 2026

Source of truth for this port is the PHP repository's git history (50 commits after `395ec82`), **not** the hand-written change list: that
list is a subset (it misses the Challan module, Orders List overhaul, POS packaging, Customer Returns text…). Every item below has a
PHP ↔ Node test against the real PHP code (`PARITY_PHP_APP=/tmp/php-parity`, see `scripts/make-php-parity-app.sh`).

| Area | Node | Test |
|---|---|---|
| Orders list (date mode, per page, quick ranges, totals row), order view / edit pages, change customer, garment edit in place + "print tags again" notice, Packaging per garment, due-date search | `web/pages/orders.ts`, `orderEditItem.ts`, `services/orderService.ts` (`updateItem`, `syncItemTags`, `changeOrderCustomer`), mobile `orders.ts` | `web-orders`, `orders.integration`, `endpoint-parity` |
| Short order code everywhere (search + display: QC, packing, pickup, delivery, workshop, payments, notifications, WhatsApp texts…) | the same SQL (`COALESCE(o.short_order_code, o.order_number)`) in every page / service / mobile route | `web-ops`, `web-accounts`, `web-misc`, `web-workshop`, `endpoint-parity` |
| Delivery/pickup eligibility: a fully **Packed** order whose other garments are already Delivered | `item_status NOT IN ('Packed','Delivered') AND EXISTS (… 'Packed')` in `ops.ts`, `delivery.ts`, mobile `fulfillment.ts` | `web-ops` |
| POS Packaging radios (None / Fold / Hanger / Half Fold / Hanger + Fold) | `web/pages/pos.ts`, `pos.static.ts` | `web-accounts` |
| Order photos: view-only on the order page, delete only in Admin → Order Photos | `adminOrderPhotos.ts`, `api/order_photo_delete` (admin.settings) | `web-apimisc` |
| QR encoder fix | `lib/qrEncoder.ts` | `barcode-svg.test.ts` (byte-identical to PHP) |
| **MySQL session time zone = IST** (`SET time_zone='+05:30'` on every connection, PHP `config/database.php`) | `db/pool.ts` (`connection` hook); `scripts/make-php-parity-app.sh` does the same for the PHP side | all DB tests |
| Reports: **Delivered Orders** table + CSV | `web/pages/reports.ts`, regenerated `tpl/reports_index.ts` (`scripts/gen-tpl.extra.sh`) | `web-reports` |
| **Challans** (single order, combined summary / order-wise, **Delivery challan**), list, reports, saved WhatsApp numbers, PDF viewer, delete + send APIs; mobile `challan_*` | `web/pages/challans.ts`, `services/challanPdf.ts` (FPDF-compatible), `routes/mobile/challans.ts`; live-only tables `challans`/`challan_orders` recreated by migration | `web-challan` (HTML, DB state **and PDF page content streams byte-for-byte** in every format), `endpoint-parity-new` |
| **Workshop**: Send Report shows Packaging + Defects, billing period presets (this/last month, last completed half-month), invoice PDF (`services/workshopBillPdf.ts`, byte-identical streams), "Send invoice on WhatsApp", `bill_pdf.php`, mobile `workshop_billing_pdf` / `_send_whatsapp` | `web/pages/workshop*.ts`, `workshopBillPdf.ts` | `web-workshop`, `endpoint-parity-new` |
| **Customer Returns** (register a return of a delivered order → rework pipeline, reasons admin, returns table + CSV, mobile `order_return` / `returns_list`) | `services/returnService.ts`, `web/pages/customerReturns.ts`, `routes/mobile/returns.ts` | `web-returns`, `endpoint-parity-new` |
| **WhatsApp two-way log** (`whatsapp_messages`: every send, inbound reply/media/reaction, call events, delivery status), thread + list pages, attachments, media streaming, rewritten webhook (token from the `whatsapp_webhook_verify_token` setting; signature against the active account) | `services/whatsappService.ts`, `routes/whatsappWebhook.ts`, `web/pages/waChat.ts`, `routes/mobile/whatsappChat.ts` (live-only table recreated by migration) | `web-wachat`, `whatsapp.test.ts`, `endpoint-parity-new` |
| WhatsApp **bulk campaigns + self-service Meta templates** (create → submit → sync status → queue per customer), challan / workshop-invoice **document templates** (`submit…Template`), caller lookup API | `whatsappService.ts`, `whatsapp/provider.ts` (`createDocumentTemplate`, `createTextTemplate`, `listTemplateStatuses`) | `web-wachat` (no-account paths against PHP), `endpoint-parity-new`; the Meta calls themselves are not testable offline |
| **Firebase push** (FCM v1, service account encrypted in `settings`), `fcm_register`, settings page | `services/firebaseService.ts`, `web/pages/waChat.ts`, `routes/mobile/whatsappChat.ts` (live-only `fcm_tokens` table recreated by migration) | `web-wachat` (page + actions), `endpoint-parity-new` |

### Deliberate differences from the live PHP (Node is right, PHP has a bug)
* `api/mobile/workshop_queue.php`: `defect_names` is **always `[]`** in PHP — its `array_map(function ($r) { … $pieceDefectsByItem[…] })` closure has no `use ($pieceDefectsByItem)`. Node returns the real names. The parity test does not compare that key. (PHP fix: `use ($pieceDefectsByItem)` or an arrow function.)

### Known follow-ups
* `format_date()` still converts full datetimes from UTC to the display zone (unchanged in PHP). Since the connection is now IST, values written after 21 Nov are shifted twice by every page that uses it; pages that use PHP's own `date()` (e.g. the Delivered Orders report) are right. Fix in both apps together (`wallDate()` in `web/format.ts` is the "no conversion" helper).
* The six failures that were red before this port (laundry-rate server-side resolution, see "Backend fixes 2026-11-01") are unchanged: `parity.test.ts` ×3, `endpoint-parity.test.ts` ×3.
