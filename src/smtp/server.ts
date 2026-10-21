import { AddressObject, Attachment, ParsedMail, simpleParser } from 'mailparser';
import { SMTPServer, SMTPServerAuthentication, SMTPServerDataStream, SMTPServerSession } from 'smtp-server';
import { certificateFilesReady, loadTlsMaterial } from '../certs';
import { Db } from '../db/database';
import { findSmtpUser, insertMessage, listEnabledCidrs, updateMessageStatus } from '../db/store';
import { clip, errorMessage } from '../errors';
import { extractEmail, sendViaGraph } from '../graph/client';
import { Logger } from '../logger';
import { selectRecipients } from '../mail/recipients';
import { ipAllowed, normalizeIp } from '../net';
import { DUMMY_PASSWORD_HASH, verifyPassword } from '../password';
import { AppSettings, getSettings } from '../settings';

interface SessionMeta {
    remoteIp: string;
    authUser: string | null;
    mailFrom: string | null;
    recipients: string[];
}

export class SmtpService {
    private servers: SMTPServer[] = [];

    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
    ) {}

    async start(): Promise<void> {
        const settings = getSettings(this.db);
        const tls = loadTlsMaterial(settings.tlsCertPath, settings.tlsKeyPath);
        const hasTls = Boolean(tls);
        await this.listen(this.createServer(settings, false, tls), settings.smtpHost, settings.smtpPort, 'SMTP');
        if (settings.smtpImplicitTlsPort) {
            if (!hasTls) {
                this.logger.error(`Implizites TLS auf Port ${settings.smtpImplicitTlsPort} braucht ein Zertifikat und wurde nicht gestartet.`);
            } else {
                await this.listen(
                    this.createServer(settings, true, tls),
                    settings.smtpHost,
                    settings.smtpImplicitTlsPort,
                    'SMTPS',
                );
            }
        }
    }

    async stop(): Promise<void> {
        const servers = this.servers;
        this.servers = [];
        await Promise.all(servers.map((server) => closeServer(server)));
    }

    async reload(): Promise<void> {
        this.logger.info('SMTP-Server wird neu gebunden.');
        await this.stop();
        await this.start();
    }

    private createServer(
        settings: AppSettings,
        implicitTls: boolean,
        tls: { cert: Buffer; key: Buffer } | undefined,
    ): SMTPServer {
        const hasTls = Boolean(tls);
        return new SMTPServer({
            secure: implicitTls,
            key: tls?.key,
            cert: tls?.cert,
            authOptional: !settings.smtpRequireAuth,
            allowInsecureAuth: settings.smtpRequireAuth && !hasTls,
            authMethods: ['PLAIN', 'LOGIN'],
            size: settings.smtpMaxMessageBytes,
            banner: 'SMTP-Graph-Relay',
            hideSTARTTLS: implicitTls || !hasTls,
            disableReverseLookup: true,
            closeTimeout: 10_000,
            onConnect: (session, callback) => this.onConnect(session, callback),
            onAuth: (auth, session, callback) => this.onAuth(auth, session, callback),
            onData: (stream, session, callback) => {
                void this.onData(stream, session, callback);
            },
        });
    }

    private onConnect(session: SMTPServerSession, callback: (err?: Error | null) => void): void {
        const remoteIp = normalizeIp(session.remoteAddress);
        const settings = getSettings(this.db);
        if (settings.smtpRequireIp) {
            const ranges = listEnabledCidrs(this.db);
            if (!ipAllowed(remoteIp, ranges)) {
                this.logger.warn(`Verbindung abgelehnt: ${remoteIp}`);
                this.recordRejection(remoteIp, null, null, [], 'IP nicht erlaubt');
                callback(new Error('Connection rejected'));
                return;
            }
        }
        this.logger.info(`Verbindung angenommen: ${remoteIp}`);
        callback();
    }

    private onAuth(
        auth: SMTPServerAuthentication,
        session: SMTPServerSession,
        callback: (err: Error | null | undefined, response?: { user: string }) => void,
    ): void {
        const remoteIp = normalizeIp(session.remoteAddress);
        const username = auth.username?.trim() || '';
        const password = auth.password || '';
        const user = username ? findSmtpUser(this.db, username) : undefined;
        const matches = verifyPassword(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
        if (!user || !user.enabled || !matches) {
            this.logger.warn(`SMTP-Anmeldung fehlgeschlagen für ${username || '(leer)'} von ${remoteIp}`);
            this.recordRejection(remoteIp, username || null, null, [], 'Anmeldung fehlgeschlagen');
            callback(new Error('Invalid login'));
            return;
        }
        this.logger.info(`SMTP-Anmeldung erfolgreich: ${user.username} von ${remoteIp}`);
        callback(null, { user: user.username });
    }

    private async onData(
        stream: SMTPServerDataStream,
        session: SMTPServerSession,
        callback: (err?: Error | null) => void,
    ): Promise<void> {
        let settled = false;
        const finish = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            try {
                callback(error);
            } catch (callbackError) {
                this.logger.error(`SMTP-Antwort fehlgeschlagen: ${errorMessage(callbackError)}`);
            }
        };

        const meta = sessionMeta(session);
        try {
            const parsed = await simpleParser(stream, { keepCidLinks: true });
            if (stream.sizeExceeded) {
                this.recordRejection(meta.remoteIp, meta.authUser, meta.mailFrom, meta.recipients, 'Nachricht ist zu groß');
                finish(new Error('Message too large'));
                return;
            }
            if (meta.recipients.length === 0) {
                this.recordRejection(meta.remoteIp, meta.authUser, meta.mailFrom, [], 'Empfänger fehlt');
                finish(new Error('Missing recipient'));
                return;
            }

            const attachments = collectAttachments(parsed);
            const textBody = typeof parsed.text === 'string' ? parsed.text : null;
            const htmlBody = typeof parsed.html === 'string' ? parsed.html : null;
            const messageId = insertMessage(this.db, {
                receivedAt: new Date().toISOString(),
                remoteIp: meta.remoteIp,
                authUser: meta.authUser,
                mailFrom: meta.mailFrom,
                recipients: meta.recipients,
                subject: parsed.subject || null,
                messageId: parsed.messageId || null,
                sizeBytes: stream.byteLength,
                status: 'accepted',
                error: null,
                textBody,
                htmlBody,
                attachments,
            });

            try {
                const settings = getSettings(this.db);
                const recipients = selectRecipients(meta.recipients, headerAddresses(parsed.to), headerAddresses(parsed.cc));
                const displayName = await sendViaGraph(settings, {
                    subject: parsed.subject || '',
                    html: htmlBody,
                    text: textBody,
                    recipients,
                    attachments,
                }, (message) => this.logger.warn(message));
                updateMessageStatus(this.db, messageId, 'sent', null);
                const sender = extractEmail(settings.graphSender);
                const shown = displayName ? `${displayName} <${sender}>` : sender;
                this.logger.info(`Mail von ${meta.remoteIp} über ${shown} an ${meta.recipients.join(', ')} weitergeleitet`);
                finish();
            } catch (error) {
                const message = clip(errorMessage(error));
                updateMessageStatus(this.db, messageId, 'failed', message);
                this.logger.error(`Weiterleitung fehlgeschlagen: ${message}`);
                finish(new Error('Failed to send email'));
            }
        } catch (error) {
            const message = clip(errorMessage(error));
            this.logger.error(`Mail konnte nicht gelesen werden: ${message}`);
            this.recordRejection(meta.remoteIp, meta.authUser, meta.mailFrom, meta.recipients, message);
            finish(new Error('Failed to parse email'));
        }
    }

    private recordRejection(
        remoteIp: string,
        authUser: string | null,
        mailFrom: string | null,
        recipients: string[],
        reason: string,
    ): void {
        try {
            insertMessage(this.db, {
                receivedAt: new Date().toISOString(),
                remoteIp,
                authUser,
                mailFrom,
                recipients,
                subject: null,
                messageId: null,
                sizeBytes: 0,
                status: 'rejected',
                error: clip(reason),
                textBody: null,
                htmlBody: null,
                attachments: [],
            });
        } catch (error) {
            this.logger.error(`Ablehnung konnte nicht gespeichert werden: ${errorMessage(error)}`);
        }
    }

    private async listen(server: SMTPServer, host: string, port: number, label: string): Promise<void> {
        try {
            await new Promise<void>((resolve, reject) => {
                const onError = (error: Error): void => reject(error);
                server.once('error', onError);
                server.listen(port, host, () => {
                    server.removeListener('error', onError);
                    server.on('error', (error) => {
                        this.logger.error(`${label}-Fehler: ${error.message}`);
                    });
                    resolve();
                });
            });
            this.servers.push(server);
            this.logger.info(`${label} lauscht auf ${host}:${port}`);
        } catch (error) {
            this.logger.error(`${label} konnte nicht auf ${host}:${port} starten: ${errorMessage(error)}`);
            await closeServer(server);
        }
    }
}

function sessionMeta(session: SMTPServerSession): SessionMeta {
    const mailFrom = session.envelope.mailFrom && typeof session.envelope.mailFrom === 'object'
        ? session.envelope.mailFrom.address
        : null;
    return {
        remoteIp: normalizeIp(session.remoteAddress),
        authUser: session.user || null,
        mailFrom,
        recipients: session.envelope.rcptTo.map((recipient) => recipient.address).filter(Boolean),
    };
}

function headerAddresses(field: AddressObject | AddressObject[] | undefined): string[] {
    if (!field) {
        return [];
    }
    const objects = Array.isArray(field) ? field : [field];
    const addresses: string[] = [];
    for (const object of objects) {
        for (const entry of object.value) {
            if (entry.address) {
                addresses.push(entry.address);
            }
        }
    }
    return addresses;
}

function collectAttachments(parsed: ParsedMail): Array<{
    filename: string;
    contentType: string;
    contentId: string | null;
    inline: boolean;
    content: Buffer;
}> {
    return (parsed.attachments || []).flatMap((attachment, index) => {
        const content = attachmentContent(attachment);
        if (!content) {
            return [];
        }
        const contentId = normalizeContentId(attachment.contentId || attachment.cid);
        return [{
            filename: safeFilename(attachment.filename || contentId || `anhang-${index + 1}`),
            contentType: attachment.contentType || 'application/octet-stream',
            contentId,
            inline: attachment.related || attachment.contentDisposition === 'inline',
            content,
        }];
    });
}

function attachmentContent(attachment: Attachment): Buffer | undefined {
    if (!attachment.content || attachment.content.length === 0) {
        return undefined;
    }
    return attachment.content;
}

function normalizeContentId(value: string | undefined): string | null {
    if (!value) {
        return null;
    }
    const cleaned = value.replace(/^<|>$/g, '').trim();
    return cleaned || null;
}

function safeFilename(value: string): string {
    const cleaned = value.replace(/[\r\n"/\\]/g, '_').trim();
    return (cleaned || 'anhang').slice(0, 200);
}

function closeServer(server: SMTPServer): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        try {
            server.close(() => {
                clearTimeout(timer);
                resolve();
            });
        } catch {
            clearTimeout(timer);
            resolve();
        }
    });
}

export function tlsReady(settings: AppSettings): boolean {
    return certificateFilesReady(settings.tlsCertPath, settings.tlsKeyPath);
}
