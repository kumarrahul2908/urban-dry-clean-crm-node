import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
export const ALLOWED_IMAGE_TYPES = ['jpg', 'jpeg', 'png', 'webp'];
export const MAX_UPLOAD_SIZE_MB = 5;
/** getimagesize() !== false for the formats the CRM accepts (header check). */
export function looksLikeImage(b) {
    if (b.length < 12)
        return false;
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return true; // JPEG
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return true; // PNG
    if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
        return true; // WebP
    if (b.subarray(0, 3).toString('latin1') === 'GIF')
        return true;
    if (b.subarray(0, 2).toString('latin1') === 'BM')
        return true;
    return false;
}
/** includes/functions.php handle_image_upload(): returns the stored file name, null when nothing was uploaded; throws Error(message) for user-facing problems. */
export async function handleImageUpload(ctx, field, subdir) {
    const f = ctx.files[field];
    if (!f)
        return null;
    if (f.buffer.length > MAX_UPLOAD_SIZE_MB * 1024 * 1024)
        throw new Error(`Image is too large. Maximum size is ${MAX_UPLOAD_SIZE_MB}MB.`);
    const ext = extname(f.filename).slice(1).toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.includes(ext))
        throw new Error('Invalid image type. Allowed: ' + ALLOWED_IMAGE_TYPES.join(', '));
    if (!looksLikeImage(f.buffer))
        throw new Error('The uploaded file is not a valid image.');
    const dir = join(ctx.svc.storage.root, subdir);
    await mkdir(dir, { recursive: true });
    const name = randomBytes(16).toString('hex') + '.' + ext;
    await writeFile(join(dir, name), f.buffer, { mode: 0o644 });
    return name;
}
export async function deleteUploadedImage(ctx, filename, subdir) {
    if (!filename)
        return;
    await unlink(join(ctx.svc.storage.root, subdir, basename(filename))).catch(() => { });
}
/** finfo(FILEINFO_MIME_TYPE) for the handful of types that matter here. */
export function sniffMime(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        return 'image/jpeg';
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        return 'image/png';
    if (b.subarray(0, 5).toString('latin1') === '%PDF-')
        return 'application/pdf';
    if (b.subarray(0, 3).toString('latin1') === 'GIF')
        return 'image/gif';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP')
        return 'image/webp';
    if (b.subarray(0, 2).toString('latin1') === 'PK')
        return 'application/zip';
    if (b.length === 0)
        return 'application/x-empty';
    const text = b.every((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 128);
    return text ? 'text/plain' : 'application/octet-stream';
}
