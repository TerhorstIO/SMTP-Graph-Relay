import { bootstrap } from './bootstrap';
import { openDatabase } from './db/database';
import { migrate } from './db/migrate';
import { errorMessage } from './errors';
import { Logger } from './logger';
import { ensureDataDirectories } from './paths';
import { startRetention } from './retention';
import { adminUrl, getSettings } from './settings';
import { SmtpService } from './smtp/server';
import { WebServer } from './web/server';

async function main(): Promise<void> {
    assertNodeVersion();
    const paths = ensureDataDirectories();
    const db = openDatabase(paths.databasePath);
    migrate(db);
    const logger = new Logger(db);
    const startup = bootstrap(db, logger);
    const smtp = new SmtpService(db, logger);
    let web: WebServer;
    web = new WebServer(db, logger, {
        reloadSmtp: () => smtp.reload(),
        reloadWeb: () => web.reload(),
    });
    const stopRetention = startRetention(db, logger);

    let stopping = false;
    const shutdown = (signal: string): void => {
        if (stopping) {
            return;
        }
        stopping = true;
        logger.info(`${signal} empfangen. Server wird beendet.`);
        stopRetention();
        void smtp.stop()
            .then(() => web.stop())
            .then(() => {
                logger.info('Server beendet.');
                db.close();
                process.exit(0);
            })
            .catch((error) => {
                process.stderr.write(`Beenden fehlgeschlagen: ${errorMessage(error)}\n`);
                try {
                    db.close();
                } catch {
                    // The process is exiting anyway.
                }
                process.exit(1);
            });
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    try {
        await web.start();
    } catch (error) {
        logger.error(`Admin-Oberfläche konnte nicht starten: ${errorMessage(error)}`);
        db.close();
        process.exit(1);
    }
    await smtp.start();

    const settings = getSettings(db);
    const lines = [
        '',
        'SMTP-Graph-Relay',
        `Admin: ${adminUrl(settings)}`,
        `Datenbank: ${paths.databasePath}`,
    ];
    if (settings.webHost === '0.0.0.0' || settings.webHost === '::') {
        lines.push(`Erreichbar auf allen Schnittstellen, Port ${settings.webPort}.`);
    }
    if (startup.generatedPassword) {
        lines.push(`Einmaliges Admin-Passwort: ${startup.generatedPassword}`);
        lines.push('Bitte nach dem Login unter Einstellungen ändern.');
    }
    if (startup.passwordFromEnv) {
        lines.push('Admin-Passwort aus ADMIN_PASSWORD übernommen.');
    }
    process.stdout.write(`${lines.join('\n')}\n\n`);
}

function assertNodeVersion(): void {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || (major === 22 && minor < 13)) {
        process.stderr.write('Node.js 22.13 oder neuer wird benötigt.\n');
        process.exit(1);
    }
}

void main().catch((error) => {
    process.stderr.write(`Start fehlgeschlagen: ${errorMessage(error)}\n`);
    process.exit(1);
});
