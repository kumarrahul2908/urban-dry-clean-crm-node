#!/usr/bin/env python3
"""Transpiles the HTML-template part of a PHP page into an imperative TypeScript function.
usage: php-tpl.py <php-file> <first-line> <last-line> <exportName>        (1-based, inclusive; region = the template, from after header.php to before footer.php)

PHP semantics are kept explicit: `<?= e($x) ?>` -> out += e(x); `<?= $x ?>` -> out += S(x) (raw). Conditions use T() (PHP truthiness),
`.` is S(a)+S(b), `+` is add(), `==` is looseEq(). Unknown functions are emitted as h.fn(...) and listed in the header comment, to be supplied by the caller.
"""
import os, re, sys

class Fail(Exception): pass

# ---------------------------------------------------------------- tokenizer
TOK = re.compile(r"""
 (?P<ws>\s+)
|(?P<cast>\(\s*(?:int|integer|string|float|double|bool|boolean|array)\s*\))
|(?P<var>\$[A-Za-z_][A-Za-z0-9_]*)
|(?P<num>\d+\.\d+|\d+)
|(?P<sq>'(?:[^'\\]|\\.)*')
|(?P<dq>"(?:[^"\\]|\\.)*")
|(?P<id>[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)?)
|(?P<op>===|!==|==|!=|<>|<=|>=|\?\?|\?:|&&|\|\||=>|->|[-+*/%.<>!?:,()\[\]=;&|{}])
""", re.X)

def tokenize(s):
    pos, out = 0, []
    while pos < len(s):
        m = TOK.match(s, pos)
        if not m: raise Fail('cannot tokenize: ' + s[pos:pos+40])
        pos = m.end()
        k = m.lastgroup
        if k == 'ws': continue
        out.append((k, m.group(k)))
    return out

def js_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n') + "'"

FUNCS = {
 'e': 'e', 'format_currency': 'money', 'format_date': 'fdate', 'format_datetime': 'fdatetime', 'base_url': 'u', 'urlencode': 'urlencode', 'rawurlencode': 'rawurlencode',
 'http_build_query': 'httpBuildQuery', 'count': 'count', 'empty': 'phpEmpty', 'in_array': 'inArray', 'implode': 'implode', 'json_encode': 'jsonEncode', 'number_format': 'numberFormat',
 'ucfirst': 'ucfirst', 'strtoupper': 'strtoupper', 'strtolower': 'strtolower', 'str_pad': 'strPad', 'strlen': 'strlen', 'trim': 'trim', 'round': 'round', 'floor': 'floor', 'ceil': 'ceil',
 'abs': 'abs', 'max': 'max', 'min': 'min', 'csrf_field': 'csrfField', 'csrf_token': 'csrfToken', 'nl2br': 'nl2br', 'htmlspecialchars': 'e', 'is_numeric': 'isNumeric', 'array_keys': 'arrayKeys',
 'array_sum': 'arraySum', 'array_column': 'arrayColumn', 'array_slice': 'arraySlice', 'str_repeat': 'strRepeat', 'substr': 'substr', 'mb_strlen': 'strlen', 'str_replace': 'strReplace', 'is_array': 'isArray',
 'number_format2': 'numberFormat', 'intval': 'int', 'floatval': 'flt', 'date': 'phpDate', 'strtotime': 'strtotime', 'sprintf': 'sprintf', 'array_key_exists': 'arrayKeyExists', 'is_null': 'isNull',
 'array_merge': 'arrayMerge', 'ltrim': 'ltrim', 'rtrim': 'rtrim', 'strpos': 'strpos', 'str_contains': 'strContains', 'str_starts_with': 'strStartsWith', 'array_filter': 'arrayFilter',
 'json_decode': 'jsonDecode', 'array_values': 'arrayValues', 'array_map': 'arrayMap', 'array_flip': 'arrayFlip', 'array_search': 'arraySearch', 'is_string': 'isString', 'ucwords': 'ucwords', 'wordwrap': 'wordwrap',
 'Auth::can': 'can', 'Auth::isDeliveryManager': 'isDeliveryManager', 'Auth::fixedStoreId': 'fixedStoreId', 'Auth::activeStoreId': 'activeStoreId', 'get_setting': 'getSetting', 'time': 'time', 'mt_rand': 'mtRand',
}
CTX = {'u', 'money', 'fdate', 'fdatetime', 'csrfField', 'csrfToken', 'can', 'isDeliveryManager', 'fixedStoreId', 'activeStoreId', 'getSetting', 'phpDate', 'strtotime', 'time', 'mtRand'}
unknown = set()
assigned = set()
used = set()
helpers_used = set()
LOOP_VARS = []

class P:
    def __init__(self, toks): self.t, self.i = toks, 0
    def peek(self, o=0): return self.t[self.i+o] if self.i+o < len(self.t) else (None, None)
    def nxt(self):
        x = self.t[self.i]; self.i += 1; return x
    def isop(self, v, o=0):
        k, x = self.peek(o); return k == 'op' and x == v
    def eat(self, v):
        if not self.isop(v): raise Fail(f'expected {v} got {self.peek()}')
        self.i += 1

    def expr(self): return self.ternary()
    def ternary(self):
        c = self.coalesce()
        if self.isop('?:'):
            self.nxt(); r = self.ternary()
            return f'elvis({c}, () => {r})'
        if self.isop('?'):
            self.nxt(); a = self.ternary(); self.eat(':'); b = self.ternary()
            return f'(T({c}) ? {a} : {b})'
        return c
    def coalesce(self):
        l = self.oror()
        if self.isop('??'):
            self.nxt(); r = self.coalesce()
            return f'({l} ?? {r})'
        return l
    def oror(self):
        l = self.andand()
        while self.isop('||'):
            self.nxt(); r = self.andand(); l = f'(T({l}) || T({r}))'
        return l
    def andand(self):
        l = self.eq()
        while self.isop('&&'):
            self.nxt(); r = self.eq(); l = f'(T({l}) && T({r}))'
        return l
    def eq(self):
        l = self.rel()
        while self.peek()[0] == 'op' and self.peek()[1] in ('===', '!==', '==', '!=', '<>'):
            op = self.nxt()[1]; r = self.rel()
            if op == '===': l = f'({l} === {r})'
            elif op == '!==': l = f'({l} !== {r})'
            elif op == '==': l = f'looseEq({l}, {r})'
            else: l = f'!looseEq({l}, {r})'
        return l
    def rel(self):
        l = self.concat()
        while self.peek()[0] == 'op' and self.peek()[1] in ('<', '<=', '>', '>='):
            op = self.nxt()[1]; r = self.concat(); l = f'cmp({l}, {r}, {js_str(op)})'
        return l
    def concat(self):
        l = self.add()
        while self.isop('.'):
            self.nxt(); r = self.add(); l = f'(S({l}) + S({r}))'
        return l
    def add(self):
        l = self.mul()
        while self.peek()[0] == 'op' and self.peek()[1] in ('+', '-'):
            op = self.nxt()[1]; r = self.mul()
            l = f'add({l}, {r})' if op == '+' else f'(num({l}) - num({r}))'
        return l
    def mul(self):
        l = self.unary()
        while self.peek()[0] == 'op' and self.peek()[1] in ('*', '/', '%'):
            op = self.nxt()[1]; r = self.unary()
            l = {'*': f'(num({l}) * num({r}))', '/': f'(num({l}) / num({r}))', '%': f'mod({l}, {r})'}[op]
        return l
    def unary(self):
        k, v = self.peek()
        if k == 'op' and v == '!':
            self.nxt(); return f'!T({self.unary()})'
        if k == 'op' and v == '-':
            self.nxt(); return f'(-num({self.unary()}))'
        if k == 'cast':
            self.nxt(); c = re.sub(r'[()\s]', '', v)
            x = self.unary()
            return {'int': f'int({x})', 'integer': f'int({x})', 'string': f'S({x})', 'float': f'flt({x})', 'double': f'flt({x})', 'bool': f'T({x})', 'boolean': f'T({x})', 'array': f'toArray({x})'}[c]
        return self.postfix()
    def postfix(self):
        x = self.primary()
        while True:
            if self.isop('['):
                self.nxt()
                if self.isop(']'): raise Fail('[] append in expression')
                k = self.expr(); self.eat(']')
                m = re.fullmatch(r"'([A-Za-z_][A-Za-z0-9_]*)'", k)
                x = f'({x}?.{m.group(1)} ?? null)' if m else f'({x}?.[{k}] ?? null)'
            elif self.isop('->'):
                raise Fail('object access not supported')
            else: break
        return x
    def args(self):
        self.eat('('); a = []
        while not self.isop(')'):
            a.append(self.expr())
            if self.isop(','): self.nxt()
        self.eat(')'); return a
    def primary(self):
        k, v = self.nxt()
        if k == 'num': return v
        if k == 'sq': return js_str(re.sub(r"\\(['\\])", r'\1', v[1:-1]))
        if k == 'dq': return self.dq(v[1:-1])
        if k == 'var':
            n = v[1:]; used.add(n)
            return 'query' if n == '_GET' else ('post' if n == '_POST' else n)
        if k == 'op' and v == '(':
            x = self.expr(); self.eat(')'); return f'({x})'
        if k == 'op' and v == '[':
            items = []
            while not self.isop(']'):
                a = self.expr()
                if self.isop('=>'):
                    self.nxt(); b = self.expr(); items.append(('kv', a, b))
                else: items.append(('v', a))
                if self.isop(','): self.nxt()
            self.eat(']')
            if any(i[0] == 'kv' for i in items):
                return 'new Map<any, any>([' + ', '.join(f'[{i[1]}, {i[2]}]' if i[0] == 'kv' else f'[{n}, {i[1]}]' for n, i in enumerate(items)) + '])'
            return '[' + ', '.join(i[1] for i in items) + ']'
        if k == 'id':
            low = v.lower()
            if low in ('true', 'false', 'null'): return low
            if self.isop('('):
                if v == 'isset':
                    self.nxt(); a = self.expr(); self.eat(')'); return f'({a} !== undefined && {a} !== null)'
                if v == 'empty':
                    self.nxt(); a = self.expr(); self.eat(')'); return f'phpEmpty({a})'
                a = self.args()
                if v in FUNCS: helpers_used.add(FUNCS[v]); return f'{FUNCS[v]}({", ".join(a)})'
                unknown.add(v); return f'h.{v.replace("::", "_")}({", ".join(a)})'
            if v in ('PHP_INT_MAX',): return 'Number.MAX_SAFE_INTEGER'
            if v == 'ENT_QUOTES': return '3'
            raise Fail('bare identifier ' + v)
        raise Fail(f'unexpected token {k} {v}')
    def dq(self, s):
        # simple interpolation: $var, {$var['k']} ; escapes \n \t \" \\ \$
        parts, buf, i = [], '', 0
        while i < len(s):
            c = s[i]
            if c == '\\' and i + 1 < len(s):
                n = s[i+1]; buf += {'n': '\n', 't': '\t', '"': '"', '\\': '\\', '$': '$'}.get(n, '\\' + n); i += 2; continue
            if c == '$' and i + 1 < len(s) and re.match(r'[A-Za-z_]', s[i+1]):
                m = re.match(r'\$[A-Za-z_][A-Za-z0-9_]*', s[i:])
                if buf: parts.append(js_str(buf)); buf = ''
                parts.append(f'S({P(tokenize(m.group(0))).expr()})'); i += len(m.group(0)); continue
            if c == '{' and s[i+1:i+2] == '$':
                j = s.index('}', i)
                if buf: parts.append(js_str(buf)); buf = ''
                parts.append(f'S({P(tokenize(s[i+1:j])).expr()})'); i = j + 1; continue
            buf += c; i += 1
        if buf or not parts: parts.append(js_str(buf))
        return '(' + ' + '.join(parts) + ')'

def parse_expr(s):
    p = P(tokenize(s)); x = p.expr()
    if p.i != len(p.t): raise Fail('trailing tokens in: ' + s)
    return x

# ---------------------------------------------------------------- statements
def split_php(src):
    parts, pos = [], 0
    for m in re.finditer(r'<\?(=|php)(.*?)\?>', src, re.S):
        if m.start() > pos: parts.append(('text', src[pos:m.start()]))
        parts.append(('echo' if m.group(1) == '=' else 'code', m.group(2).strip()))
        pos = m.end()
        # PHP eats a single newline directly after a closing tag
        if src[pos:pos+1] == '\n': pos += 1
    if pos < len(src): parts.append(('text', src[pos:]))
    return parts

def convert(src):
    out, depth = [], 1
    def emit(s): out.append('  ' * depth + s)
    for kind, body in split_php(src):
        if kind == 'text':
            if body: emit('out += ' + '`' + body.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${') + '`;')
            continue
        if kind == 'echo':
            b = body.rstrip(';').strip()
            m = re.fullmatch(r'e\((.*)\)', b, re.S)
            if m and balanced(m.group(1)):
                emit(f'out += e({parse_expr(m.group(1))});')
            else: emit(f'out += S({parse_expr(b)});')
            continue
        # code block: may hold several statements
        code = re.sub(r'//[^\n]*', '', body)
        code = re.sub(r'/\*.*?\*/', '', code, flags=re.S).strip()
        if not code: continue
        for st in statements(code):
            depth = statement(st, emit, depth)
    return out

def balanced(s):
    d = 0; q = None
    for c in s:
        if q:
            if c == q: q = None
            continue
        if c in "'\"": q = c
        elif c == '(': d += 1
        elif c == ')':
            d -= 1
            if d < 0: return False
    return d == 0

def statements(code):
    # split on ';' at depth 0 outside strings, but keep "if (...):" / "foreach (...):" / "else:" whole
    res, buf, d, q = [], '', 0, None
    i = 0
    while i < len(code):
        c = code[i]
        if q:
            buf += c
            if c == '\\': buf += code[i+1]; i += 1
            elif c == q: q = None
        else:
            if c in "'\"": q = c; buf += c
            elif c in '([': d += 1; buf += c
            elif c in ')]': d -= 1; buf += c
            elif c == ';' and d == 0: res.append(buf.strip()); buf = ''
            elif c == ':' and d == 0 and re.fullmatch(r'\s*(if|elseif|foreach|for|else|while)\b.*', buf, re.S) and code[i:i+2] != '::' and not (buf.rstrip().endswith('?')):
                # block opener ends with ':'  (but not a ternary colon, which only occurs inside parens at depth>0 for these)
                res.append(buf.strip() + ':'); buf = ''
            else: buf += c
        i += 1
    if buf.strip(): res.append(buf.strip())
    return [r for r in res if r]

def statement(st, emit, depth):
    global assigned
    m = re.fullmatch(r'(if|elseif|while)\s*\((.*)\)\s*:', st, re.S)
    if m:
        kw, cond = m.group(1), m.group(2)
        c = parse_expr(cond)
        if kw == 'if': emit(f'if (T({c})) {{'); return depth + 1
        if kw == 'elseif':
            depth -= 1; emit(f'}} else if (T({c})) {{'); return depth + 1
        raise Fail('while not supported')
    if st == 'else:':
        depth -= 1; emit('} else {'); return depth + 1
    if st in ('endif', 'endforeach', 'endfor'):
        depth -= 1; emit('}'); return depth
    m = re.fullmatch(r'foreach\s*\((.*?)\s+as\s+(.*)\)\s*:', st, re.S)
    if m:
        arr = parse_expr(m.group(1)); target = m.group(2).strip()
        km = re.fullmatch(r'\$(\w+)\s*=>\s*\$(\w+)', target)
        dm = re.fullmatch(r'\[(.*)\]', target, re.S)
        vm = re.fullmatch(r'\$(\w+)', target)
        if km:
            LOOP_VARS.extend([km.group(1), km.group(2)]); emit(f'for (const [{km.group(1)}, {km.group(2)}] of entries({arr})) {{')
        elif dm:
            names = [x.strip()[1:] for x in dm.group(1).split(',')]; LOOP_VARS.extend(names)
            emit(f'for (const [{", ".join(names)}] of values({arr})) {{')
        elif vm:
            LOOP_VARS.append(vm.group(1)); emit(f'for (const {vm.group(1)} of values({arr})) {{')
        else: raise Fail('foreach target ' + target)
        return depth + 1
    m = re.fullmatch(r'for\s*\(\s*\$(\w+)\s*=\s*(.*?);\s*\$(\w+)\s*(<=|<)\s*(.*?);\s*\$(\w+)\+\+\s*\)\s*:', st, re.S)
    if m:
        v = m.group(1); LOOP_VARS.append(v)
        emit(f'for (let {v} = {parse_expr(m.group(2))}; num({v}) {m.group(4)} num({parse_expr(m.group(5))}); {v}++) {{'); return depth + 1
    m = re.fullmatch(r'unset\(\s*\$(\w+)\[(.*)\]\s*\)', st, re.S)
    if m:
        k = parse_expr(m.group(2)); n = 'query' if m.group(1) == '_GET' else m.group(1); used.add(m.group(1))
        km = re.fullmatch(r"'(\w+)'", k)
        emit(f'delete {n}.{km.group(1)};' if km else f'delete {n}[{k}];'); return depth
    m = re.fullmatch(r'\$(\w+)(\[(.*?)\])?\s*=\s*(.*)', st, re.S)
    if m and not st.startswith('$' + m.group(1) + ' ==') :
        name, key, rhs = m.group(1), m.group(3), m.group(4)
        r = parse_expr(rhs)
        if re.fullmatch(r'\$\w+', rhs.strip()): r = f'copy({r})'
        if key is None:
            assigned.add(name); emit(f'{name} = {r};'); return depth
        k = parse_expr(key); km = re.fullmatch(r"'(\w+)'", k)
        used.add(name)
        emit(f'{name}.{km.group(1)} = {r};' if km else f'{name}[{k}] = {r};'); return depth
    raise Fail('unsupported statement: ' + st)

def main():
    f, a, b, name = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    lines = open(f, encoding='utf-8').read().split('\n')[a-1:b]
    src = '\n'.join(lines) + ('\n' if True else '')
    body = convert(src)
    free = sorted(n for n in used if n not in assigned and n not in LOOP_VARS and n not in ('_GET', '_POST'))
    alln = set(['e', 'S', 'T', 'add', 'num', 'mod', 'cmp', 'looseEq', 'entries', 'values', 'copy', 'toArray', 'int', 'flt', 'phpEmpty', 'elvis', 'count']) | helpers_used
    ctxn = sorted(alln & CTX); staticn = sorted(alln - CTX)
    head = [f'export const {name} = (v: Record<string, any>, h: TplHelpers): string => {{']
    if free: head.append(f'  const {{ {", ".join(free)} }} = v;')
    head.append('  const query = v._GET ?? {}; void query;')
    if ctxn: head.append(f'  const {{ {", ".join(ctxn)} }} = h;')
    if assigned: head.append('  let ' + ', '.join(sorted(assigned)) + ': any;')
    head.append("  let out = '';")
    tail = ['  return out;', '};']
    doc = f'// GENERATED by scripts/php-tpl.py from {f.split("/modules/")[-1] if "/modules/" in f else f} lines {a}-{b}. Variables read: {", ".join(free) or "-"}.\n'
    if unknown: doc += '// Extra helpers required: ' + ', '.join(sorted(unknown)) + '\n'
    imp = f"import {{ {', '.join(staticn)} }} from '../phpRuntime.js';\nimport type {{ TplHelpers }} from '../phpRuntime.js';\n" if not os.environ.get('NOIMPORT') else ''
    print(doc + imp + '\n'.join(head + body + tail))

try: main()
except Fail as ex:
    sys.exit('php-tpl: ' + str(ex))
