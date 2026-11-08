/** Port of includes/BarcodeCode128.php: dependency-free CODE128-B encoder producing the same SVG string. */
const PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
/** PHP sprintf('%.3f'): like toFixed(3) but exact ties round to even (PHP uses correctly-rounded dtoa), e.g. 9.8125 -> 9.812. */
export function fixed3(x) {
    const exact = x.toFixed(60);
    const dot = exact.indexOf('.');
    const tail = exact.slice(dot + 4);
    if (/^50*$/.test(tail)) {
        const keep = exact.slice(0, dot + 4);
        const lastDigit = Number(keep[keep.length - 1]);
        if (lastDigit % 2 === 0)
            return keep; // round half to even: keep as is when the kept digit is even
    }
    return x.toFixed(3);
}
const START_B = 104;
const STOP = 106;
export function code128Svg(value, width = 180, height = 40) {
    const bytes = Buffer.from(value, 'utf8');
    const symbols = [START_B];
    for (const b of bytes)
        symbols.push((b < 32 || b > 126 ? 32 : b) - 32);
    let checksum = START_B;
    symbols.slice(1).forEach((sym, pos) => { checksum += sym * (pos + 1); });
    checksum %= 103;
    symbols.push(checksum, STOP);
    const modules = [];
    for (const sym of symbols) {
        const pattern = PATTERNS[sym];
        for (let j = 0; j < pattern.length; j++)
            modules.push({ bar: j % 2 === 0, w: Number(pattern[j]) });
    }
    const total = modules.reduce((a, m) => a + m.w, 0);
    const unit = width / Math.max(1, total);
    let rects = '';
    let x = 0;
    for (const m of modules) {
        const w = m.w * unit;
        if (m.bar)
            rects += `<rect x="${fixed3(x)}" y="0" width="${fixed3(w)}" height="${height}" fill="#000"/>`;
        x += w;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${rects}</svg>`;
}
