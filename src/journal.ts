import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DomainError } from './types.ts';

const integer = z.string().regex(/^-?\d+$/);
const statusSchema = z.enum(['queued', 'prepared', 'uncertain', 'confirming', 'partial', 'completed', 'paused', 'expired', 'failed', 'cancelled']);
export const intentInputSchema = z.object({
  id: z.string().min(8).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  target: z.string().min(1).max(100),
  maxPosition: z.string().min(1).max(100),
  limitPrice: z.string().min(1).max(100),
  deadline: z.string().datetime({ offset: true }),
}).strict();

const attemptBase = z.object({
  number: z.number().int().positive(),
  hash: z.string().min(1),
  serialized: z.string().min(1),
  nonce: z.number().int().nonnegative(),
  side: z.enum(['buy', 'sell']),
  quantity: integer,
  limitPrice: integer,
  reduceOnly: z.boolean(),
  beforePosition: integer,
  beforeBlock: integer,
});
const attemptSchema = z.discriminatedUnion('phase', [
  attemptBase.extend({ phase: z.literal('signed') }),
  attemptBase.extend({ phase: z.literal('submitted') }),
  attemptBase.extend({
    phase: z.literal('confirmed'),
    receipt: z.object({ blockNumber: integer, blockHash: z.string(), success: z.boolean() }),
    afterPosition: integer.nullable(),
  }),
]);

const intentSchema = z.object({
  input: intentInputSchema,
  fingerprint: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: statusSchema,
  message: z.string(),
  attempts: z.array(attemptSchema),
});
export type IntentRecord = z.infer<typeof intentSchema>;
export type AttemptRecord = z.infer<typeof attemptSchema>;

const eventSchema = z.object({
  sequence: z.number(), type: z.string(), at: z.number(), message: z.string(), data: z.record(z.unknown()),
});
export type JournalEvent = z.infer<typeof eventSchema>;

export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 1000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, intent_id TEXT NOT NULL,
        type TEXT NOT NULL, at INTEGER NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL
      );
    `);
  }

  bind(identity: string): void {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('account_binding');
    if (row && row.value !== identity) {
      throw new DomainError('journal_binding_mismatch', 'This journal belongs to another account, market or network. Use a separate data directory.', 409);
    }
    this.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)').run('account_binding', identity);
  }

  get(id: string): IntentRecord | null {
    const row = this.db.prepare('SELECT record FROM intents WHERE id = ?').get(id);
    if (!row) return null;
    if (typeof row.record !== 'string') throw new DomainError('corrupt_journal', 'Invalid journal record.', 500);
    return intentSchema.parse(JSON.parse(row.record));
  }

  list(): IntentRecord[] {
    return this.db.prepare('SELECT record FROM intents ORDER BY rowid DESC').all().map(row => {
      if (typeof row.record !== 'string') throw new DomainError('corrupt_journal', 'Invalid journal record.', 500);
      return intentSchema.parse(JSON.parse(row.record));
    });
  }

  save(record: IntentRecord, type: string, message: string, data: Record<string, unknown> = {}): void {
    const valid = intentSchema.parse(record);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO intents(id,record) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record')
        .run(valid.input.id, JSON.stringify(valid));
      this.db.prepare('INSERT INTO events(intent_id,type,at,message,data) VALUES (?,?,?,?,?)')
        .run(valid.input.id, type, record.updatedAt, message, JSON.stringify(data));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  events(id: string): JournalEvent[] {
    return this.db.prepare('SELECT sequence,type,at,message,data FROM events WHERE intent_id = ? ORDER BY sequence').all(id).map(row => {
      if (typeof row.data !== 'string') throw new DomainError('corrupt_journal', 'Invalid event data.', 500);
      return eventSchema.parse({ ...row, data: JSON.parse(row.data) });
    });
  }

  close(): void { this.db.close(); }
}
