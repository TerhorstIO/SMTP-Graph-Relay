import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

export function openDatabase(filePath: string): Db {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const db = new DatabaseSync(filePath, {
        enableForeignKeyConstraints: true,
        timeout: 5000,
    });
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    return db;
}
