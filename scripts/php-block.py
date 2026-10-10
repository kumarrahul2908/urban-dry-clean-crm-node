#!/usr/bin/env python3
"""Copies a static <style>/<script> region of a PHP page into a TS template-literal function.
usage: php-block.py <php-file> <first-line> <last-line> <exportName>   (1-based, inclusive)
Supported PHP echoes inside the region: json_encode(base_url('p')), e(base_url('p')), base_url('p'), (int)$var -> a.var, json_encode(csrf_token()) -> a.csrf; any other <?= expr ?> becomes x[i] (documented above the export, supplied by the caller).
The generated function takes `u: (path) => string` (ctx.baseUrl) and `j: (v) => string` (jsonEncode) and `h: (v)=>string` (escape)."""
import re, sys
f, a, b, name = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
lines = open(f, encoding='utf-8').read().split('\n')[a-1:b]
t = '\n'.join(lines)
t = t.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')
t = re.sub(r"<\?= json_encode\(base_url\('([^']*)'\)\) \?>", r"${j(u('\1'))}", t)
t = re.sub(r"<\?= e\(base_url\('([^']*)'\)\) \?>", r"${h(u('\1'))}", t)
t = re.sub(r"<\?= base_url\('([^']*)'\) \?>", r"${u('\1')}", t)
t = re.sub(r"<\?= \(int\)\$(\w+) \?>", r"${a.\1}", t)
t = re.sub(r"<\?= json_encode\(csrf_token\(\)\) \?>", r"${j(a.csrf)}", t)
exprs = []
def _generic(m):
    exprs.append(m.group(1).strip())
    return '${x[%d]}' % (len(exprs) - 1)
t = re.sub(r"<\?= (.*?) \?>", _generic, t)
if '<?' in t:
    sys.exit('unsupported PHP left in block: ' + t[t.index('<?'):t.index('<?') + 80])
doc = ''.join(f'// x[{i}] = <?= {e} ?>\n' for i, e in enumerate(exprs))
print(f"{doc}export const {name} = (u: (p: string) => string, j: (v: unknown) => string, h: (v: unknown) => string, a: Record<string, unknown> = {{}}, x: string[] = []): string => `{t}`;")
