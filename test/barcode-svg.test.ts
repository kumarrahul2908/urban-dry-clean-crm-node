import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { code128Svg } from '../src/lib/barcodeCode128.js';
import { qrSvg } from '../src/lib/qrEncoder.js';

const PHP_APP = process.env.PARITY_PHP_APP;
describe.skipIf(!PHP_APP)('barcode/QR SVG: Node port is byte-identical to the PHP encoders', () => {
  const run = (cls: string, file: string, args: [string, ...number[]][]) => {
    const script = `require '${PHP_APP}/includes/${file}.php'; $in = json_decode(file_get_contents('php://stdin'), true); $out = []; foreach ($in as $a) { $out[] = ${cls === 'QrEncoder' ? '(new QrEncoder())->svg(...$a)' : 'BarcodeCode128::svg(...$a)'}; } echo json_encode($out);`;
    return JSON.parse(execFileSync('php', ['-r', script], { input: JSON.stringify(args), maxBuffer: 1 << 28 }).toString()) as string[];
  };
  it('CODE128', () => {
    const values = ['UDC-CUST-000001', 'UDC-20260101-0001-01', 'A', 'a b~', 'ZZZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'UDC-ORD-2026-000123-7', '0123456789', 'é', '~~~~', 'Hello, World! 123'];
    const rnd = (n: number) => Array.from({ length: n }, () => String.fromCharCode(32 + Math.floor(Math.random() * 95))).join('');
    for (let i = 1; i < 40; i++) values.push(rnd(i));
    const sizes: [number, number][] = [[180, 40], [200, 50], [120, 30], [157, 33], [300, 64]];
    const args = values.flatMap((v) => sizes.map(([w, h]) => [v, w, h] as [string, ...number[]]));
    const php = run('Code128', 'BarcodeCode128', args);
    args.forEach((a, i) => {
      const got = code128Svg(a[0], a[1] as number, a[2] as number);
      if (got !== php[i]) { const k = [...got].findIndex((ch, j) => ch !== php[i]![j]); throw new Error(`${JSON.stringify(a)} differs at ${k}: node ${got.slice(k - 50, k + 30)} php ${php[i]!.slice(k - 50, k + 30)}`); }
    });
  });
  it('QR (versions 1-5, up to 106 bytes)', () => {
    const values = ['x', 'https://example.test/track.php?t=abcdef0123456789abcdef0123456789', 'UDC-20260101-0001', 'A0026-01', 'a'.repeat(17), 'a'.repeat(18), 'b'.repeat(32), 'c'.repeat(33), 'd'.repeat(53), 'e'.repeat(54), 'f'.repeat(78), 'g'.repeat(106), 'é€ünï', 'https://example.test/track.php?t=' + 'f'.repeat(64)];
    for (let i = 0; i < 25; i++) values.push(Array.from({ length: 1 + Math.floor(Math.random() * 106) }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join(''));
    const args = values.flatMap((v) => [[v, 260], [v, 180], [v, 200]] as [string, number][]);
    const php = run('QrEncoder', 'QrEncoder', args);
    args.forEach((a, i) => expect(qrSvg(a[0], a[1])).toBe(php[i]));
  });
  it('QR: content longer than version 5 is refused (versions 6-9 never worked and were removed in PHP)', () => {
    expect(() => qrSvg('h'.repeat(107))).toThrow(/1-5, max 106 bytes/);
  });
});
