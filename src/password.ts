import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const KEY_LENGTH = 64;

export function hashPassword(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const hash = scryptSync(password, salt, KEY_LENGTH).toString('hex');
    return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !parts[2]) {
        return false;
    }
    const derived = scryptSync(password, parts[1], KEY_LENGTH);
    const expected = Buffer.from(parts[2], 'hex');
    if (derived.length !== expected.length) {
        return false;
    }
    return timingSafeEqual(derived, expected);
}

export function generatePassword(): string {
    return randomBytes(18).toString('base64url');
}

export const DUMMY_PASSWORD_HASH = hashPassword('timing-equalization');
