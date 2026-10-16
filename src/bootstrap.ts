import fs from 'fs';
import dotenv from 'dotenv';
import { ensureSelfSignedCertificate } from './certs';
import { Db } from './db/database';
import { addAllowedIp } from './db/store';
import { Logger } from './logger';
import { ensureDataDirectories, getEnvFilePath } from './paths';
import { generatePassword, hashPassword } from './password';
import { getSettings, setWebPasswordHash, updateSettings } from './settings';

const PLACEHOLDERS = new Set([
    'your_tenant_id_here',
    'your_client_id_here',
    'your_client_secret_here',
    'default_sender@example.com',
]);

export interface BootstrapResult {
    generatedPassword: string | null;
    passwordFromEnv: boolean;
    importedEnv: boolean;
    generatedCertificate: boolean;
}

export function bootstrap(db: Db, logger: Logger): BootstrapResult {
    const paths = ensureDataDirectories();
    const current = getSettings(db);
    if (!current.tlsCertPath || !current.tlsKeyPath) {
        updateSettings(db, { tlsCertPath: paths.certPath, tlsKeyPath: paths.keyPath });
    }

    let importedEnv = false;
    if (!getSettings(db).envImported) {
        importedEnv = importEnvFile(db, logger);
        updateSettings(db, { envImported: true });
    }

    let generatedPassword: string | null = null;
    let passwordFromEnv = false;
    const adminPassword = process.env.ADMIN_PASSWORD?.trim();
    if (adminPassword) {
        setWebPasswordHash(db, hashPassword(adminPassword));
        passwordFromEnv = true;
        logger.warn('Admin-Passwort aus ADMIN_PASSWORD übernommen. Die Variable danach entfernen, sonst wird das Passwort bei jedem Start zurückgesetzt.');
    } else if (!getSettings(db).webPasswordHash) {
        generatedPassword = generatePassword();
        setWebPasswordHash(db, hashPassword(generatedPassword));
    }

    const settings = getSettings(db);
    const generatedCertificate = ensureSelfSignedCertificate(settings.tlsCertPath, settings.tlsKeyPath);
    if (generatedCertificate) {
        logger.info(`Selbstsigniertes Zertifikat erzeugt: ${settings.tlsCertPath}`);
    }
    return { generatedPassword, passwordFromEnv, importedEnv, generatedCertificate };
}

function importEnvFile(db: Db, logger: Logger): boolean {
    const envPath = getEnvFilePath();
    if (!fs.existsSync(envPath)) {
        return false;
    }
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    const tenantId = usable(parsed.TENANT_ID);
    const clientId = usable(parsed.CLIENT_ID);
    const clientSecret = usable(parsed.CLIENT_SECRET);
    const sender = usable(parsed.SENDER);
    const port = Number(parsed.SMTP_PORT);
    updateSettings(db, {
        ...(tenantId ? { graphTenantId: tenantId } : {}),
        ...(clientId ? { graphClientId: clientId } : {}),
        ...(clientSecret ? { graphClientSecret: clientSecret } : {}),
        ...(sender ? { graphSender: sender } : {}),
        ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { smtpPort: port } : {}),
    });

    const ips = (parsed.ALLOWED_IPS || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    if (ips.length > 0) {
        for (const cidr of ips) {
            addAllowedIp(db, cidr, 'Aus .env importiert');
        }
        updateSettings(db, { smtpRequireIp: true });
    }
    logger.info(`.env importiert: ${envPath}`);
    return true;
}

function usable(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed || PLACEHOLDERS.has(trimmed)) {
        return undefined;
    }
    return trimmed;
}
