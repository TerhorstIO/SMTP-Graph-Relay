import net from 'net';
import ipRangeCheck from 'ip-range-check';

export function normalizeIp(ip: string): string {
    const trimmed = ip.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith('::ffff:')) {
        const mapped = lower.slice('::ffff:'.length);
        if (net.isIP(mapped) === 4) {
            return mapped;
        }
    }
    return trimmed;
}

export function isValidCidr(value: string): boolean {
    const candidate = value.trim();
    if (!candidate || candidate.length > 128 || /\s/.test(candidate)) {
        return false;
    }
    const pieces = candidate.split('/');
    if (pieces.length > 2) {
        return false;
    }
    const address = pieces[0];
    const family = net.isIP(address);
    if (!family) {
        return false;
    }
    if (pieces.length === 1) {
        return true;
    }
    const bits = Number(pieces[1]);
    const maxBits = family === 6 ? 128 : 32;
    return Number.isInteger(bits) && bits >= 0 && bits <= maxBits;
}

export function ipAllowed(ip: string, ranges: string[]): boolean {
    if (ranges.length === 0) {
        return false;
    }
    try {
        return ipRangeCheck(normalizeIp(ip), ranges);
    } catch {
        return false;
    }
}
