import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DomainError } from './types.ts';

function canonicalJournalPath(journalPath: string): string {
  if (journalPath.length === 0 || journalPath === ':memory:') {
    throw new DomainError('invalid_journal_path', 'The writer lock requires a journal file path.');
  }
  const absolute = resolve(journalPath);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  return existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error
    && 'errcode' in error
    && typeof error.errcode === 'number'
    && (error.errcode & 0xff) === 5;
}

/**
 * Holds one SQLite write transaction for the executor's lifetime. Journal writes
 * use a separate database so signed transactions can commit before network I/O.
 * Process death releases this OS-backed lock without deleting its database file.
 * The journal and sidecar must stay on one local filesystem, without hard links.
 */
export class WriterLock {
  #database: DatabaseSync | null;

  constructor(journalPath: string) {
    const lockPath = `${canonicalJournalPath(journalPath)}.writer-lock.sqlite`;
    const database = new DatabaseSync(lockPath);
    try {
      database.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
      this.#database = database;
    } catch (error) {
      database.close();
      if (isSqliteBusy(error)) {
        throw new DomainError('writer_busy', 'Another executor holds this journal writer lock.', 409);
      }
      throw error;
    }
  }

  close(): void {
    if (this.#database === null) return;
    this.#database.close();
    this.#database = null;
  }
}
