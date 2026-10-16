import { MessageStatus } from '../db/store';
import { AppSettings } from '../settings';
import { APP_VERSION } from '../paths';

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function renderLogin(error?: string): string {
    return document('Anmeldung', `
        <main class="login">
            <form class="card" method="post" action="/login">
                <p class="eyebrow">SMTP-Graph-Relay</p>
                <h1>Anmeldung</h1>
                ${error ? `<p class="errors">${escapeHtml(error)}</p>` : ''}
                <label>Passwort
                    <input type="password" name="password" autocomplete="current-password" required autofocus>
                </label>
                <button type="submit">Anmelden</button>
            </form>
        </main>
    `);
}

export function renderStatus(title: string, text: string): string {
    return document(title, `<main><section class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></section></main>`);
}

interface LayoutOptions {
    title: string;
    currentPath: string;
    csrf: string;
    warnings: string[];
    notice?: string;
    errors?: string[];
    body: string;
}

export function layout(options: LayoutOptions): string {
    const nav = [
        ['/', 'Protokoll'],
        ['/events', 'Ereignisse'],
        ['/users', 'Benutzer'],
        ['/ips', 'IP-Filter'],
        ['/settings', 'Einstellungen'],
    ].map(([href, label]) => {
        const active = href === '/'
            ? options.currentPath === '/' || options.currentPath.startsWith('/messages')
            : options.currentPath.startsWith(href);
        return `<a class="${active ? 'active' : ''}" href="${href}">${label}</a>`;
    }).join('');
    const warnings = options.warnings.map((warning) => `<p class="warning">${escapeHtml(warning)}</p>`).join('');
    const errors = (options.errors || []).map((error) => `<p class="errors">${escapeHtml(error)}</p>`).join('');
    const notice = options.notice ? `<p class="flash">${escapeHtml(options.notice)}</p>` : '';
    return document(options.title, `
        <header>
            <div>
                <strong>SMTP-Graph-Relay</strong>
                <span class="muted"> ${escapeHtml(APP_VERSION)}</span>
            </div>
            <form method="post" action="/logout">
                <input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}">
                <button class="secondary" type="submit">Abmelden</button>
            </form>
        </header>
        <nav>${nav}</nav>
        <main>
            ${warnings}
            ${notice}
            ${errors}
            ${options.body}
        </main>
    `);
}

export interface MessageRowView {
    id: number;
    receivedAt: string;
    remoteIp: string;
    authUser: string | null;
    mailFrom: string | null;
    recipients: string[];
    subject: string | null;
    sizeBytes: number;
    status: MessageStatus;
    error: string | null;
}

export function renderMessages(input: {
    rows: MessageRowView[];
    counts: Record<MessageStatus, number>;
    total: number;
    page: number;
    pageSize: number;
    status: string;
    q: string;
    from: string;
    to: string;
}): string {
    const pages = Math.max(1, Math.ceil(input.total / input.pageSize));
    const query = (page: number): string => {
        const params = new URLSearchParams();
        if (input.status) params.set('status', input.status);
        if (input.q) params.set('q', input.q);
        if (input.from) params.set('from', input.from);
        if (input.to) params.set('to', input.to);
        if (page > 1) params.set('page', String(page));
        const value = params.toString();
        return value ? `/?${value}` : '/';
    };
    const bodyRows = input.rows.length === 0
        ? '<tr><td colspan="7" class="muted">Keine Einträge.</td></tr>'
        : input.rows.map((row) => `
            <tr>
                <td><a href="/messages/${row.id}">${escapeHtml(formatDate(row.receivedAt))}</a></td>
                <td>${badge(row.status)}</td>
                <td class="mono">${escapeHtml(row.remoteIp)}</td>
                <td class="mono">${escapeHtml(row.mailFrom || '')}</td>
                <td class="mono">${escapeHtml(row.recipients.join(', '))}</td>
                <td>${escapeHtml(row.subject || '')}</td>
                <td>${escapeHtml(formatBytes(row.sizeBytes))}</td>
            </tr>
        `).join('');
    return `
        <section class="counts">
            <span>${badge('sent')} ${input.counts.sent}</span>
            <span>${badge('failed')} ${input.counts.failed}</span>
            <span>${badge('rejected')} ${input.counts.rejected}</span>
            <span>${badge('accepted')} ${input.counts.accepted}</span>
        </section>
        <form class="card filters" method="get" action="/">
            <label>Status
                <select name="status">
                    <option value="">Alle</option>
                    ${statusOption('sent', 'Zugestellt', input.status)}
                    ${statusOption('failed', 'Fehlgeschlagen', input.status)}
                    ${statusOption('rejected', 'Abgelehnt', input.status)}
                    ${statusOption('accepted', 'Angenommen', input.status)}
                </select>
            </label>
            <label>Suche
                <input name="q" value="${escapeHtml(input.q)}" placeholder="Betreff, Adresse, IP, Fehler">
            </label>
            <label>Von
                <input type="date" name="from" value="${escapeHtml(input.from)}">
            </label>
            <label>Bis
                <input type="date" name="to" value="${escapeHtml(input.to)}">
            </label>
            <button type="submit">Filtern</button>
        </form>
        <section class="card">
            <table>
                <thead>
                    <tr><th>Zeit</th><th>Status</th><th>IP</th><th>Von</th><th>Empfänger</th><th>Betreff</th><th>Größe</th></tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
            <div class="pager">
                ${input.page > 1 ? `<a class="button secondary" href="${query(input.page - 1)}">Zurück</a>` : ''}
                <span class="muted">Seite ${input.page} von ${pages}</span>
                ${input.page < pages ? `<a class="button secondary" href="${query(input.page + 1)}">Weiter</a>` : ''}
            </div>
        </section>
    `;
}

export function renderMessage(input: {
    id: number;
    receivedAt: string;
    status: MessageStatus;
    remoteIp: string;
    authUser: string | null;
    mailFrom: string | null;
    recipients: string[];
    subject: string | null;
    messageId: string | null;
    sizeBytes: number;
    error: string | null;
    textBody: string | null;
    hasHtml: boolean;
    attachments: Array<{ id: number; filename: string; contentType: string; sizeBytes: number }>;
}): string {
    const attachments = input.attachments.length === 0
        ? '<p class="muted">Keine Anhänge.</p>'
        : `<ul>${input.attachments.map((attachment) =>
            `<li><a href="/messages/${input.id}/attachments/${attachment.id}">${escapeHtml(attachment.filename)}</a>
                <span class="muted">${escapeHtml(attachment.contentType)} · ${escapeHtml(formatBytes(attachment.sizeBytes))}</span></li>`,
        ).join('')}</ul>`;
    const body = input.hasHtml
        ? `<iframe class="preview" sandbox src="/messages/${input.id}/preview" referrerpolicy="no-referrer"></iframe>`
        : `<pre class="mail-text">${escapeHtml(input.textBody || '')}</pre>`;
    const textDetails = input.hasHtml && input.textBody
        ? `<details><summary>Textversion</summary><pre class="mail-text">${escapeHtml(input.textBody)}</pre></details>`
        : '';
    return `
        <p><a href="/">Zurück zum Protokoll</a></p>
        <section class="card">
            <h1>${escapeHtml(input.subject || '(kein Betreff)')}</h1>
            <p>${badge(input.status)}</p>
            ${input.error ? `<p class="errors">${escapeHtml(input.error)}</p>` : ''}
            <dl>
                <dt>Zeit</dt><dd>${escapeHtml(formatDate(input.receivedAt))}</dd>
                <dt>IP</dt><dd class="mono">${escapeHtml(input.remoteIp)}</dd>
                <dt>SMTP-Benutzer</dt><dd class="mono">${escapeHtml(input.authUser || '—')}</dd>
                <dt>Envelope-From</dt><dd class="mono">${escapeHtml(input.mailFrom || '—')}</dd>
                <dt>Empfänger</dt><dd class="mono">${escapeHtml(input.recipients.join(', ') || '—')}</dd>
                <dt>Message-ID</dt><dd class="mono">${escapeHtml(input.messageId || '—')}</dd>
                <dt>Größe</dt><dd>${escapeHtml(formatBytes(input.sizeBytes))}</dd>
            </dl>
            <h2>Anhänge</h2>
            ${attachments}
            <h2>Inhalt</h2>
            ${body}
            ${textDetails}
        </section>
    `;
}

export function renderPreviewDocument(content: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${content}</body></html>`;
}

export function renderEvents(events: Array<{ ts: string; level: string; message: string }>): string {
    const body = events.length === 0
        ? '<tr><td colspan="3" class="muted">Keine Ereignisse.</td></tr>'
        : events.map((event) => `
            <tr>
                <td>${escapeHtml(formatDate(event.ts))}</td>
                <td>${escapeHtml(event.level)}</td>
                <td>${escapeHtml(event.message)}</td>
            </tr>
        `).join('');
    return `
        <section class="card">
            <table>
                <thead><tr><th>Zeit</th><th>Stufe</th><th>Meldung</th></tr></thead>
                <tbody>${body}</tbody>
            </table>
        </section>
    `;
}

export function renderUsers(input: {
    csrf: string;
    users: Array<{ id: number; username: string; enabled: boolean }>;
}): string {
    const rows = input.users.length === 0
        ? '<tr><td colspan="3" class="muted">Keine SMTP-Benutzer.</td></tr>'
        : input.users.map((user) => `
            <tr>
                <td class="mono">${escapeHtml(user.username)}</td>
                <td>${user.enabled ? 'aktiv' : 'deaktiviert'}</td>
                <td class="row-actions">
                    <form method="post" action="/users/${user.id}/toggle">
                        ${csrfField(input.csrf)}
                        <button class="secondary" type="submit">${user.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
                    </form>
                    <form method="post" action="/users/${user.id}/delete" onsubmit="return confirm('Benutzer löschen?')">
                        ${csrfField(input.csrf)}
                        <button class="danger" type="submit">Löschen</button>
                    </form>
                </td>
            </tr>
        `).join('');
    return `
        <form class="card grid" method="post" action="/users">
            ${csrfField(input.csrf)}
            <label>Benutzername
                <input name="username" autocomplete="off" required>
            </label>
            <label>Passwort
                <input type="password" name="password" autocomplete="new-password" required>
            </label>
            <div class="span"><button type="submit">Benutzer anlegen</button></div>
        </form>
        <section class="card">
            <table>
                <thead><tr><th>Benutzer</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </section>
    `;
}

export function renderIps(input: {
    csrf: string;
    ips: Array<{ id: number; cidr: string; note: string; enabled: boolean }>;
}): string {
    const rows = input.ips.length === 0
        ? '<tr><td colspan="4" class="muted">Keine IP-Einträge.</td></tr>'
        : input.ips.map((ip) => `
            <tr>
                <td class="mono">${escapeHtml(ip.cidr)}</td>
                <td>${escapeHtml(ip.note)}</td>
                <td>${ip.enabled ? 'aktiv' : 'deaktiviert'}</td>
                <td class="row-actions">
                    <form method="post" action="/ips/${ip.id}/toggle">
                        ${csrfField(input.csrf)}
                        <button class="secondary" type="submit">${ip.enabled ? 'Deaktivieren' : 'Aktivieren'}</button>
                    </form>
                    <form method="post" action="/ips/${ip.id}/delete" onsubmit="return confirm('Eintrag löschen?')">
                        ${csrfField(input.csrf)}
                        <button class="danger" type="submit">Löschen</button>
                    </form>
                </td>
            </tr>
        `).join('');
    return `
        <form class="card grid" method="post" action="/ips">
            ${csrfField(input.csrf)}
            <label>IP oder CIDR
                <input name="cidr" placeholder="192.168.0.0/24" required>
            </label>
            <label>Notiz
                <input name="note">
            </label>
            <div class="span"><button type="submit">Eintrag hinzufügen</button></div>
        </form>
        <section class="card">
            <table>
                <thead><tr><th>Bereich</th><th>Notiz</th><th>Status</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </section>
    `;
}

export interface SettingsView {
    csrf: string;
    settings: AppSettings;
    databasePath: string;
    certPresent: boolean;
    keyPresent: boolean;
    certPem: string;
}

export function renderSettings(view: SettingsView): string {
    const settings = view.settings;
    const implicit = settings.smtpImplicitTlsPort ?? '';
    const maxMb = Math.round(settings.smtpMaxMessageBytes / (1024 * 1024));
    return `
        <form class="card" method="post" action="/settings" enctype="multipart/form-data">
            ${csrfField(view.csrf)}
            <h2>Microsoft Graph</h2>
            <div class="grid">
                <label>Tenant-ID
                    <input name="graphTenantId" value="${escapeHtml(settings.graphTenantId)}" autocomplete="off">
                </label>
                <label>Client-ID
                    <input name="graphClientId" value="${escapeHtml(settings.graphClientId)}" autocomplete="off">
                </label>
                <label>Client-Secret
                    <input type="password" name="graphClientSecret" placeholder="${settings.graphClientSecret ? 'gespeichert, leer lassen zum Behalten' : ''}" autocomplete="new-password">
                </label>
                <label>Absenderpostfach
                    <input name="graphSender" value="${escapeHtml(settings.graphSender)}" placeholder="name@firma.de">
                </label>
            </div>
            <h2>SMTP</h2>
            <div class="grid">
                <label>Bind-Adresse
                    <input name="smtpHost" value="${escapeHtml(settings.smtpHost)}" required>
                </label>
                <label>Port
                    <input name="smtpPort" value="${settings.smtpPort}" required>
                </label>
                <label>Implizites TLS (leer = aus)
                    <input name="smtpImplicitTlsPort" value="${implicit}" placeholder="465">
                </label>
                <label>Maximale Mailgröße (MB)
                    <input name="maxMessageMb" value="${maxMb}" required>
                </label>
                <label class="check"><input type="checkbox" name="smtpRequireIp" value="1" ${settings.smtpRequireIp ? 'checked' : ''}> IP-Filter verlangen</label>
                <label class="check"><input type="checkbox" name="smtpRequireAuth" value="1" ${settings.smtpRequireAuth ? 'checked' : ''}> SMTP-Anmeldung verlangen</label>
            </div>
            <h2>Admin-Website</h2>
            <div class="grid">
                <label>Bind-Adresse
                    <input name="webHost" value="${escapeHtml(settings.webHost)}" required>
                </label>
                <label>Port
                    <input name="webPort" value="${settings.webPort}" required>
                </label>
                <label class="check span"><input type="checkbox" name="webHttps" value="1" ${settings.webHttps ? 'checked' : ''}> HTTPS verwenden</label>
                <label>Aufbewahrung in Tagen (0 = behalten)
                    <input name="retentionDays" value="${settings.retentionDays}" required>
                </label>
            </div>
            <h2>TLS-Zertifikat</h2>
            <p class="muted">Zertifikat ${view.certPresent ? 'vorhanden' : 'fehlt'} · Schlüssel ${view.keyPresent ? 'vorhanden' : 'fehlt'}. Leer lassen behält die vorhandenen Dateien.</p>
            <div class="grid">
                <label>Zertifikat (PEM)
                    <textarea name="certPem">${escapeHtml(view.certPem)}</textarea>
                </label>
                <label>Privater Schlüssel (PEM)
                    <textarea name="keyPem" placeholder="nur ausfüllen, um den Schlüssel zu ersetzen"></textarea>
                </label>
                <label>oder Zertifikatdatei
                    <input type="file" name="certFile" accept=".pem,.crt,.cer,.txt">
                </label>
                <label>oder Schlüsseldatei
                    <input type="file" name="keyFile" accept=".pem,.key,.txt">
                </label>
            </div>
            <p class="muted">Datenbank: <span class="mono">${escapeHtml(view.databasePath)}</span></p>
            <button type="submit">Speichern</button>
        </form>
        <form class="card" method="post" action="/settings/tls/generate">
            ${csrfField(view.csrf)}
            <h2>Selbstsigniertes Zertifikat</h2>
            <p class="muted">Ersetzt das aktuelle Zertifikat und den Schlüssel. Browser zeigen danach eine Warnung, bis dem Zertifikat vertraut wird.</p>
            <button type="submit">Neu erzeugen</button>
        </form>
        <form class="card grid" method="post" action="/settings/password">
            ${csrfField(view.csrf)}
            <h2 class="span">Admin-Passwort</h2>
            <label>Neues Passwort
                <input type="password" name="password" autocomplete="new-password" required>
            </label>
            <label>Wiederholung
                <input type="password" name="confirm" autocomplete="new-password" required>
            </label>
            <div class="span"><button type="submit">Passwort ändern</button></div>
        </form>
    `;
}

export function renderRestartNotice(url: string): string {
    return `
        <section class="card">
            <h1>Einstellungen gespeichert</h1>
            <p>Die Admin-Oberfläche startet neu.</p>
            <p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>
        </section>
    `;
}

function csrfField(csrf: string): string {
    return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">`;
}

function badge(status: MessageStatus): string {
    const labels: Record<MessageStatus, string> = {
        sent: 'Zugestellt',
        failed: 'Fehlgeschlagen',
        rejected: 'Abgelehnt',
        accepted: 'Angenommen',
    };
    return `<span class="badge ${status}">${labels[status]}</span>`;
}

function statusOption(value: string, label: string, selected: string): string {
    return `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`;
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return iso;
    }
    return date.toLocaleString('de-DE');
}

function formatBytes(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function document(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="de">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${escapeHtml(title)} · SMTP-Graph-Relay</title>
    <style>${css}</style>
</head>
<body>
${body}
</body>
</html>`;
}

const css = `
:root { --bg:#f3f0e8; --paper:#fffdf8; --ink:#1e1a16; --muted:#6d645b; --line:#e4d9cb; --accent:#0c6b58; --warn-bg:#fff3d6; --warn:#6d4d08; --bad:#9d2c2c; --ok:#0c6b58; --info:#2456a6; }
* { box-sizing:border-box; }
html, body { height:100%; }
body { margin:0; min-height:100vh; display:flex; flex-direction:column; font-family:"Segoe UI",sans-serif; background:var(--bg); color:var(--ink); }
a { color:var(--accent); }
header { display:flex; justify-content:space-between; align-items:center; gap:16px; padding:16px 24px; background:#1e1a16; color:#f6f1e8; }
header form { margin:0; }
header button.secondary { color:#f6f1e8; border-color:#c8bfb2; background:transparent; }
nav { display:flex; flex-wrap:wrap; gap:8px; padding:12px 24px; background:var(--paper); border-bottom:1px solid var(--line); }
nav a { text-decoration:none; color:var(--ink); padding:6px 12px; border-radius:999px; }
nav a.active { background:var(--accent); color:white; }
main { flex:1; display:flex; flex-direction:column; width:100%; min-width:0; padding:24px; }
main > .card:has(table) { flex:1; }
h1,h2 { font-weight:650; }
h1 { margin-top:0; }
.card { background:var(--paper); border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:16px; min-width:0; overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th,td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); }
label { display:block; margin-bottom:12px; font-size:14px; }
input,textarea,select { width:100%; margin-top:4px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; font:inherit; background:white; }
textarea { min-height:140px; font-family:Consolas,ui-monospace,monospace; }
button,.button { display:inline-block; background:var(--accent); color:white; border:0; border-radius:8px; padding:8px 14px; font:inherit; text-decoration:none; cursor:pointer; }
button.secondary,.button.secondary { background:transparent; color:var(--ink); border:1px solid var(--line); }
button.danger { background:var(--bad); }
.badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; }
.badge.sent { background:#e5f6f1; color:var(--ok); }
.badge.failed { background:#fde8e8; color:var(--bad); }
.badge.rejected { background:var(--warn-bg); color:var(--warn); }
.badge.accepted { background:#e7eefc; color:var(--info); }
.warning { background:var(--warn-bg); color:var(--warn); padding:10px 12px; border-radius:8px; margin:0 0 8px; }
.errors { background:#fde8e8; color:var(--bad); padding:10px 12px; border-radius:8px; margin:0 0 8px; }
.flash { background:#e5f6f1; color:var(--ok); padding:10px 12px; border-radius:8px; margin:0 0 8px; }
.grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(260px, 1fr)); gap:12px 16px; }
.span { grid-column:1 / -1; }
.filters { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; align-items:end; }
.filters button { margin-bottom:12px; }
.check { display:flex; align-items:center; gap:8px; }
.check input { width:auto; margin:0; }
.muted { color:var(--muted); }
.mono { font-family:Consolas,ui-monospace,monospace; word-break:break-word; }
.mail-text { white-space:pre-wrap; word-break:break-word; }
iframe.preview { width:100%; height:min(70vh, 900px); min-height:320px; border:1px solid var(--line); border-radius:8px; background:white; }
.row-actions,.pager,.counts { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.counts { margin-bottom:12px; }
.pager { margin-top:12px; }
dl { display:grid; grid-template-columns:160px 1fr; gap:6px 12px; }
dt { color:var(--muted); }
dd { margin:0; }
.login { min-height:100vh; display:grid; place-items:center; }
.login .card { width:min(420px, calc(100vw - 32px)); }
.eyebrow { margin:0; color:var(--muted); letter-spacing:.08em; text-transform:uppercase; font-size:12px; }
ul { padding-left:18px; }
@media (max-width:800px) {
    .grid,.filters,dl { grid-template-columns:1fr; }
    header,nav,main { padding-left:12px; padding-right:12px; }
    header { align-items:flex-start; }
}
`;
