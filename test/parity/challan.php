<?php
// Renders ONE challan PDF with the real ChallanPdfService::generate(): argv[1]=out, argv[2]=comma order ids, argv[3]=with_amount, argv[4]=number, argv[5]=format.
require_once __DIR__ . '/includes/bootstrap_mobile.php';
require_once __DIR__ . '/includes/functions.php';
require_once __DIR__ . '/includes/ChallanPdfService.php';
$r = ChallanPdfService::generate(array_map('intval', explode(',', $argv[2])), $argv[3] === '1', $argv[4], $argv[5] ?? 'aggregated');
if (!$r['success']) { echo 'fail:' . $r['error']; exit(1); }
copy($r['file_path'], $argv[1]); @unlink($r['file_path']);
echo 'ok';
