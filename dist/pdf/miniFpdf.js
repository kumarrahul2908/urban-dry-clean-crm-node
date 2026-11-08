import { deflateSync } from 'node:zlib';
import { HELVETICA } from './helveticaMetrics.js';
/**
 * Minimal port of the parts of FPDF 1.84 the invoice uses (A4 portrait, mm, core Helvetica family, no auto page
 * break). Page content streams are produced with the same operators/number formatting as FPDF so they can be
 * compared byte-for-byte against the PHP output (test/invoice-pdf.test.ts).
 *
 * Text is a "binary string": one char per cp1252 byte (see cp1252()).
 */
const K = 72 / 25.4;
const f2 = (n) => n.toFixed(2);
const f3 = (n) => n.toFixed(3);
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r');
/** Same ToUnicode CMap FPDF 1.84 (this app's copy) embeds so text stays searchable/copyable in WinAnsi core fonts. */
const TO_UNICODE = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo\n<</Registry (Adobe)\n/Ordering (UCS)\n/Supplement 0\n>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n6 beginbfrange\n<00> <7F> <0000>\n<86> <87> <2020>\n<91> <92> <2018>\n<93> <94> <201C>\n<96> <97> <2013>\n<A0> <FF> <00A0>\nendbfrange\n19 beginbfchar\n<80> <20AC>\n<82> <201A>\n<83> <0192>\n<84> <201E>\n<85> <2026>\n<88> <02C6>\n<89> <2030>\n<8A> <0160>\n<8B> <2039>\n<8C> <0152>\n<8E> <017D>\n<95> <2022>\n<98> <02DC>\n<99> <2122>\n<9A> <0161>\n<9B> <203A>\n<9C> <0153>\n<9E> <017E>\n<9F> <0178>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
export class MiniFpdf {
    w = 595.28 / K;
    h = 841.89 / K;
    lMargin = 15;
    tMargin = 15;
    cMargin = 28.35 / K / 10;
    x = 15;
    y = 15;
    lineWidth = 0.567 / K;
    drawColor = '0 G';
    fillColor = '0 g';
    textColor = '0 g';
    colorFlag = false;
    family = '';
    style = '';
    sizePt = 12;
    fontSize = 12 / K;
    current = null;
    fonts = new Map();
    pages = [];
    title = '';
    author = '';
    setTitle(t) { this.title = t; }
    setAuthor(a) { this.author = a; }
    // ---- state ---------------------------------------------------------------------------------
    out(s) {
        if (this.pages.length === 0)
            throw new Error('No page has been added yet');
        this.pages[this.pages.length - 1] += s + '\n';
    }
    addPage() {
        const [family, style, size, lw, dc, fc, tc, cf] = [this.family, this.style, this.sizePt, this.lineWidth, this.drawColor, this.fillColor, this.textColor, this.colorFlag];
        this.pages.push('');
        this.x = this.lMargin;
        this.y = this.tMargin;
        this.family = '';
        this.out('2 J');
        this.lineWidth = lw;
        this.out(`${f2(lw * K)} w`);
        if (family)
            this.setFont(family, style, size);
        this.drawColor = dc;
        if (dc !== '0 G')
            this.out(dc);
        this.fillColor = fc;
        if (fc !== '0 g')
            this.out(fc);
        this.textColor = tc;
        this.colorFlag = cf;
    }
    static color(op, r, g, b) {
        return r === 0 && g === 0 && b === 0 ? `${f3(r / 255)} ${op === 'RG' ? 'G' : op === 'rg' ? 'g' : op}` : `${f3(r / 255)} ${f3(g / 255)} ${f3(b / 255)} ${op === 'G' ? 'RG' : op === 'g' ? 'rg' : op}`;
    }
    setDrawColor(r, g, b) { this.drawColor = MiniFpdf.color('G', r, g, b); if (this.pages.length)
        this.out(this.drawColor); }
    setFillColor(r, g, b) { this.fillColor = MiniFpdf.color('g', r, g, b); this.colorFlag = this.fillColor !== this.textColor; if (this.pages.length)
        this.out(this.fillColor); }
    setTextColor(r, g, b) { this.textColor = MiniFpdf.color('g', r, g, b); this.colorFlag = this.fillColor !== this.textColor; }
    setLineWidth(w) { this.lineWidth = w; if (this.pages.length)
        this.out(`${f2(w * K)} w`); }
    setFont(family, style = '', size = 0) {
        family = family.toLowerCase() === 'arial' ? 'helvetica' : family.toLowerCase();
        if (family !== 'helvetica')
            throw new Error(`Undefined font: ${family}`);
        style = style.toUpperCase().replace('U', '');
        if (style === 'IB')
            style = 'BI';
        if (size === 0)
            size = this.sizePt;
        if (this.family === family && this.style === style && this.sizePt === size)
            return;
        const key = family + style;
        let font = this.fonts.get(key);
        if (!font) {
            const m = HELVETICA[style === '' ? 'R' : style];
            if (!m)
                throw new Error(`Undefined font style: ${style}`);
            font = { key, index: this.fonts.size + 1, widths: m.w, baseFont: m.name };
            this.fonts.set(key, font);
        }
        this.family = family;
        this.style = style;
        this.sizePt = size;
        this.fontSize = size / K;
        this.current = font;
        if (this.pages.length)
            this.out(`BT /F${font.index} ${f2(size)} Tf ET`);
    }
    getStringWidth(s) {
        const cw = this.requireFont().widths;
        let w = 0;
        for (let i = 0; i < s.length; i++)
            w += cw[s.charCodeAt(i) & 0xff];
        return (w * this.fontSize) / 1000;
    }
    requireFont() { if (!this.current)
        throw new Error('No font has been set'); return this.current; }
    // ---- drawing -------------------------------------------------------------------------------
    line(x1, y1, x2, y2) {
        this.out(`${f2(x1 * K)} ${f2((this.h - y1) * K)} m ${f2(x2 * K)} ${f2((this.h - y2) * K)} l S`);
    }
    rect(x, y, w, h, style = '') {
        const op = style === 'F' ? 'f' : style === 'FD' || style === 'DF' ? 'B' : 'S';
        this.out(`${f2(x * K)} ${f2((this.h - y) * K)} ${f2(w * K)} ${f2(-h * K)} re ${op}`);
    }
    setXY(x, y) { this.x = x; this.y = y; }
    ln(h) { this.x = this.lMargin; this.y += h ?? this.lastH; }
    lastH = 0;
    /** Cell(): only border=0 / no fill (the invoice never draws cell borders or fills). ln: 0 right, 1 next line, 2 below. */
    cell(w, h = 0, txt = '', ln = 0, align = '') {
        const k = K;
        if (w === 0)
            w = this.w - 15 - this.x;
        let s = '';
        if (txt !== '') {
            const font = this.requireFont();
            void font;
            const dx = align === 'R' ? w - this.cMargin - this.getStringWidth(txt) : align === 'C' ? (w - this.getStringWidth(txt)) / 2 : this.cMargin;
            if (this.colorFlag)
                s += `q ${this.textColor} `;
            s += `BT ${f2((this.x + dx) * k)} ${f2((this.h - (this.y + 0.5 * h + 0.3 * this.fontSize)) * k)} Td (${esc(txt)}) Tj ET`;
            if (this.colorFlag)
                s += ' Q';
        }
        if (s)
            this.out(s);
        this.lastH = h;
        if (ln > 0) {
            this.y += h;
            if (ln === 1)
                this.x = this.lMargin;
        }
        else
            this.x += w;
    }
    /** MultiCell() for left-aligned text without borders/fill. */
    multiCell(w, h, txt) {
        const cw = this.requireFont().widths;
        if (w === 0)
            w = this.w - 15 - this.x;
        const wmax = ((w - 2 * this.cMargin) * 1000) / this.fontSize;
        const s = txt.replace(/\r/g, '');
        let nb = s.length;
        if (nb > 0 && s[nb - 1] === '\n')
            nb--;
        let sep = -1, i = 0, j = 0, l = 0;
        while (i < nb) {
            const c = s[i];
            if (c === '\n') {
                this.cell(w, h, s.slice(j, i), 2, 'L');
                i++;
                sep = -1;
                j = i;
                l = 0;
                continue;
            }
            if (c === ' ')
                sep = i;
            l += cw[c.charCodeAt(0) & 0xff];
            if (l > wmax) {
                if (sep === -1) {
                    if (i === j)
                        i++;
                    this.cell(w, h, s.slice(j, i), 2, 'L');
                }
                else {
                    this.cell(w, h, s.slice(j, sep), 2, 'L');
                    i = sep + 1;
                }
                sep = -1;
                j = i;
                l = 0;
            }
            else
                i++;
        }
        this.cell(w, h, s.slice(j, i), 2, 'L');
        this.x = this.lMargin;
    }
    /** Page content streams as FPDF writes them (before compression). */
    contentStreams() { return [...this.pages]; }
    output() {
        const parts = [];
        let len = 0;
        const offsets = [];
        const put = (b) => { const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b; parts.push(buf); len += buf.length; };
        const newObj = (n) => { offsets[n] = len; put(`${n} 0 obj\n`); };
        const fonts = [...this.fonts.values()];
        const nPages = this.pages.length;
        // objects: 1 pages, 2.. (page, content) pairs, then fonts, resources, info, catalog
        const pageObj = (i) => 3 + 2 * i;
        const fontObj = (i) => 3 + 2 * nPages + i;
        const cmapObj = 3 + 2 * nPages + fonts.length;
        const resObj = cmapObj + 1;
        const infoObj = resObj + 1;
        const catObj = resObj + 2;
        put('%PDF-1.3\n');
        newObj(1);
        put(`<</Type /Pages\n/Kids [${this.pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}]\n/Count ${nPages}\n/MediaBox [0 0 595.28 841.89]\n>>\nendobj\n`);
        this.pages.forEach((content, i) => {
            newObj(pageObj(i));
            put(`<</Type /Page\n/Parent 1 0 R\n/Resources ${resObj} 0 R\n/Contents ${pageObj(i) + 1} 0 R>>\nendobj\n`);
            newObj(pageObj(i) + 1);
            const data = deflateSync(Buffer.from(content, 'latin1'));
            put(`<</Filter /FlateDecode /Length ${data.length}>>\nstream\n`);
            put(data);
            put('\nendstream\nendobj\n');
        });
        fonts.forEach((f, i) => {
            newObj(fontObj(i));
            put(`<</Type /Font\n/BaseFont /${f.baseFont}\n/Subtype /Type1\n/Encoding /WinAnsiEncoding\n/ToUnicode ${cmapObj} 0 R\n>>\nendobj\n`);
        });
        newObj(cmapObj);
        const cm = deflateSync(Buffer.from(TO_UNICODE, 'latin1'));
        put(`<</Filter /FlateDecode /Length ${cm.length}>>\nstream\n`);
        put(cm);
        put('\nendstream\nendobj\n');
        newObj(resObj);
        put(`<</ProcSet [/PDF /Text]\n/Font <<${fonts.map((f, i) => `\n/F${f.index} ${fontObj(i)} 0 R`).join('')}\n>>\n/XObject <<\n>>\n>>\nendobj\n`);
        newObj(infoObj);
        const text = (v) => (/^[\x00-\x7f]*$/.test(v) ? `(${esc(v)})` : `(${esc(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(v, 'utf16le').swap16()]).toString('latin1'))})`);
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        put(`<</Producer ${text('FPDF 1.84')}\n/Title ${text(this.title)}\n/Author ${text(this.author)}\n/CreationDate ${text(`D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`)}\n>>\nendobj\n`);
        newObj(catObj);
        put(`<</Type /Catalog\n/Pages 1 0 R\n/OpenAction [3 0 R /Fit]\n/PageLayout /OneColumn\n>>\nendobj\n`);
        const xref = len;
        put(`xref\n0 ${catObj + 1}\n0000000000 65535 f \n`);
        for (let n = 1; n <= catObj; n++)
            put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
        put(`trailer\n<</Size ${catObj + 1}\n/Root ${catObj} 0 R\n/Info ${infoObj} 0 R\n>>\nstartxref\n${xref}\n%%EOF\n`);
        return Buffer.concat(parts);
    }
}
