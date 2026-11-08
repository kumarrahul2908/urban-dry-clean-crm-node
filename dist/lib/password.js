import bcrypt from 'bcryptjs';
/** PHP password_hash() default is bcrypt ($2y$); bcryptjs verifies those hashes as-is. */
export function verifyPassword(plain, hash) {
    return bcrypt.compare(plain, hash.replace(/^\$2y\$/, '$2a$'));
}
export function hashPassword(plain) {
    return bcrypt.hash(plain, 10);
}
