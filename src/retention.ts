import { Db } from './db/database';
import { deleteExpired } from './db/store';
import { Logger } from './logger';
import { getSettings } from './settings';

const DAY_MS = 24 * 60 * 60 * 1000;

export function startRetention(db: Db, logger: Logger): () => void {
    const run = (): void => {
        const days = getSettings(db).retentionDays;
        if (days <= 0) {
            return;
        }
        const cutoff = new Date(Date.now() - days * DAY_MS).toISOString();
        try {
            const removed = deleteExpired(db, cutoff);
            if (removed.messages > 0 || removed.events > 0) {
                logger.info(`Aufbewahrung: ${removed.messages} Mails und ${removed.events} Ereignisse älter als ${days} Tage gelöscht.`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`Aufbewahrung fehlgeschlagen: ${message}`);
        }
    };

    run();
    const timer = setInterval(run, DAY_MS);
    timer.unref();
    return () => clearInterval(timer);
}
