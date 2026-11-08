/**
 * Port of includes/QrEncoder.php (byte mode, ECC level L, versions 1-9, no rule-3 penalty) — bug-compatible on purpose: the
 * PHP original treats versions 6-9 as one block, so the Node SVG is byte-identical to what the PHP app printed.
 */
import { fixed3 } from './barcodeCode128.js';
const VERSION_INFO = {
    1: { size: 21, total: 26, data: 19, ec: 7 }, 2: { size: 25, total: 44, data: 34, ec: 10 }, 3: { size: 29, total: 70, data: 55, ec: 15 },
    4: { size: 33, total: 100, data: 80, ec: 20 }, 5: { size: 37, total: 134, data: 108, ec: 26 }, 6: { size: 41, total: 172, data: 136, ec: 18 },
    7: { size: 45, total: 196, data: 156, ec: 20 }, 8: { size: 49, total: 242, data: 194, ec: 24 }, 9: { size: 53, total: 292, data: 232, ec: 30 },
};
const ALIGNMENT_POS = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34, 7: 22, 8: 24, 9: 26 };
const exp = [];
const log = [];
(() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        exp[i] = x;
        log[x] = i;
        x <<= 1;
        if (x & 0x100)
            x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++)
        exp[i] = exp[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);
function generatorPoly(ecCount) {
    let poly = [1];
    for (let i = 0; i < ecCount; i++) {
        const np = new Array(poly.length + 1).fill(0);
        for (let j = 0; j < poly.length; j++) {
            np[j] ^= gfMul(poly[j], exp[i]);
            np[j + 1] ^= poly[j];
        }
        poly = np;
    }
    return poly;
}
function rsEncode(data, ecCount) {
    const gen = generatorPoly(ecCount);
    const result = [...data, ...new Array(ecCount).fill(0)];
    for (let i = 0; i < data.length; i++) {
        const coef = result[i];
        if (coef === 0)
            continue;
        for (let j = 0; j < gen.length; j++)
            result[i + j] ^= gfMul(gen[j], coef);
    }
    return result.slice(data.length);
}
function pickVersion(byteLen) {
    for (const [v, info] of Object.entries(VERSION_INFO))
        if (4 + 8 + byteLen * 8 <= info.data * 8)
            return Number(v);
    throw new Error('QrEncoder: data too long for supported versions (1-9).');
}
function dataCodewords(data, version) {
    const info = VERSION_INFO[version];
    let bits = '0100' + data.length.toString(2).padStart(8, '0');
    for (const b of data)
        bits += b.toString(2).padStart(8, '0');
    const cap = info.data * 8;
    bits += '0'.repeat(Math.min(4, cap - bits.length));
    while (bits.length % 8 !== 0)
        bits += '0';
    const cw = [];
    for (let i = 0; i < bits.length; i += 8)
        cw.push(parseInt(bits.slice(i, i + 8), 2));
    const pad = [0xec, 0x11];
    let p = 0;
    while (cw.length < info.data)
        cw.push(pad[p++ % 2]);
    return cw;
}
function formatInfoBits(mask) {
    const data = (0b01 << 3) | mask;
    let bch = data << 10;
    const gen = 0b10100110111;
    for (let i = 14; i >= 10; i--)
        if (bch & (1 << i))
            bch ^= gen << (i - 10);
    const fmt = ((data << 10) | bch) ^ 0b101010000010010;
    const bits = [];
    for (let i = 14; i >= 0; i--)
        bits.push((fmt >> i) & 1);
    return bits;
}
function applyMask(p, row, col) {
    switch (p) {
        case 0: return (row + col) % 2 === 0;
        case 1: return row % 2 === 0;
        case 2: return col % 3 === 0;
        case 3: return (row + col) % 3 === 0;
        case 4: return (Math.trunc(row / 2) + Math.trunc(col / 3)) % 2 === 0;
        case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
        case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
        default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
    }
}
function maskPenalty(grid, size) {
    let penalty = 0;
    for (const dir of ['row', 'col']) {
        for (let i = 0; i < size; i++) {
            let run = 1;
            for (let j = 1; j < size; j++) {
                const cur = dir === 'row' ? grid[i][j] : grid[j][i];
                const prev = dir === 'row' ? grid[i][j - 1] : grid[j - 1][i];
                if (cur === prev)
                    run++;
                else {
                    if (run >= 5)
                        penalty += 3 + (run - 5);
                    run = 1;
                }
            }
            if (run >= 5)
                penalty += 3 + (run - 5);
        }
    }
    return penalty;
}
export function qrSvg(dataStr, pixelSize = 260) {
    const data = Buffer.from(dataStr, 'utf8');
    const version = pickVersion(data.length);
    const info = VERSION_INFO[version];
    const size = info.size;
    const dcw = dataCodewords(data, version);
    const all = [...dcw, ...rsEncode(dcw, info.ec)];
    let bits = '';
    for (const cw of all)
        bits += cw.toString(2).padStart(8, '0');
    const grid = Array.from({ length: size }, () => new Array(size).fill(0));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    const placeFinder = (r0, c0) => {
        for (let r = -1; r <= 7; r++)
            for (let c = -1; c <= 7; c++) {
                const rr = r0 + r, cc = c0 + c;
                if (rr < 0 || rr >= size || cc < 0 || cc >= size)
                    continue;
                reserved[rr][cc] = true;
                const dark = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
                grid[rr][cc] = dark ? 1 : 0;
            }
    };
    placeFinder(0, 0);
    placeFinder(0, size - 7);
    placeFinder(size - 7, 0);
    for (let i = 8; i < size - 8; i++) {
        reserved[6][i] = true;
        grid[6][i] = i % 2 === 0 ? 1 : 0;
        reserved[i][6] = true;
        grid[i][6] = i % 2 === 0 ? 1 : 0;
    }
    if (ALIGNMENT_POS[version] !== undefined) {
        const ap = ALIGNMENT_POS[version];
        for (let r = -2; r <= 2; r++)
            for (let c = -2; c <= 2; c++) {
                reserved[ap + r][ap + c] = true;
                grid[ap + r][ap + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0;
            }
    }
    reserved[size - 8][8] = true;
    grid[size - 8][8] = 1;
    for (let i = 0; i <= 8; i++) {
        reserved[8][i] = true;
        reserved[i][8] = true;
    }
    for (let i = 0; i < 8; i++) {
        reserved[8][size - 1 - i] = true;
        reserved[size - 1 - i][8] = true;
    }
    let bitIndex = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
        if (col === 6)
            col--;
        for (let step = 0; step < size; step++) {
            const row = upward ? size - 1 - step : step;
            for (const c of [col, col - 1]) {
                if (reserved[row][c])
                    continue;
                grid[row][c] = bitIndex < bits.length ? Number(bits[bitIndex]) : 0;
                bitIndex++;
            }
        }
        upward = !upward;
    }
    let bestPattern = 0, bestPenalty = Number.MAX_SAFE_INTEGER, best = grid;
    for (let p = 0; p < 8; p++) {
        const trial = grid.map((r) => [...r]);
        for (let r = 0; r < size; r++)
            for (let c = 0; c < size; c++) {
                if (reserved[r][c])
                    continue;
                if (applyMask(p, r, c))
                    trial[r][c] ^= 1;
            }
        const pen = maskPenalty(trial, size);
        if (pen < bestPenalty) {
            bestPenalty = pen;
            bestPattern = p;
            best = trial;
        }
    }
    const fmt = formatInfoBits(bestPattern);
    const pos = [];
    for (let i = 0; i <= 5; i++)
        pos.push([8, i]);
    pos.push([8, 7], [8, 8], [7, 8]);
    for (let i = 5; i >= 0; i--)
        pos.push([i, 8]);
    pos.forEach(([r, c], idx) => { best[r][c] = fmt[idx]; });
    for (let i = 0; i < 8; i++)
        best[size - 1 - i][8] = fmt[i];
    for (let i = 8; i < 15; i++)
        best[8][size - 15 + i] = fmt[i];
    const quiet = 4;
    const unit = pixelSize / (size + quiet * 2);
    let rects = `<rect x="0" y="0" width="${pixelSize}" height="${pixelSize}" fill="#fff"/>`;
    for (let r = 0; r < size; r++)
        for (let c = 0; c < size; c++) {
            if (best[r][c])
                rects += `<rect x="${fixed3((c + quiet) * unit)}" y="${fixed3((r + quiet) * unit)}" width="${fixed3(unit + 0.5)}" height="${fixed3(unit + 0.5)}" fill="#000"/>`;
        }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pixelSize} ${pixelSize}" width="${pixelSize}" height="${pixelSize}">${rects}</svg>`;
}
