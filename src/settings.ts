import { Db } from './db/database';
import { readSettings, writeSetting } from './db/store';

export interface AppSettings {
    smtpHost: string;
    smtpPort: number;
    smtpImplicitTlsPort: number | null;
    smtpRequireIp: boolean;
    smtpRequireAuth: boolean;
    smtpMaxMessageBytes: number;
    graphTenantId: string;
    graphClientId: string;
    graphClientSecret: string;
    graphSender: string;
    webHost: string;
    webPort: number;
    webHttps: boolean;
    webPasswordHash: string;
    retentionDays: number;
    tlsCertPath: string;
    tlsKeyPath: string;
    envImported: boolean;
}

export interface SettingsUpdate {
    smtpHost?: string;
    smtpPort?: number;
    smtpImplicitTlsPort?: number | null;
    smtpRequireIp?: boolean;
    smtpRequireAuth?: boolean;
    smtpMaxMessageBytes?: number;
    graphTenantId?: string;
    graphClientId?: string;
    graphClientSecret?: string;
    graphSender?: string;
    webHost?: string;
    webPort?: number;
    webHttps?: boolean;
    webPasswordHash?: string;
    retentionDays?: number;
    tlsCertPath?: string;
    tlsKeyPath?: string;
    envImported?: boolean;
}

const DEFAULTS: AppSettings = {
    smtpHost: '0.0.0.0',
    smtpPort: 25,
    smtpImplicitTlsPort: null,
    smtpRequireIp: false,
    smtpRequireAuth: false,
    smtpMaxMessageBytes: 25 * 1024 * 1024,
    graphTenantId: '',
    graphClientId: '',
    graphClientSecret: '',
    graphSender: '',
    webHost: '0.0.0.0',
    webPort: 8443,
    webHttps: true,
    webPasswordHash: '',
    retentionDays: 90,
    tlsCertPath: '',
    tlsKeyPath: '',
    envImported: false,
};

const KEYS: Record<keyof AppSettings, string> = {
    smtpHost: 'smtp_host',
    smtpPort: 'smtp_port',
    smtpImplicitTlsPort: 'smtp_implicit_tls_port',
    smtpRequireIp: 'smtp_require_ip',
    smtpRequireAuth: 'smtp_require_auth',
    smtpMaxMessageBytes: 'smtp_max_message_bytes',
    graphTenantId: 'graph_tenant_id',
    graphClientId: 'graph_client_id',
    graphClientSecret: 'graph_client_secret',
    graphSender: 'graph_sender',
    webHost: 'web_host',
    webPort: 'web_port',
    webHttps: 'web_https',
    webPasswordHash: 'web_password_hash',
    retentionDays: 'retention_days',
    tlsCertPath: 'tls_cert_path',
    tlsKeyPath: 'tls_key_path',
    envImported: 'env_imported',
};

export function getSettings(db: Db): AppSettings {
    const stored = readSettings(db);
    return {
        smtpHost: stored.get(KEYS.smtpHost) || DEFAULTS.smtpHost,
        smtpPort: parsePort(stored.get(KEYS.smtpPort), DEFAULTS.smtpPort),
        smtpImplicitTlsPort: parseOptionalPort(stored.get(KEYS.smtpImplicitTlsPort)),
        smtpRequireIp: parseBool(stored.get(KEYS.smtpRequireIp), DEFAULTS.smtpRequireIp),
        smtpRequireAuth: parseBool(stored.get(KEYS.smtpRequireAuth), DEFAULTS.smtpRequireAuth),
        smtpMaxMessageBytes: parsePositive(stored.get(KEYS.smtpMaxMessageBytes), DEFAULTS.smtpMaxMessageBytes),
        graphTenantId: stored.get(KEYS.graphTenantId) ?? DEFAULTS.graphTenantId,
        graphClientId: stored.get(KEYS.graphClientId) ?? DEFAULTS.graphClientId,
        graphClientSecret: stored.get(KEYS.graphClientSecret) ?? DEFAULTS.graphClientSecret,
        graphSender: stored.get(KEYS.graphSender) ?? DEFAULTS.graphSender,
        webHost: stored.get(KEYS.webHost) || DEFAULTS.webHost,
        webPort: parsePort(stored.get(KEYS.webPort), DEFAULTS.webPort),
        webHttps: parseBool(stored.get(KEYS.webHttps), DEFAULTS.webHttps),
        webPasswordHash: stored.get(KEYS.webPasswordHash) ?? DEFAULTS.webPasswordHash,
        retentionDays: parseNonNegative(stored.get(KEYS.retentionDays), DEFAULTS.retentionDays),
        tlsCertPath: stored.get(KEYS.tlsCertPath) ?? DEFAULTS.tlsCertPath,
        tlsKeyPath: stored.get(KEYS.tlsKeyPath) ?? DEFAULTS.tlsKeyPath,
        envImported: parseBool(stored.get(KEYS.envImported), DEFAULTS.envImported),
    };
}

export function updateSettings(db: Db, update: SettingsUpdate): void {
    const next = { ...getSettings(db), ...definedOnly(update) };
    for (const key of Object.keys(KEYS) as Array<keyof AppSettings>) {
        writeSetting(db, KEYS[key], serialize(key, next[key]));
    }
}

export function setWebPasswordHash(db: Db, passwordHash: string): void {
    writeSetting(db, KEYS.webPasswordHash, passwordHash);
}

export function needsRestart(before: AppSettings, after: AppSettings): { smtp: boolean; web: boolean } {
    const smtp = before.smtpHost !== after.smtpHost
        || before.smtpPort !== after.smtpPort
        || before.smtpImplicitTlsPort !== after.smtpImplicitTlsPort
        || before.smtpRequireAuth !== after.smtpRequireAuth
        || before.smtpMaxMessageBytes !== after.smtpMaxMessageBytes
        || before.tlsCertPath !== after.tlsCertPath
        || before.tlsKeyPath !== after.tlsKeyPath;
    const web = before.webHost !== after.webHost
        || before.webPort !== after.webPort
        || before.webHttps !== after.webHttps
        || before.tlsCertPath !== after.tlsCertPath
        || before.tlsKeyPath !== after.tlsKeyPath;
    return { smtp, web };
}

export function adminUrl(settings: AppSettings): string {
    const scheme = settings.webHttps ? 'https' : 'http';
    const host = settings.webHost === '0.0.0.0' || settings.webHost === '::' ? 'localhost' : settings.webHost;
    const port = settings.webPort;
    const skipPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80);
    return `${scheme}://${host}${skipPort ? '' : `:${port}`}/`;
}

function definedOnly(update: SettingsUpdate): SettingsUpdate {
    const result: SettingsUpdate = {};
    for (const [key, value] of Object.entries(update) as Array<[keyof SettingsUpdate, SettingsUpdate[keyof SettingsUpdate]]>) {
        if (value !== undefined) {
            result[key] = value as never;
        }
    }
    return result;
}

function serialize(key: keyof AppSettings, value: AppSettings[keyof AppSettings]): string {
    if (key === 'smtpImplicitTlsPort') {
        return value == null ? '' : String(value);
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0';
    }
    return String(value ?? '');
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
    if (value == null || value === '') {
        return fallback;
    }
    return value === '1' || value.toLowerCase() === 'true';
}

function parsePort(value: string | undefined, fallback: number): number {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return fallback;
    }
    return port;
}

function parseOptionalPort(value: string | undefined): number | null {
    if (!value) {
        return null;
    }
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return null;
    }
    return port;
}

function parsePositive(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return fallback;
    }
    return Math.floor(parsed);
}

function parseNonNegative(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }
    return Math.floor(parsed);
}
