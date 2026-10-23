<?php
// Runs ONE OrderService operation from a JSON scenario on stdin and prints the result as JSON.
require_once __DIR__ . '/includes/bootstrap_mobile.php';
$s = json_decode(stream_get_contents(STDIN), true);
$u = $s['user_id'] ?? 1;
switch ($s['op']) {
    case 'createOrder':       $r = OrderService::createOrder($s['input'], $u, $s['can_override_discount'] ?? false, $s['store_id'] ?? 1, $s['can_manual_override'] ?? false); break;
    case 'createLaundryOrder':$r = OrderService::createLaundryOrder($s['input'], $u, $s['can_override_discount'] ?? false, $s['store_id'] ?? 1); break;
    case 'recordPayment':     $r = OrderService::recordPayment($s['order_id'], $s['customer_id'], $s['lines'], (float)($s['wallet'] ?? 0), $u, true, null, $s['client_request_id'] ?? null, $s['fingerprint'] ?? null); break;
    case 'processRefund':     $r = OrderService::processRefund($s['order_id'], (float)$s['amount'], $s['lines'] ?? [], (bool)($s['to_wallet'] ?? false), $s['reason'], $s['remarks'] ?? '', $u, $s['client_request_id'] ?? null, $s['fingerprint'] ?? null); break;
    case 'addItem':           $r = OrderService::addItem($s['order_id'], $s['item'], $u, $s['can_manual_override'] ?? false, $s['client_request_id'] ?? null); break;
    case 'updateItem':        $r = OrderService::updateItem($s['order_id'], $s['item_id'], $s['raw'], $u, $s['can_manual_override'] ?? false); break;
    case 'removeItem':        $r = OrderService::removeItem($s['order_id'], $s['item_id'], $u); break;
    case 'editOrder':         $r = OrderService::editOrder($s['order_id'], $s['changes'], $u, $s['reason'] ?? '', $s['can_override_discount'] ?? false); break;
    case 'cancelOrder':       $r = OrderService::cancelOrder($s['order_id'], $s['reason'], $u); break;
    default: $r = ['success' => false, 'errors' => ['unknown op']];
}
echo json_encode($r);
