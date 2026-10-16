import { Db } from './db/database';
import { insertEvent } from './db/store';

export class Logger {
    constructor(private readonly db: Db) {}

    info(message: string): void {
        this.write('INFO', message);
    }

    warn(message: string): void {
        this.write('WARN', message);
    }

    error(message: string): void {
        this.write('ERROR', message);
    }

    private write(level: string, message: string): void {
        const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
        if (level === 'ERROR') {
            process.stderr.write(line);
        } else {
            process.stdout.write(line);
        }
        try {
            insertEvent(this.db, level, message);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            process.stderr.write(`[${new Date().toISOString()}] [ERROR] Ereignis konnte nicht gespeichert werden: ${reason}\n`);
        }
    }
}
