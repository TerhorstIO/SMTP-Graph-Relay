import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Request, Response } from 'express';

const COOKIE = 'sgr_session';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const secret = randomBytes(32);

export interface SessionData {
    exp: number;
    csrf: string;
}

declare global {
    namespace Express {
        interface Request {
            session?: SessionData;
            secureCookies?: boolean;
        }
    }
}

const attempts = new Map<string, { count: number; resetAt: number }>();

export function attachSession(req: Request, _res: Response, next: () => void): void {
    const token = readCookie(req.headers.cookie, COOKIE);
    const session = token ? verifyToken(token) : undefined;
    if (session) {
        req.session = session;
    }
    next();
}

export function loginAllowed(ip: string): boolean {
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt < Date.now()) {
        return true;
    }
    return entry.count < 8;
}

export function recordLoginFailure(ip: string): void {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || entry.resetAt < now) {
        attempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
        return;
    }
    entry.count += 1;
}

export function clearLoginFailures(ip: string): void {
    attempts.delete(ip);
}

export function issueSession(res: Response, secure: boolean): void {
    const session: SessionData = {
        exp: Date.now() + MAX_AGE_MS,
        csrf: randomBytes(24).toString('base64url'),
    };
    writeCookie(res, sign(session), secure, MAX_AGE_MS / 1000);
}

export function clearSession(res: Response, secure: boolean): void {
    writeCookie(res, '', secure, 0);
}

export function csrfMatches(req: Request): boolean {
    const provided = typeof req.body?.csrf === 'string' ? req.body.csrf : '';
    const expected = req.session?.csrf || '';
    if (!provided || !expected || provided.length !== expected.length) {
        return false;
    }
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function sign(session: SessionData): string {
    const body = Buffer.from(JSON.stringify(session)).toString('base64url');
    const signature = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
}

function verifyToken(token: string): SessionData | undefined {
    const splitAt = token.lastIndexOf('.');
    if (splitAt <= 0) {
        return undefined;
    }
    const body = token.slice(0, splitAt);
    const signature = token.slice(splitAt + 1);
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
        return undefined;
    }
    try {
        const session = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionData;
        if (!session.exp || session.exp < Date.now() || typeof session.csrf !== 'string') {
            return undefined;
        }
        return session;
    } catch {
        return undefined;
    }
}

function writeCookie(res: Response, value: string, secure: boolean, maxAge: number): void {
    const parts = [
        `${COOKIE}=${value}`,
        'HttpOnly',
        'SameSite=Strict',
        'Path=/',
        `Max-Age=${maxAge}`,
    ];
    if (secure) {
        parts.push('Secure');
    }
    res.setHeader('Set-Cookie', parts.join('; '));
}

function readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) {
        return undefined;
    }
    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) {
            continue;
        }
        if (part.slice(0, index).trim() === name) {
            return part.slice(index + 1).trim();
        }
    }
    return undefined;
}
