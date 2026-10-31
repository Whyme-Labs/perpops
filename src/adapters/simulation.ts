import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { DomainError } from '../types.ts';
import type { AccountSnapshot, ExchangeAdapter, Fault, MarketDescriptor, OrderRequest, PreparedTransaction, TransactionReceipt } from '../types.ts';

const faultSchema = z.enum(['none', 'drop_ack', 'drop_before_send', 'stale_read', 'partial_fill', 'pending_receipt']);
const orderSchema = z.object({ side: z.enum(['buy', 'sell']), quantity: z.string().regex(/^\d+$/), limitPrice: z.string().regex(/^\d+$/), reduceOnly: z.boolean(), deadline: z.number(), nonce: z.number().int().nonnegative() });
const market: MarketDescriptor = {
  mode: 'simulation', symbol: 'BTC-PERP', chainId: 0, account: 'local-demo-account', pool: 'local-btc-pool',
  baseDecimals: 8, quoteDecimals: 18, lotSize: 1_000n, minQuantity: 13_000n,
  tickSize: 100_000_000_000_000_000n, explorerUrl: null, canTrade: true, nativeReduceOnly: true,
};
const PRICE = 100_000n * 10n ** 18n;
const blockHash = (block: bigint) => `0x${createHash('sha256').update(`perpops-simulation-block-${block}`).digest('hex')}`;

/** A durable local exchange model. It is deliberately not on-chain evidence. */
export class SimulationAdapter implements ExchangeAdapter {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  constructor(path: string, now: () => number = Date.now) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); chmodSync(path, 0o600); this.now = now;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transactions (hash TEXT PRIMARY KEY, block TEXT NOT NULL, success INTEGER NOT NULL, serialized TEXT NOT NULL);
    `);
    for (const [key, value] of Object.entries({ position: '0', block: '1000', nonce: '0', fault: 'none', staleBlock: '', stalePosition: '', hiddenHash: '', broadcasts: '0', executions: '0' })) {
      this.db.prepare('INSERT OR IGNORE INTO state(key,value) VALUES (?,?)').run(key, value);
    }
  }

  private get(key: string): string {
    const row = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    if (!row || typeof row.value !== 'string') throw new DomainError('simulation_state', 'Invalid simulator state.', 500);
    return row.value;
  }
  private set(key: string, value: string): void { this.db.prepare('UPDATE state SET value=? WHERE key=?').run(value, key); }
  async describe(): Promise<MarketDescriptor> { return { ...market }; }

  async snapshot(minBlock?: bigint): Promise<AccountSnapshot> {
    const stale = minBlock !== undefined && this.get('staleBlock') !== '';
    const block = BigInt(stale ? this.get('staleBlock') : this.get('block'));
    return {
      blockNumber: block, blockHash: blockHash(block), observedAt: this.now(),
      position: BigInt(stale ? this.get('stalePosition') : this.get('position')),
      pendingBuys: 0n, pendingSells: 0n, markPrice: PRICE,
      bestBid: PRICE - 10n * 10n ** 18n, bestAsk: PRICE + 10n * 10n ** 18n,
      collateral: 1_000n * 10n ** 18n,
    };
  }

  async prepareOrder(order: OrderRequest): Promise<PreparedTransaction> {
    const nonce = Number(this.get('nonce'));
    this.set('nonce', String(nonce + 1));
    const body = JSON.stringify({ ...order, quantity: order.quantity.toString(), limitPrice: order.limitPrice.toString(), nonce });
    return { hash: `0x${createHash('sha256').update(body).digest('hex')}`, serialized: `0x${Buffer.from(body).toString('hex')}`, nonce };
  }

  async broadcast(transaction: PreparedTransaction): Promise<void> {
    const body = Buffer.from(transaction.serialized.slice(2), 'hex').toString('utf8');
    if (`0x${createHash('sha256').update(body).digest('hex')}` !== transaction.hash) throw new DomainError('hash_mismatch', 'Simulator signed payload hash mismatch.');
    const order = orderSchema.parse(JSON.parse(body));
    if (order.nonce !== transaction.nonce) throw new DomainError('nonce_mismatch', 'Simulator nonce mismatch.');
    this.set('broadcasts', String(Number(this.get('broadcasts')) + 1));
    if (this.db.prepare('SELECT hash FROM transactions WHERE hash=?').get(transaction.hash)) return;
    const fault = this.armedFault();
    if (fault === 'drop_before_send') {
      this.set('fault', 'none');
      throw new DomainError('simulated_unsent', 'The simulated connection failed before the exchange received the saved transaction.');
    }
    const before = BigInt(this.get('position'));
    const beforeBlock = BigInt(this.get('block'));
    const block = beforeBlock + 1n;
    let quantity = BigInt(order.quantity);
    let success = order.deadline > this.now();
    const quote = order.side === 'buy' ? PRICE + 10n * 10n ** 18n : PRICE - 10n * 10n ** 18n;
    success = success && (order.side === 'buy' ? BigInt(order.limitPrice) >= quote : BigInt(order.limitPrice) <= quote);
    if (order.reduceOnly) {
      success = success && (order.side === 'buy' ? before < 0n && quantity <= -before : before > 0n && quantity <= before);
    }
    if (fault === 'partial_fill') quantity = (quantity / 2n / market.lotSize) * market.lotSize;
    const after = success ? before + (order.side === 'buy' ? quantity : -quantity) : before;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.set('position', after.toString()); this.set('block', block.toString());
      this.set('executions', String(Number(this.get('executions')) + 1));
      this.set('fault', 'none');
      if (fault === 'stale_read') { this.set('staleBlock', beforeBlock.toString()); this.set('stalePosition', before.toString()); }
      if (fault === 'pending_receipt') this.set('hiddenHash', transaction.hash);
      this.db.prepare('INSERT INTO transactions(hash,block,success,serialized) VALUES (?,?,?,?)').run(transaction.hash, block.toString(), success ? 1 : 0, transaction.serialized);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (fault === 'drop_ack') throw new DomainError('simulated_lost_ack', 'The simulated exchange executed the order, then its response was deliberately dropped.');
  }

  async receipt(hash: string): Promise<TransactionReceipt> {
    if (this.get('hiddenHash') === hash) return { kind: 'unknown' };
    const row = this.db.prepare('SELECT block,success FROM transactions WHERE hash=?').get(hash);
    if (!row) return { kind: 'unknown' };
    if (typeof row.block !== 'string' || typeof row.success !== 'number') throw new DomainError('simulation_state', 'Invalid simulated receipt.', 500);
    return { kind: 'confirmed', blockNumber: BigInt(row.block), blockHash: blockHash(BigInt(row.block)), success: row.success === 1 };
  }

  arm(fault: Fault): void {
    if (this.get('staleBlock') || this.get('hiddenHash')) throw new DomainError('pending_fault', 'Release the previous simulated delay before arming another fault.', 409);
    this.set('fault', faultSchema.parse(fault));
  }
  armedFault(): Fault { return faultSchema.parse(this.get('fault')); }
  settle(): void { this.set('staleBlock', ''); this.set('stalePosition', ''); this.set('hiddenHash', ''); }
  counts() { return { broadcasts: Number(this.get('broadcasts')), executions: Number(this.get('executions')), prepared: Number(this.get('nonce')) }; }
  async close(): Promise<void> { this.db.close(); }
}
