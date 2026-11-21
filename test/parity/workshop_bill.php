<?php
// Renders ONE workshop invoice PDF with the real WorkshopBillPdfService::generate() for bill id argv[2]; copies it to argv[1].
require_once __DIR__ . '/includes/bootstrap_mobile.php';
require_once __DIR__ . '/includes/WorkshopBillPdfService.php';
$r = WorkshopBillPdfService::generate((int)$argv[2]);
if (!$r['success']) { echo 'fail:' . $r['error']; exit(1); }
copy($r['file_path'], $argv[1]); @unlink($r['file_path']);
echo 'ok';
