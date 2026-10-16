import http from 'http';
import https from 'https';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { assertKeyPair, assertPem, loadTlsMaterial, readTextIfExists, writePemPair, writeSelfSignedCertificate } from '../certs';
import { Db } from '../db/database';
import {
    addAllowedIp,
    addSmtpUser,
    AttachmentFile,
    countEnabledSmtpUsers,
    deleteAllowedIp,
    deleteSmtpUser,
    getAttachment,
    getMessage,
    listAllowedIps,
    listAttachmentMeta,
    listAttachmentsWithContent,
    listEnabledCidrs,
    listEvents,
    listMessages,
    listSmtpUsers,
    messageStatusCounts,
    MessageStatus,
    toggleAllowedIp,
    toggleSmtpUser,
} from '../db/store';
import { errorMessage } from '../errors';
import { Logger } from '../logger';
import { isValidCidr, normalizeIp } from '../net';
import { ensureDataDirectories, resolveDatabasePath } from '../paths';
import { hashPassword, verifyPassword } from '../password';
import { adminUrl, AppSettings, getSettings, needsRestart, setWebPasswordHash, updateSettings } from '../settings';
import { tlsReady } from '../smtp/server';
import {
    attachSession,
    clearLoginFailures,
    clearSession,
    csrfMatches,
    issueSession,
    loginAllowed,
    recordLoginFailure,
} from './auth';
import { parseSettingsForm, text } from './forms';
import {
    escapeHtml,
    layout,
    renderEvents,
    renderIps,
    renderLogin,
    renderMessage,
    renderMessages,
    renderPreviewDocument,
    renderRestartNotice,
    renderSettings,
    renderStatus,
    renderUsers,
    SettingsView,
} from './html';

const PAGE_SIZE = 50;
const STATUSES = new Set<MessageStatus>(['accepted', 'sent', 'failed', 'rejected']);

interface UploadMap {
    certFile?: Array<{ buffer: Buffer }>;
    keyFile?: Array<{ buffer: Buffer }>;
}

interface Actions {
    reloadSmtp: () => Promise<void>;
    reloadWeb: () => Promise<void>;
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 256 * 1024, fieldSize: 2 * 1024 * 1024, files: 2 },
});

export class WebServer {
    private server: http.Server | undefined;

    constructor(
        private readonly db: Db,
        private readonly logger: Logger,
        private readonly actions: Actions,
    ) {}

    async start(): Promise<void> {
        const settings = getSettings(this.db);
        const app = this.createApp();
        const tlsMaterial = settings.webHttps ? loadTlsMaterial(settings.tlsCertPath, settings.tlsKeyPath) : undefined;
        if (settings.webHttps && !tlsMaterial) {
            throw new Error('HTTPS ist aktiv, aber das Zertifikat fehlt.');
        }
        const server = tlsMaterial
            ? https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, app)
            : http.createServer(app);
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => reject(error);
            server.once('error', onError);
            server.listen(settings.webPort, settings.webHost, () => {
                server.removeListener('error', onError);
                server.on('error', (error) => this.logger.error(`Web-Fehler: ${error.message}`));
                resolve();
            });
        });
        this.server = server;
        this.logger.info(`Admin-Oberfläche lauscht auf ${adminUrl(settings)}`);
    }

    async stop(): Promise<void> {
        const server = this.server;
        this.server = undefined;
        if (!server) {
            return;
        }
        const closed = new Promise<void>((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        server.closeAllConnections();
        await closed;
    }

    async reload(): Promise<void> {
        this.logger.info('Admin-Oberfläche wird neu gebunden.');
        await this.stop();
        await this.start();
    }

    private createApp(): express.Express {
        const app = express();
        app.disable('x-powered-by');
        app.use(attachSession);
        app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            if (!req.path.endsWith('/preview')) {
                res.setHeader('X-Frame-Options', 'DENY');
                res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
            }
            next();
        });
        app.use(express.urlencoded({ extended: false, limit: '1mb' }));

        app.get('/login', (req, res) => {
            if (req.session) {
                res.redirect('/');
                return;
            }
            res.type('html').send(renderLogin());
        });
        app.post('/login', (req, res) => this.login(req, res));
        app.post('/logout', this.requireLogin, this.requireCsrf, (req, res) => {
            clearSession(res, req.secure);
            res.redirect('/login');
        });

        app.get('/', this.requireLogin, (req, res) => this.messages(req, res));
        app.get('/messages/:id', this.requireLogin, (req, res) => this.message(req, res));
        app.get('/messages/:id/preview', this.requireLogin, (req, res) => this.preview(req, res));
        app.get('/messages/:id/attachments/:attachmentId', this.requireLogin, (req, res) => this.attachment(req, res));
        app.get('/events', this.requireLogin, (req, res) => {
            this.page(res, req, 'Ereignisse', '/events', renderEvents(listEvents(this.db)));
        });
        app.get('/users', this.requireLogin, (req, res) => this.users(req, res));
        app.post('/users', this.requireLogin, this.requireCsrf, (req, res) => this.createUser(req, res));
        app.post('/users/:id/toggle', this.requireLogin, this.requireCsrf, (req, res) => {
            const id = numericId(req.params.id);
            if (id != null) toggleSmtpUser(this.db, id);
            res.redirect('/users');
        });
        app.post('/users/:id/delete', this.requireLogin, this.requireCsrf, (req, res) => {
            const id = numericId(req.params.id);
            if (id != null) deleteSmtpUser(this.db, id);
            res.redirect('/users');
        });
        app.get('/ips', this.requireLogin, (req, res) => this.ips(req, res));
        app.post('/ips', this.requireLogin, this.requireCsrf, (req, res) => this.createIp(req, res));
        app.post('/ips/:id/toggle', this.requireLogin, this.requireCsrf, (req, res) => {
            const id = numericId(req.params.id);
            if (id != null) toggleAllowedIp(this.db, id);
            res.redirect('/ips');
        });
        app.post('/ips/:id/delete', this.requireLogin, this.requireCsrf, (req, res) => {
            const id = numericId(req.params.id);
            if (id != null) deleteAllowedIp(this.db, id);
            res.redirect('/ips');
        });
        app.get('/settings', this.requireLogin, (req, res) => this.settings(req, res));
        app.post('/settings', this.requireLogin, upload.fields([
            { name: 'certFile', maxCount: 1 },
            { name: 'keyFile', maxCount: 1 },
        ]), this.requireCsrf, (req, res) => this.saveSettings(req, res));
        app.post('/settings/password', this.requireLogin, this.requireCsrf, (req, res) => this.changePassword(req, res));
        app.post('/settings/tls/generate', this.requireLogin, this.requireCsrf, (req, res) => this.generateCertificate(req, res));

        app.use((req, res) => {
            res.status(404).type('html').send(renderStatus('Nicht gefunden', 'Diese Seite gibt es nicht.'));
        });
        app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
            const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: string }).code) : '';
            if (code === 'LIMIT_FILE_SIZE') {
                res.status(400).type('html').send(renderStatus('Datei zu groß', 'Zertifikatdateien dürfen höchstens 256 KB groß sein.'));
                return;
            }
            this.logger.error(`Web-Anfrage fehlgeschlagen: ${errorMessage(error)}`);
            if (!res.headersSent) {
                res.status(500).type('html').send(renderStatus('Fehler', 'Die Anfrage konnte nicht verarbeitet werden.'));
            }
        });
        return app;
    }

    private readonly requireLogin = (req: Request, res: Response, next: NextFunction): void => {
        if (!req.session) {
            res.redirect('/login');
            return;
        }
        next();
    };

    private readonly requireCsrf = (req: Request, res: Response, next: NextFunction): void => {
        if (!csrfMatches(req)) {
            res.status(403).type('html').send(renderStatus('Abgelehnt', 'Das Formular ist abgelaufen. Seite neu laden und erneut senden.'));
            return;
        }
        next();
    };

    private login(req: Request, res: Response): void {
        const ip = clientIp(req);
        if (!loginAllowed(ip)) {
            res.status(429).type('html').send(renderLogin('Zu viele Versuche. Bitte später erneut versuchen.'));
            return;
        }
        const password = text(bodyOf(req), 'password');
        const settings = getSettings(this.db);
        if (!settings.webPasswordHash || !verifyPassword(password, settings.webPasswordHash)) {
            recordLoginFailure(ip);
            res.status(401).type('html').send(renderLogin('Passwort ist falsch.'));
            return;
        }
        clearLoginFailures(ip);
        issueSession(res, req.secure);
        res.redirect('/');
    }

    private messages(req: Request, res: Response): void {
        const statusRaw = text(req.query as Record<string, unknown>, 'status');
        const status = STATUSES.has(statusRaw as MessageStatus) ? statusRaw as MessageStatus : undefined;
        const q = text(req.query as Record<string, unknown>, 'q').trim().slice(0, 200);
        const from = dateValue(text(req.query as Record<string, unknown>, 'from'));
        const to = dateValue(text(req.query as Record<string, unknown>, 'to'));
        const page = Math.min(10_000, Math.max(1, Number(text(req.query as Record<string, unknown>, 'page')) || 1));
        const result = listMessages(this.db, {
            status,
            q: q || undefined,
            from,
            to: to ? nextDay(to) : undefined,
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
        });
        this.page(res, req, 'Protokoll', '/', renderMessages({
            rows: result.items,
            counts: messageStatusCounts(this.db),
            total: result.total,
            page,
            pageSize: PAGE_SIZE,
            status: status || '',
            q,
            from: from || '',
            to: to || '',
        }));
    }

    private message(req: Request, res: Response): void {
        const id = numericId(req.params.id);
        const message = id == null ? undefined : getMessage(this.db, id);
        if (!message) {
            res.status(404).type('html').send(renderStatus('Nicht gefunden', 'Diese Mail gibt es nicht.'));
            return;
        }
        this.page(res, req, message.subject || 'Mail', `/messages/${message.id}`, renderMessage({
            ...message,
            hasHtml: Boolean(message.htmlBody),
            attachments: listAttachmentMeta(this.db, message.id),
        }));
    }

    private preview(req: Request, res: Response): void {
        const id = numericId(req.params.id);
        const message = id == null ? undefined : getMessage(this.db, id);
        if (!message) {
            res.status(404).type('html').send('Nicht gefunden');
            return;
        }
        const attachments = listAttachmentsWithContent(this.db, message.id);
        const content = message.htmlBody
            ? rewriteCid(message.htmlBody, attachments)
            : `<pre>${escapeHtml(message.textBody || '')}</pre>`;
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'");
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.type('html').send(renderPreviewDocument(content));
    }

    private attachment(req: Request, res: Response): void {
        const messageId = numericId(req.params.id);
        const attachmentId = numericId(req.params.attachmentId);
        const file = messageId == null || attachmentId == null
            ? undefined
            : getAttachment(this.db, messageId, attachmentId);
        if (!file) {
            res.status(404).type('html').send(renderStatus('Nicht gefunden', 'Dieser Anhang gibt es nicht.'));
            return;
        }
        const filename = file.filename.replace(/[\r\n"]/g, '');
        const ascii = filename.replace(/[^\x20-\x7E]/g, '_') || 'anhang';
        res.setHeader('Content-Type', file.contentType.replace(/[\r\n]/g, '') || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send(file.content);
    }

    private users(req: Request, res: Response): void {
        const error = queryError(req);
        this.page(res, req, 'Benutzer', '/users', renderUsers({
            csrf: req.session?.csrf || '',
            users: listSmtpUsers(this.db),
        }), undefined, error ? [error] : undefined);
    }

    private createUser(req: Request, res: Response): void {
        const username = text(bodyOf(req), 'username').trim();
        const password = text(bodyOf(req), 'password');
        if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) {
            res.redirect('/users?error=name');
            return;
        }
        if (password.length < 8) {
            res.redirect('/users?error=password');
            return;
        }
        const result = addSmtpUser(this.db, username, hashPassword(password));
        res.redirect(result === 'duplicate' ? '/users?error=duplicate' : '/users');
    }

    private ips(req: Request, res: Response): void {
        const error = queryError(req);
        this.page(res, req, 'IP-Filter', '/ips', renderIps({
            csrf: req.session?.csrf || '',
            ips: listAllowedIps(this.db),
        }), undefined, error ? [error] : undefined);
    }

    private createIp(req: Request, res: Response): void {
        const cidr = text(bodyOf(req), 'cidr').trim();
        const note = text(bodyOf(req), 'note').trim().slice(0, 200);
        if (!isValidCidr(cidr)) {
            res.redirect('/ips?error=cidr');
            return;
        }
        const result = addAllowedIp(this.db, cidr, note);
        res.redirect(result === 'duplicate' ? '/ips?error=ipduplicate' : '/ips');
    }

    private settings(req: Request, res: Response, errors: string[] = [], view?: SettingsView): void {
        const notices: Record<string, string> = {
            saved: 'Einstellungen gespeichert.',
            password: 'Admin-Passwort geändert.',
            cert: 'Selbstsigniertes Zertifikat erzeugt.',
        };
        const code = text(req.query as Record<string, unknown>, 'notice');
        this.page(res, req, 'Einstellungen', '/settings', view ? settingsBody(view) : settingsBody(this.settingsView(req)), notices[code], errors);
    }

    private saveSettings(req: Request, res: Response): void {
        const before = getSettings(this.db);
        const parsed = parseSettingsForm(bodyOf(req));
        const files = (req as Request & { files?: UploadMap }).files;
        const certInput = fileText(files?.certFile) || parsed.certPem;
        const keyInput = fileText(files?.keyFile) || parsed.keyPem;
        let materialChanged = false;
        try {
            const existingCert = normalizePem(readTextIfExists(before.tlsCertPath));
            const existingKey = normalizePem(readTextIfExists(before.tlsKeyPath));
            const nextCert = normalizePem(certInput);
            const nextKey = normalizePem(keyInput);
            const certChanged = Boolean(nextCert) && nextCert !== existingCert;
            const keyChanged = Boolean(nextKey) && nextKey !== existingKey;
            if (certChanged || keyChanged) {
                const cert = certChanged ? assertPem(certInput, 'Zertifikat') : readTextIfExists(before.tlsCertPath);
                const key = keyChanged ? assertPem(keyInput, 'Schlüssel') : readTextIfExists(before.tlsKeyPath);
                if (!cert.trim() || !key.trim()) {
                    parsed.errors.push('Zertifikat und Schlüssel müssen gemeinsam vorhanden sein.');
                } else {
                    assertKeyPair(cert, key);
                    const paths = ensureDataDirectories();
                    const certPath = before.tlsCertPath || paths.certPath;
                    const keyPath = before.tlsKeyPath || paths.keyPath;
                    writePemPair(certPath, keyPath, cert, key);
                    parsed.update.tlsCertPath = certPath;
                    parsed.update.tlsKeyPath = keyPath;
                    materialChanged = true;
                }
            }
        } catch (error) {
            parsed.errors.push(errorMessage(error));
        }
        if (parsed.errors.length > 0) {
            this.settings(req, res, parsed.errors, this.settingsView(req));
            return;
        }
        updateSettings(this.db, parsed.update);
        const after = getSettings(this.db);
        const restart = needsRestart(before, after);
        if (materialChanged) {
            restart.smtp = true;
            restart.web = true;
        }
        this.logger.info('Einstellungen gespeichert.');
        if (restart.web) {
            const url = adminUrl(after);
            this.page(res, req, 'Einstellungen', '/settings', renderRestartNotice(url));
        } else {
            res.redirect('/settings?notice=saved');
        }
        this.scheduleReload(res, restart);
    }

    private changePassword(req: Request, res: Response): void {
        const password = text(bodyOf(req), 'password');
        const confirm = text(bodyOf(req), 'confirm');
        if (password.length < 10) {
            this.settings(req, res, ['Admin-Passwort muss mindestens 10 Zeichen haben.']);
            return;
        }
        if (password !== confirm) {
            this.settings(req, res, ['Die Passwortwiederholung stimmt nicht.']);
            return;
        }
        setWebPasswordHash(this.db, hashPassword(password));
        this.logger.info('Admin-Passwort geändert.');
        res.redirect('/settings?notice=password');
    }

    private generateCertificate(_req: Request, res: Response): void {
        const settings = getSettings(this.db);
        const paths = ensureDataDirectories();
        const certPath = settings.tlsCertPath || paths.certPath;
        const keyPath = settings.tlsKeyPath || paths.keyPath;
        writeSelfSignedCertificate(certPath, keyPath);
        updateSettings(this.db, { tlsCertPath: certPath, tlsKeyPath: keyPath });
        this.logger.info('Selbstsigniertes Zertifikat ersetzt.');
        this.page(res, _req, 'Einstellungen', '/settings', renderRestartNotice(adminUrl(getSettings(this.db))));
        this.scheduleReload(res, { smtp: true, web: true });
    }

    private settingsView(req: Request): SettingsView {
        const settings = getSettings(this.db);
        return {
            csrf: req.session?.csrf || '',
            settings,
            databasePath: resolveDatabasePath(),
            certPresent: tlsReady(settings),
            keyPresent: tlsReady(settings),
            certPem: readTextIfExists(settings.tlsCertPath),
        };
    }

    private page(res: Response, req: Request, title: string, currentPath: string, body: string, notice?: string, errors?: string[]): void {
        const settings = getSettings(this.db);
        res.type('html').send(layout({
            title,
            currentPath,
            csrf: req.session?.csrf || '',
            warnings: collectWarnings(this.db, settings),
            notice,
            errors,
            body,
        }));
    }

    private scheduleReload(res: Response, flags: { smtp: boolean; web: boolean }): void {
        if (!flags.smtp && !flags.web) {
            return;
        }
        res.on('finish', () => {
            setTimeout(() => {
                void this.reloadChanged(flags);
            }, 200);
        });
    }

    private async reloadChanged(flags: { smtp: boolean; web: boolean }): Promise<void> {
        try {
            if (flags.smtp) {
                await this.actions.reloadSmtp();
            }
            if (flags.web) {
                await this.actions.reloadWeb();
            }
        } catch (error) {
            this.logger.error(`Neustart der Dienste fehlgeschlagen: ${errorMessage(error)}`);
        }
    }
}

function settingsBody(view: SettingsView): string {
    return renderSettings(view);
}

function collectWarnings(db: Db, settings: AppSettings): string[] {
    const warnings: string[] = [];
    if (!settings.smtpRequireIp && !settings.smtpRequireAuth) {
        warnings.push('SMTP nimmt Verbindungen ohne IP-Filter und ohne Anmeldung an. Der Relay ist offen.');
    }
    if (settings.smtpRequireAuth && !tlsReady(settings)) {
        warnings.push('SMTP-Anmeldung ist ohne TLS erlaubt. Passwörter können im Klartext übertragen werden.');
    }
    if (settings.smtpRequireIp && listEnabledCidrs(db).length === 0) {
        warnings.push('Der IP-Filter ist aktiv, aber keine Adresse ist freigegeben. SMTP lehnt alle Verbindungen ab.');
    }
    if (settings.smtpRequireAuth && countEnabledSmtpUsers(db) === 0) {
        warnings.push('SMTP-Anmeldung ist aktiv, aber kein Benutzer ist freigegeben.');
    }
    if (!settings.graphTenantId || !settings.graphClientId || !settings.graphClientSecret || !settings.graphSender) {
        warnings.push('Microsoft Graph ist unvollständig. E-Mails werden gespeichert, aber nicht zugestellt.');
    }
    if (!settings.webHttps) {
        warnings.push('Die Admin-Oberfläche läuft ohne HTTPS.');
    }
    return warnings;
}

function queryError(req: Request): string | undefined {
    const messages: Record<string, string> = {
        name: 'Benutzername: Buchstaben, Zahlen und . _ @ -, maximal 64 Zeichen.',
        password: 'Das SMTP-Passwort muss mindestens 8 Zeichen haben.',
        duplicate: 'Dieser Benutzername existiert bereits.',
        cidr: 'IP oder CIDR ist ungültig.',
        ipduplicate: 'Dieser Bereich existiert bereits.',
    };
    const code = text(req.query as Record<string, unknown>, 'error');
    return messages[code];
}

function bodyOf(req: Request): Record<string, unknown> {
    return req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
}

function fileText(files: Array<{ buffer: Buffer }> | undefined): string {
    return files?.[0]?.buffer.toString('utf8') || '';
}

function numericId(value: string | string[] | undefined): number | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw || !/^\d+$/.test(raw)) {
        return undefined;
    }
    const id = Number(raw);
    return Number.isSafeInteger(id) ? id : undefined;
}

function dateValue(value: string): string | undefined {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

function nextDay(isoDate: string): string {
    const date = new Date(`${isoDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
}

function normalizePem(value: string): string {
    return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
}

function rewriteCid(html: string, attachments: AttachmentFile[]): string {
    let output = html;
    for (const attachment of attachments) {
        if (!attachment.contentId) {
            continue;
        }
        const cid = attachment.contentId.replace(/^<|>$/g, '');
        const data = `data:${attachment.contentType || 'application/octet-stream'};base64,${attachment.content.toString('base64')}`;
        output = output.split(`cid:${cid}`).join(data);
    }
    return output;
}

function clientIp(req: Request): string {
    return normalizeIp(req.socket.remoteAddress || '');
}
