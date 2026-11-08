export function sniffImage(head) {
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
        return 'jpg';
    if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return 'png';
    if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP')
        return 'webp';
    if (head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1')))
        return 'gif';
    return null;
}
