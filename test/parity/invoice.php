<?php
// Renders ONE invoice PDF with the real InvoicePdfService::render() from a JSON scenario on stdin; writes it to argv[1].
require_once __DIR__ . '/includes/bootstrap_mobile.php';
require_once __DIR__ . '/includes/InvoicePdfService.php';
$s = json_decode(stream_get_contents(STDIN), true);
InvoicePdfService::render($s['order'], $s['items'], $s['business'], $argv[1]);
echo 'ok';
