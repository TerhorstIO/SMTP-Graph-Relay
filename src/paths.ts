import fs from 'fs';
import path from 'path';
import { isSea } from 'node:sea';

export const APP_VERSION = '2.0.0';

/** Folder of the EXE when packaged, otherwise the process working directory. */
export function getAppDirectory(): string {
    if (isSea()) {
        return path.dirname(process.execPath);
    }
    return process.cwd();
}

export function resolveDatabasePath(): string {
    const override = process.env.DATABASE_PATH?.trim();
    if (override) {
        return path.isAbsolute(override) ? override : path.resolve(getAppDirectory(), override);
    }
    return path.join(getAppDirectory(), 'data', 'relay.sqlite');
}

export function getDataDirectory(): string {
    return path.dirname(resolveDatabasePath());
}

export function getEnvFilePath(): string {
    return path.join(getAppDirectory(), '.env');
}

export function ensureDataDirectories(): { databasePath: string; certPath: string; keyPath: string } {
    const databasePath = resolveDatabasePath();
    const certDirectory = path.join(getDataDirectory(), 'certs');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    fs.mkdirSync(certDirectory, { recursive: true });
    return {
        databasePath,
        certPath: path.join(certDirectory, 'cert.pem'),
        keyPath: path.join(certDirectory, 'key.pem'),
    };
}
