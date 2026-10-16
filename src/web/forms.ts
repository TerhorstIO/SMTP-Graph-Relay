import { SettingsUpdate } from '../settings';

export interface SettingsForm {
    errors: string[];
    update: SettingsUpdate;
    certPem: string;
    keyPem: string;
}

export function parseSettingsForm(body: Record<string, unknown>): SettingsForm {
    const errors: string[] = [];
    const smtpHost = requiredText(body, 'smtpHost', 'SMTP-Adresse', errors);
    const smtpPort = requiredPort(body, 'smtpPort', 'SMTP-Port', errors);
    const implicitRaw = text(body, 'smtpImplicitTlsPort').trim();
    const implicitPort = implicitRaw ? requiredPort(body, 'smtpImplicitTlsPort', 'Impliziter TLS-Port', errors) : null;
    const webHost = requiredText(body, 'webHost', 'Web-Adresse', errors);
    const webPort = requiredPort(body, 'webPort', 'Web-Port', errors);
    const maxMb = integerInRange(text(body, 'maxMessageMb'), 1, 150);
    if (maxMb == null) {
        errors.push('Maximale Mailgröße muss zwischen 1 und 150 MB liegen.');
    }
    const retention = integerInRange(text(body, 'retentionDays'), 0, 3650);
    if (retention == null) {
        errors.push('Aufbewahrung muss zwischen 0 und 3650 Tagen liegen.');
    }
    const sender = text(body, 'graphSender').trim();
    if (sender && !sender.includes('@')) {
        errors.push('Graph-Absender muss eine E-Mail-Adresse enthalten.');
    }
    const ports = [smtpPort, implicitPort, webPort].filter((port): port is number => port != null);
    if (new Set(ports).size !== ports.length) {
        errors.push('SMTP-, TLS- und Web-Port müssen unterschiedlich sein.');
    }

    const secret = text(body, 'graphClientSecret').trim();
    return {
        errors,
        certPem: text(body, 'certPem'),
        keyPem: text(body, 'keyPem'),
        update: {
            smtpHost,
            smtpPort: smtpPort ?? undefined,
            smtpImplicitTlsPort: implicitPort,
            smtpRequireIp: text(body, 'smtpRequireIp') === '1',
            smtpRequireAuth: text(body, 'smtpRequireAuth') === '1',
            smtpMaxMessageBytes: maxMb == null ? undefined : maxMb * 1024 * 1024,
            graphTenantId: text(body, 'graphTenantId').trim(),
            graphClientId: text(body, 'graphClientId').trim(),
            ...(secret ? { graphClientSecret: secret } : {}),
            graphSender: sender,
            webHost,
            webPort: webPort ?? undefined,
            webHttps: text(body, 'webHttps') === '1',
            retentionDays: retention ?? undefined,
        },
    };
}

export function text(body: Record<string, unknown>, name: string): string {
    const value = body[name];
    return typeof value === 'string' ? value : '';
}

function requiredText(body: Record<string, unknown>, name: string, label: string, errors: string[]): string {
    const value = text(body, name).trim();
    if (!value || value.length > 255 || /\s/.test(value)) {
        errors.push(`${label} fehlt oder ist ungültig.`);
    }
    return value;
}

function requiredPort(body: Record<string, unknown>, name: string, label: string, errors: string[]): number | null {
    const port = Number(text(body, name).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(`${label} muss zwischen 1 und 65535 liegen.`);
        return null;
    }
    return port;
}

function integerInRange(value: string, min: number, max: number): number | null {
    const parsed = Number(value.trim());
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        return null;
    }
    return parsed;
}
