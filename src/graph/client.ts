import { Client } from '@microsoft/microsoft-graph-client';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { ClientSecretCredential } from '@azure/identity';
import { errorMessage } from '../errors';
import { AppSettings } from '../settings';
import { DeliveryLists } from '../mail/recipients';

export interface OutgoingAttachment {
    filename: string;
    contentType: string;
    content: Buffer;
    contentId: string | null;
    inline: boolean;
}

export interface OutgoingMail {
    subject: string;
    html: string | null;
    text: string | null;
    recipients: DeliveryLists;
    attachments: OutgoingAttachment[];
}

let cached: { key: string; client: Client } | undefined;
const warnedLookups = new Set<string>();

export function extractEmail(sender: string): string {
    const match = sender.match(/<([^>]+)>/);
    return (match?.[1] || sender).trim();
}

export async function sendViaGraph(
    settings: AppSettings,
    mail: OutgoingMail,
    warn?: (message: string) => void,
): Promise<string | null> {
    const sender = extractEmail(settings.graphSender);
    if (!sender.includes('@')) {
        throw new Error('Absender für Graph ist nicht konfiguriert.');
    }
    if (!settings.graphTenantId || !settings.graphClientId || !settings.graphClientSecret) {
        throw new Error('Graph-Zugangsdaten sind unvollständig.');
    }
    if (mail.recipients.to.length === 0 && mail.recipients.cc.length === 0 && mail.recipients.bcc.length === 0) {
        throw new Error('Die Mail hat keine Empfänger.');
    }

    const html = mail.html?.trim();
    const text = mail.text?.trim();
    const message: Record<string, unknown> = {
        subject: mail.subject,
        body: {
            contentType: html ? 'HTML' : 'Text',
            content: html || text || '',
        },
        toRecipients: mail.recipients.to.map(toRecipient),
    };
    if (mail.recipients.cc.length > 0) {
        message.ccRecipients = mail.recipients.cc.map(toRecipient);
    }
    if (mail.recipients.bcc.length > 0) {
        message.bccRecipients = mail.recipients.bcc.map(toRecipient);
    }
    if (mail.attachments.length > 0) {
        message.attachments = mail.attachments.map((attachment) => {
            const entry: Record<string, unknown> = {
                '@odata.type': '#microsoft.graph.fileAttachment',
                name: attachment.filename || 'anhang',
                contentType: attachment.contentType || 'application/octet-stream',
                contentBytes: attachment.content.toString('base64'),
            };
            if (attachment.inline && attachment.contentId) {
                entry.isInline = true;
                entry.contentId = attachment.contentId;
            }
            return entry;
        });
    }

    const client = clientFor(settings);
    const displayName = await lookupDisplayName(client, sender, warn);
    if (displayName) {
        const from = { emailAddress: { address: sender, name: displayName } };
        message.from = from;
        message.sender = from;
    }
    await client.api(`/users/${encodeURIComponent(sender)}/sendMail`).post({ message });
    return displayName;
}

async function lookupDisplayName(
    client: Client,
    sender: string,
    warn?: (message: string) => void,
): Promise<string | null> {
    try {
        const user = await client
            .api(`/users/${encodeURIComponent(sender)}`)
            .select('displayName')
            .get() as { displayName?: string };
        const name = user.displayName?.trim() ?? '';
        return name || null;
    } catch (error) {
        const key = sender.toLowerCase();
        if (warn && !warnedLookups.has(key)) {
            warnedLookups.add(key);
            const status = typeof error === 'object' && error && 'statusCode' in error
                ? Number((error as { statusCode?: number }).statusCode)
                : 0;
            if (status === 403) {
                warn(`Anzeigename von ${sender} konnte nicht gelesen werden. Die App braucht die Anwendungsberechtigung User.Read.All mit Administratorzustimmung.`);
            } else {
                warn(`Anzeigename von ${sender} konnte nicht gelesen werden: ${errorMessage(error)}`);
            }
        }
        return null;
    }
}

function clientFor(settings: AppSettings): Client {
    const key = `${settings.graphTenantId}\n${settings.graphClientId}\n${settings.graphClientSecret}`;
    if (cached?.key === key) {
        return cached.client;
    }
    const credential = new ClientSecretCredential(
        settings.graphTenantId,
        settings.graphClientId,
        settings.graphClientSecret,
    );
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
        scopes: ['https://graph.microsoft.com/.default'],
    });
    const client = Client.initWithMiddleware({ authProvider });
    cached = { key, client };
    return client;
}

function toRecipient(address: string): { emailAddress: { address: string } } {
    return { emailAddress: { address } };
}
