import { SQLInputValue, SQLOutputValue } from 'node:sqlite';
import { Db } from './database';

export type MessageStatus = 'accepted' | 'sent' | 'failed' | 'rejected';

export interface StoredAttachment {
    filename: string;
    contentType: string;
    contentId: string | null;
    inline: boolean;
    content: Buffer;
}

export interface NewMessage {
    receivedAt: string;
    remoteIp: string;
    authUser: string | null;
    mailFrom: string | null;
    recipients: string[];
    subject: string | null;
    messageId: string | null;
    sizeBytes: number;
    status: MessageStatus;
    error: string | null;
    textBody: string | null;
    htmlBody: string | null;
    attachments: StoredAttachment[];
}

export interface MessageSummary {
    id: number;
    receivedAt: string;
    remoteIp: string;
    authUser: string | null;
    mailFrom: string | null;
    recipients: string[];
    subject: string | null;
    messageId: string | null;
    sizeBytes: number;
    status: MessageStatus;
    error: string | null;
}

export interface MessageDetail extends MessageSummary {
    textBody: string | null;
    htmlBody: string | null;
}

export interface AttachmentMeta {
    id: number;
    filename: string;
    contentType: string;
    sizeBytes: number;
    contentId: string | null;
    inline: boolean;
}

export interface AttachmentFile extends AttachmentMeta {
    content: Buffer;
}

export interface AllowedIp {
    id: number;
    cidr: string;
    note: string;
    enabled: boolean;
}

export interface SmtpUser {
    id: number;
    username: string;
    passwordHash: string;
    enabled: boolean;
}

export interface SystemEvent {
    id: number;
    ts: string;
    level: string;
    message: string;
}

export interface MessageFilter {
    status?: MessageStatus;
    q?: string;
    from?: string;
    to?: string;
    limit: number;
    offset: number;
}

function asText(value: SQLOutputValue | undefined): string | null {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value);
    }
    return null;
}

function asNumber(value: SQLOutputValue | undefined): number {
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'bigint') {
        return Number(value);
    }
    return 0;
}

function asBuffer(value: SQLOutputValue | undefined): Buffer {
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
        return Buffer.alloc(0);
    }
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function row(db: Db, sql: string, params: SQLInputValue[] = []): Record<string, SQLOutputValue> | undefined {
    return db.prepare(sql).get(...params) as Record<string, SQLOutputValue> | undefined;
}

function rows(db: Db, sql: string, params: SQLInputValue[] = []): Array<Record<string, SQLOutputValue>> {
    return db.prepare(sql).all(...params) as Array<Record<string, SQLOutputValue>>;
}

function parseRecipients(value: SQLOutputValue | undefined): string[] {
    const text = asText(value);
    if (!text) {
        return [];
    }
    try {
        const parsed = JSON.parse(text) as unknown;
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.filter((entry): entry is string => typeof entry === 'string');
    } catch {
        return [];
    }
}

function mapSummary(entry: Record<string, SQLOutputValue>): MessageSummary {
    return {
        id: asNumber(entry.id),
        receivedAt: asText(entry.received_at) || '',
        remoteIp: asText(entry.remote_ip) || '',
        authUser: asText(entry.auth_user),
        mailFrom: asText(entry.mail_from),
        recipients: parseRecipients(entry.recipients),
        subject: asText(entry.subject),
        messageId: asText(entry.message_id),
        sizeBytes: asNumber(entry.size_bytes),
        status: (asText(entry.status) || 'failed') as MessageStatus,
        error: asText(entry.error),
    };
}

export function readSettings(db: Db): Map<string, string> {
    const map = new Map<string, string>();
    for (const entry of rows(db, 'SELECT key, value FROM settings')) {
        const key = asText(entry.key);
        const value = asText(entry.value);
        if (key && value != null) {
            map.set(key, value);
        }
    }
    return map;
}

export function writeSetting(db: Db, key: string, value: string): void {
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
}

export function insertMessage(db: Db, message: NewMessage): number {
    const insertMessageStmt = db.prepare(`
        INSERT INTO messages (
            received_at, remote_ip, auth_user, mail_from, recipients, subject,
            message_id, size_bytes, status, error, text_body, html_body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAttachment = db.prepare(`
        INSERT INTO attachments (
            message_id, filename, content_type, size_bytes, content_id, is_inline, content
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN');
    try {
        const result = insertMessageStmt.run(
            message.receivedAt,
            message.remoteIp,
            message.authUser,
            message.mailFrom,
            JSON.stringify(message.recipients),
            message.subject,
            message.messageId,
            message.sizeBytes,
            message.status,
            message.error,
            message.textBody,
            message.htmlBody,
        );
        const id = Number(result.lastInsertRowid);
        for (const attachment of message.attachments) {
            insertAttachment.run(
                id,
                attachment.filename,
                attachment.contentType,
                attachment.content.length,
                attachment.contentId,
                attachment.inline ? 1 : 0,
                attachment.content,
            );
        }
        db.exec('COMMIT');
        return id;
    } catch (error) {
        try {
            db.exec('ROLLBACK');
        } catch {
            // Keep the original failure.
        }
        throw error;
    }
}

export function updateMessageStatus(db: Db, id: number, status: MessageStatus, error: string | null): void {
    db.prepare('UPDATE messages SET status = ?, error = ? WHERE id = ?').run(status, error, id);
}

export function listMessages(db: Db, filter: MessageFilter): { items: MessageSummary[]; total: number } {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.status) {
        where.push('status = ?');
        params.push(filter.status);
    }
    if (filter.q) {
        const pattern = likePattern(filter.q);
        where.push(`(
            IFNULL(subject, '') LIKE ? ESCAPE '!'
            OR IFNULL(mail_from, '') LIKE ? ESCAPE '!'
            OR recipients LIKE ? ESCAPE '!'
            OR remote_ip LIKE ? ESCAPE '!'
            OR IFNULL(error, '') LIKE ? ESCAPE '!'
            OR IFNULL(auth_user, '') LIKE ? ESCAPE '!'
        )`);
        params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }
    if (filter.from) {
        where.push('received_at >= ?');
        params.push(filter.from);
    }
    if (filter.to) {
        where.push('received_at < ?');
        params.push(filter.to);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const totalRow = row(db, `SELECT COUNT(*) AS count FROM messages ${clause}`, params);
    const items = rows(
        db,
        `SELECT id, received_at, remote_ip, auth_user, mail_from, recipients, subject, message_id, size_bytes, status, error
         FROM messages ${clause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, filter.limit, filter.offset],
    ).map(mapSummary);
    return { items, total: asNumber(totalRow?.count) };
}

export function messageStatusCounts(db: Db): Record<MessageStatus, number> {
    const counts: Record<MessageStatus, number> = { accepted: 0, sent: 0, failed: 0, rejected: 0 };
    for (const entry of rows(db, 'SELECT status, COUNT(*) AS count FROM messages GROUP BY status')) {
        const status = asText(entry.status) as MessageStatus | null;
        if (status && status in counts) {
            counts[status] = asNumber(entry.count);
        }
    }
    return counts;
}

export function getMessage(db: Db, id: number): MessageDetail | undefined {
    const entry = row(
        db,
        `SELECT id, received_at, remote_ip, auth_user, mail_from, recipients, subject, message_id,
                size_bytes, status, error, text_body, html_body
         FROM messages WHERE id = ?`,
        [id],
    );
    if (!entry) {
        return undefined;
    }
    return {
        ...mapSummary(entry),
        textBody: asText(entry.text_body),
        htmlBody: asText(entry.html_body),
    };
}

export function listAttachmentMeta(db: Db, messageId: number): AttachmentMeta[] {
    return rows(
        db,
        `SELECT id, filename, content_type, size_bytes, content_id, is_inline
         FROM attachments WHERE message_id = ? ORDER BY id`,
        [messageId],
    ).map(mapAttachmentMeta);
}

export function listAttachmentsWithContent(db: Db, messageId: number): AttachmentFile[] {
    return rows(
        db,
        `SELECT id, filename, content_type, size_bytes, content_id, is_inline, content
         FROM attachments WHERE message_id = ? ORDER BY id`,
        [messageId],
    ).map((entry) => ({
        ...mapAttachmentMeta(entry),
        content: asBuffer(entry.content),
    }));
}

export function getAttachment(db: Db, messageId: number, attachmentId: number): AttachmentFile | undefined {
    const entry = row(
        db,
        `SELECT id, filename, content_type, size_bytes, content_id, is_inline, content
         FROM attachments WHERE message_id = ? AND id = ?`,
        [messageId, attachmentId],
    );
    if (!entry) {
        return undefined;
    }
    return {
        ...mapAttachmentMeta(entry),
        content: asBuffer(entry.content),
    };
}

function mapAttachmentMeta(entry: Record<string, SQLOutputValue>): AttachmentMeta {
    return {
        id: asNumber(entry.id),
        filename: asText(entry.filename) || 'anhang',
        contentType: asText(entry.content_type) || 'application/octet-stream',
        sizeBytes: asNumber(entry.size_bytes),
        contentId: asText(entry.content_id),
        inline: asNumber(entry.is_inline) === 1,
    };
}

export function listAllowedIps(db: Db): AllowedIp[] {
    return rows(db, 'SELECT id, cidr, note, enabled FROM allowed_ips ORDER BY id').map((entry) => ({
        id: asNumber(entry.id),
        cidr: asText(entry.cidr) || '',
        note: asText(entry.note) || '',
        enabled: asNumber(entry.enabled) === 1,
    }));
}

export function listEnabledCidrs(db: Db): string[] {
    return listAllowedIps(db).filter((entry) => entry.enabled).map((entry) => entry.cidr);
}

export function addAllowedIp(db: Db, cidr: string, note: string): 'ok' | 'duplicate' {
    try {
        db.prepare('INSERT INTO allowed_ips (cidr, note, enabled) VALUES (?, ?, 1)').run(cidr, note);
        return 'ok';
    } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
            return 'duplicate';
        }
        throw error;
    }
}

export function toggleAllowedIp(db: Db, id: number): void {
    db.prepare('UPDATE allowed_ips SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
}

export function deleteAllowedIp(db: Db, id: number): void {
    db.prepare('DELETE FROM allowed_ips WHERE id = ?').run(id);
}

export function listSmtpUsers(db: Db): Array<Omit<SmtpUser, 'passwordHash'>> {
    return rows(db, 'SELECT id, username, enabled FROM smtp_users ORDER BY username COLLATE NOCASE').map((entry) => ({
        id: asNumber(entry.id),
        username: asText(entry.username) || '',
        enabled: asNumber(entry.enabled) === 1,
    }));
}

export function findSmtpUser(db: Db, username: string): SmtpUser | undefined {
    const entry = row(
        db,
        'SELECT id, username, password_hash, enabled FROM smtp_users WHERE username = ? COLLATE NOCASE',
        [username],
    );
    if (!entry) {
        return undefined;
    }
    return {
        id: asNumber(entry.id),
        username: asText(entry.username) || '',
        passwordHash: asText(entry.password_hash) || '',
        enabled: asNumber(entry.enabled) === 1,
    };
}

export function countEnabledSmtpUsers(db: Db): number {
    const entry = row(db, 'SELECT COUNT(*) AS count FROM smtp_users WHERE enabled = 1');
    return asNumber(entry?.count);
}

export function addSmtpUser(db: Db, username: string, passwordHash: string): 'ok' | 'duplicate' {
    try {
        db.prepare('INSERT INTO smtp_users (username, password_hash, enabled) VALUES (?, ?, 1)').run(username, passwordHash);
        return 'ok';
    } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) {
            return 'duplicate';
        }
        throw error;
    }
}

export function toggleSmtpUser(db: Db, id: number): void {
    db.prepare('UPDATE smtp_users SET enabled = CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id = ?').run(id);
}

export function deleteSmtpUser(db: Db, id: number): void {
    db.prepare('DELETE FROM smtp_users WHERE id = ?').run(id);
}

export function insertEvent(db: Db, level: string, message: string): void {
    db.prepare('INSERT INTO events (ts, level, message) VALUES (?, ?, ?)').run(new Date().toISOString(), level, message);
}

export function listEvents(db: Db, limit = 200): SystemEvent[] {
    return rows(db, 'SELECT id, ts, level, message FROM events ORDER BY id DESC LIMIT ?', [limit]).map((entry) => ({
        id: asNumber(entry.id),
        ts: asText(entry.ts) || '',
        level: asText(entry.level) || '',
        message: asText(entry.message) || '',
    }));
}

export function deleteExpired(db: Db, cutoffIso: string): { messages: number; events: number } {
    const messages = db.prepare('DELETE FROM messages WHERE received_at < ?').run(cutoffIso);
    const events = db.prepare('DELETE FROM events WHERE ts < ?').run(cutoffIso);
    return { messages: Number(messages.changes), events: Number(events.changes) };
}

function likePattern(value: string): string {
    const escaped = value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
    return `%${escaped}%`;
}
