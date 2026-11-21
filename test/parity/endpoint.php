<?php
// Runs ONE api/mobile/<name>.php exactly as the web server would (GET query, JSON body, bearer token) and
// prints "<json>\n@@STATUS:<code>".
$in = json_decode(stream_get_contents(STDIN), true);
$_SERVER['REQUEST_METHOD'] = $in['method'];
$_GET = $in['query'] ?: [];
$_POST = $in['post'] ?? []; // form fields (multipart/urlencoded endpoints read $_POST)
$_SERVER['HTTP_AUTHORIZATION'] = $in['token'] ? 'Bearer ' . $in['token'] : '';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
class InputWrap {
    public static $data = '';
    public $context; private $pos = 0;
    function stream_open($path, $mode, $options, &$opened) { $this->pos = 0; return true; }
    function stream_read($n) { $r = substr(self::$data, $this->pos, $n); $this->pos += strlen($r); return $r; }
    function stream_eof() { return $this->pos >= strlen(self::$data); }
    function stream_stat() { return []; }
}
InputWrap::$data = $in['body'] ?? '';
stream_wrapper_unregister('php');
stream_wrapper_register('php', 'InputWrap');
register_shutdown_function(function () { echo "\n@@STATUS:" . (http_response_code() ?: 200); });
chdir(__DIR__ . '/api/mobile');
require __DIR__ . '/api/mobile/' . $in['name'] . '.php';
