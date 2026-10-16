import fs from 'fs';
import path from 'path';
import tls from 'tls';
import selfsigned from 'selfsigned';

export function certificateFilesReady(certPath: string, keyPath: string): boolean {
    return Boolean(certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath));
}

export function loadTlsMaterial(certPath: string, keyPath: string): { cert: Buffer; key: Buffer } | undefined {
    if (!certificateFilesReady(certPath, keyPath)) {
        return undefined;
    }
    return {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
    };
}

export function ensureSelfSignedCertificate(certPath: string, keyPath: string): boolean {
    if (certificateFilesReady(certPath, keyPath)) {
        return false;
    }
    writeSelfSignedCertificate(certPath, keyPath);
    return true;
}

export function writeSelfSignedCertificate(certPath: string, keyPath: string): void {
    const pems = selfsigned.generate([{ name: 'commonName', value: 'smtp-graph-relay' }], {
        days: 825,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
            {
                name: 'subjectAltName',
                altNames: [
                    { type: 2, value: 'localhost' },
                    { type: 2, value: 'smtp-graph-relay' },
                    { type: 7, ip: '127.0.0.1' },
                ],
            },
        ],
    });
    writePemPair(certPath, keyPath, pems.cert, pems.private);
}

export function assertPem(value: string, label: string): string {
    const trimmed = value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
    if (!trimmed.includes('-----BEGIN ') || !trimmed.includes('-----END ')) {
        throw new Error(`${label} ist kein PEM-Block.`);
    }
    return `${trimmed}\n`;
}

export function assertKeyPair(cert: string, key: string): void {
    tls.createSecureContext({ cert, key });
}

export function writePemPair(certPath: string, keyPath: string, cert: string, key: string): void {
    assertKeyPair(cert, key);
    fs.mkdirSync(path.dirname(certPath), { recursive: true });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(certPath, cert.endsWith('\n') ? cert : `${cert}\n`);
    fs.writeFileSync(keyPath, key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 });
}

export function readTextIfExists(filePath: string): string {
    if (!filePath || !fs.existsSync(filePath)) {
        return '';
    }
    return fs.readFileSync(filePath, 'utf8');
}
