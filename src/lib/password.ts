import bcrypt from 'bcryptjs';

/** PHP password_hash() default is bcrypt ($2y$); bcryptjs verifies those hashes as-is. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash.replace(/^\$2y\$/, '$2a$'));
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
