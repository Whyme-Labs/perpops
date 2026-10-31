import { createHash } from 'node:crypto';
import { absolute, exposureBounds, formatAmount, parseAmount } from './amounts.ts';
import { Journal, intentInputSchema } from './journal.ts';
import type { AttemptRecord, IntentRecord } from './journal.ts';
import { WriterLock } from './writer-lock.ts';
import { publicErrorMessage } from './errors.ts';
import { DomainError } from './types.ts';
import type { AccountSnapshot, ExchangeAdapter, MarketDescriptor, PreparedTransaction } from './types.ts';

const terminal = new Set(['completed', 'expired', 'failed', 'cancelled']);
const MAX_ATTEMPTS = 8;

export class Executor {
  readonly journal: Journal;
  readonly adapter: ExchangeAdapter;
  readonly market: MarketDescriptor;
  private readonly writer: WriterLock;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();

  private constructor(journal: Journal, adapter: ExchangeAdapter, market: MarketDescriptor, writer: WriterLock, now: () => number) {
    this.journal = journal; this.adapter = adapter; this.market = market; this.writer = writer; this.now = now;
  }

  static async open(options: { path: string; adapter: ExchangeAdapter; now?: () => number }): Promise<Executor> {
    const writer = new WriterLock(options.path);
    let journal: Journal | undefined;
    try {
      journal = new Journal(options.path);
      const market = await options.adapter.describe();
      journal.bind(JSON.stringify({ mode: market.mode, chain: market.chainId, account: market.account.toLowerCase(), pool: market.pool.toLowerCase(), symbol: market.symbol, baseDecimals: market.baseDecimals, quoteDecimals: market.quoteDecimals }));
      return new Executor(journal, options.adapter, market, writer, options.now ?? Date.now);
    } catch (error) {
      journal?.close(); writer.close(); throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  async create(raw: unknown): Promise<IntentRecord> {
    return this.serial(async () => {
      const parsed = intentInputSchema.safeParse(raw);
      if (!parsed.success) throw new DomainError('invalid_intent', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
      const input = parsed.data;
      const target = parseAmount(input.target, this.market.baseDecimals);
      const cap = parseAmount(input.maxPosition, this.market.baseDecimals);
      const price = parseAmount(input.limitPrice, this.market.quoteDecimals);
      if (cap <= 0n || absolute(target) > cap) throw new DomainError('position_limit', 'The absolute target must fit inside a positive position limit.');
      if (cap > parseAmount('0.01', this.market.baseDecimals)) throw new DomainError('position_limit', 'This prototype is limited to at most 0.01 BTC per dedicated account.');
      if (target % this.market.lotSize !== 0n) throw new DomainError('lot_size', 'The target must be an exact multiple of the market lot size.');
      if (price <= 0n || price % this.market.tickSize !== 0n) throw new DomainError('tick_size', 'Use a positive price on the market tick size.');
      const normalized = {
        id: input.id, target: formatAmount(target, this.market.baseDecimals),
        maxPosition: formatAmount(cap, this.market.baseDecimals), limitPrice: formatAmount(price, this.market.quoteDecimals),
        deadline: new Date(input.deadline).toISOString(),
      };
      const fingerprint = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
      const existing = this.journal.get(input.id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new DomainError('id_conflict', 'This instruction ID already belongs to another request. Use a new ID for a new instruction.', 409);
        this.record(existing, 'request_replayed', 'The same instruction was received again; its existing record was reused.');
        return this.advanceInternal(existing);
      }
      if (this.journal.list().some(record => !terminal.has(record.status))) {
        throw new DomainError('active_intent', 'Resolve or cancel the current instruction before starting another.', 409);
      }
      if (Date.parse(normalized.deadline) <= this.now()) throw new DomainError('expired', 'Choose a deadline in the future.');
      const created: IntentRecord = { input: normalized, fingerprint, createdAt: this.now(), updatedAt: this.now(), status: 'queued', message: 'Instruction recorded.', attempts: [] };
      this.journal.save(created, 'intent_recorded', created.message);
      return this.advanceInternal(created);
    });
  }

  async advance(id: string): Promise<IntentRecord> {
    return this.serial(() => this.advanceInternal(this.require(id)));
  }

  /** An explicit resend of the saved envelope, never a new order or nonce. */
  async retryBroadcast(id: string): Promise<IntentRecord> {
    return this.serial(async () => {
      const record = this.require(id);
      if (terminal.has(record.status)) return record;
      const attempt = record.attempts.at(-1);
      if (attempt?.phase === 'confirmed') return this.reconcile(record, attempt);
      if (!attempt || attempt.phase !== 'submitted') {
        throw new DomainError('nothing_to_rebroadcast', 'There is no unresolved broadcast to resend. Use Resume for an unsent instruction.', 409);
      }
      const hold = (message: string, type = 'rebroadcast_blocked') => {
        record.status = 'uncertain'; this.record(record, type, message, { hash: attempt.hash }); return record;
      };
      try {
        const receipt = await this.adapter.receipt(attempt.hash);
        if (receipt.kind === 'confirmed') return this.reconcile(record, attempt);
      } catch (error) { return hold(this.errorMessage(error), 'rebroadcast_receipt_wait'); }
      if (!this.market.canTrade) return hold('Trading is disabled. The original transaction remains unresolved and was not resent.');
      if (this.now() >= Date.parse(record.input.deadline)) {
        return hold('The signed order deadline has passed. Keep reconciling the original transaction; it cannot be resent by this workbench.');
      }
      try {
        const current = await this.adapter.snapshot(BigInt(attempt.beforeBlock));
        this.validateSnapshot(current);
        if (current.blockNumber < BigInt(attempt.beforeBlock) || current.position !== BigInt(attempt.beforePosition) || current.pendingBuys !== 0n || current.pendingSells !== 0n) {
          return hold('The account differs from the saved pre-trade state. Reconcile or inspect the original transaction before further execution.', 'rebroadcast_drift');
        }
      } catch (error) { return hold(this.errorMessage(error), 'rebroadcast_snapshot_wait'); }
      // A snapshot RPC can consume the remaining deadline. Never sign a replacement.
      if (this.now() >= Date.parse(record.input.deadline)) return hold('The signed order deadline passed during the account check. The transaction remains unresolved.');
      record.status = 'confirming';
      this.record(record, 'rebroadcast_started', 'Resending the original saved transaction with the same bytes, hash and nonce.', { hash: attempt.hash, nonce: attempt.nonce });
      try {
        await this.adapter.broadcast({ hash: attempt.hash, serialized: attempt.serialized, nonce: attempt.nonce });
      } catch (error) { return hold(this.errorMessage(error), 'rebroadcast_uncertain'); }
      this.record(record, 'rebroadcast_acknowledged', 'The original transaction was acknowledged. Checking its canonical receipt and account state.', { hash: attempt.hash });
      return this.reconcile(record, attempt);
    });
  }

  async cancel(id: string): Promise<IntentRecord> {
    return this.serial(async () => {
      const record = this.require(id);
      if (terminal.has(record.status)) return record;
      const last = record.attempts.at(-1);
      if (record.status === 'uncertain' || (last && (last.phase === 'submitted' || (last.phase === 'confirmed' && last.afterPosition === null)))) {
        throw new DomainError('unresolved_transaction', 'Reconcile the existing transaction first. Cancelling an instruction cannot cancel a transaction already sent.', 409);
      }
      record.status = 'cancelled';
      this.record(record, 'intent_cancelled', 'Stopped this instruction. Any confirmed position remains open.');
      return record;
    });
  }

  require(id: string): IntentRecord {
    const record = this.journal.get(id);
    if (!record) throw new DomainError('not_found', 'Instruction not found.', 404);
    return record;
  }

  private record(record: IntentRecord, type: string, message: string, data: Record<string, unknown> = {}): void {
    record.updatedAt = this.now(); record.message = message;
    this.journal.save(record, type, message, data);
  }

  private pause(record: IntentRecord, message: string, type = 'execution_paused'): IntentRecord {
    record.status = 'paused'; this.record(record, type, message); return record;
  }

  private validateSnapshot(snapshot: AccountSnapshot, minimum?: { blockNumber: bigint; blockHash: string }): void {
    if (snapshot.pendingBuys < 0n || snapshot.pendingSells < 0n || snapshot.markPrice <= 0n) {
      throw new DomainError('invalid_snapshot', 'The exchange returned invalid account or price data.');
    }
    if (!Number.isSafeInteger(snapshot.observedAt) || this.now() - snapshot.observedAt > 60_000 || snapshot.observedAt - this.now() > 30_000) {
      throw new DomainError('stale_snapshot', 'The account observation is too old or has an inconsistent timestamp.');
    }
    if (minimum && snapshot.blockNumber < minimum.blockNumber) {
      throw new DomainError('stale_snapshot', `Waiting for account state at block ${minimum.blockNumber} or newer. Received ${snapshot.blockNumber}.`);
    }
    if (minimum && snapshot.blockNumber === minimum.blockNumber && snapshot.blockHash !== minimum.blockHash) {
      throw new DomainError('block_mismatch', 'The account snapshot and transaction receipt disagree about the block hash.');
    }
  }

  private async advanceInternal(record: IntentRecord): Promise<IntentRecord> {
    if (terminal.has(record.status)) return record;
    const last = record.attempts.at(-1);
    // An unresolved send takes priority over deadline expiry. Never discard it.
    if (last?.phase === 'submitted' || (last?.phase === 'confirmed' && last.afterPosition === null)) {
      return this.reconcile(record, last);
    }
    if (last?.phase === 'signed') return this.send(record, last);
    if (last?.phase === 'confirmed') {
      try {
        const canonical = await this.adapter.receipt(last.hash);
        if (canonical.kind === 'unknown' || canonical.blockNumber.toString() !== last.receipt.blockNumber || canonical.blockHash !== last.receipt.blockHash || canonical.success !== last.receipt.success) {
          record.status = 'uncertain'; this.record(record, 'receipt_changed', 'The prior transaction is no longer confirmed as recorded. No new order was created.'); return record;
        }
      } catch (error) {
        record.status = 'uncertain'; this.record(record, 'receipt_recheck_wait', this.errorMessage(error)); return record;
      }
    }
    if (this.now() >= Date.parse(record.input.deadline)) {
      record.status = 'expired'; this.record(record, 'deadline_expired', 'The instruction expired before another order could be sent.'); return record;
    }
    if (record.attempts.length >= MAX_ATTEMPTS) return this.pause(record, 'The eight-attempt limit was reached. Cancel this instruction and inspect the account.');
    if (!this.market.canTrade) return this.pause(record, 'This adapter is read-only. Configure a dedicated testnet signer and explicitly enable testnet trading.');

    let snapshot: AccountSnapshot;
    try {
      const minimum = last?.phase === 'confirmed' ? { blockNumber: BigInt(last.receipt.blockNumber), blockHash: last.receipt.blockHash } : undefined;
      snapshot = await this.adapter.snapshot(minimum?.blockNumber);
      this.validateSnapshot(snapshot, minimum);
    } catch (error) { return this.pause(record, this.errorMessage(error)); }
    const target = parseAmount(record.input.target, this.market.baseDecimals);
    const cap = parseAmount(record.input.maxPosition, this.market.baseDecimals);
    const delta = target - snapshot.position;
    if (delta === 0n && snapshot.pendingBuys === 0n && snapshot.pendingSells === 0n) {
      record.status = 'completed'; this.record(record, 'target_reached', 'The confirmed position already matches the requested target.'); return record;
    }
    const side = delta >= 0n ? 'buy' : 'sell';
    const quantity = absolute(delta);
    const reducing = (snapshot.position > 0n && target >= 0n && delta < 0n) || (snapshot.position < 0n && target <= 0n && delta > 0n);
    const bounds = exposureBounds(snapshot.position, snapshot.pendingBuys + (side === 'buy' ? quantity : 0n), snapshot.pendingSells + (side === 'sell' ? quantity : 0n));
    const pureReduction = reducing && snapshot.pendingBuys === 0n && snapshot.pendingSells === 0n;
    if (bounds.peak > cap && !pureReduction) {
      return this.pause(record, `Pending fills could reach ${formatAmount(bounds.peak, this.market.baseDecimals)} BTC, above the ${record.input.maxPosition} BTC limit.`, 'risk_limit_blocked');
    }
    if (snapshot.pendingBuys !== 0n || snapshot.pendingSells !== 0n) {
      return this.pause(record, 'The account has resting orders outside this IOC executor. Cancel or resolve them at the venue before continuing.', 'external_orders_blocked');
    }
    if (quantity < this.market.minQuantity || quantity % this.market.lotSize !== 0n) {
      return this.pause(record, 'The remaining quantity is below the market minimum or off the lot-size grid.', 'quantity_blocked');
    }
    const limitPrice = parseAmount(record.input.limitPrice, this.market.quoteDecimals);
    const touch = side === 'buy' ? snapshot.bestAsk : snapshot.bestBid;
    if (touch === null || (side === 'buy' ? limitPrice < touch : limitPrice > touch)) {
      return this.pause(record, 'The current order book is empty or outside your price limit. No transaction was signed.', 'price_limit_blocked');
    }
    let prepared: PreparedTransaction;
    try {
      prepared = await this.adapter.prepareOrder({ side, quantity, limitPrice, reduceOnly: reducing && this.market.nativeReduceOnly, deadline: Date.parse(record.input.deadline) });
      if (!/^0x[0-9a-fA-F]{64}$/.test(prepared.hash) || !/^0x(?:[0-9a-fA-F]{2})+$/.test(prepared.serialized) || !Number.isSafeInteger(prepared.nonce) || prepared.nonce < 0) {
        throw new DomainError('invalid_preparation', 'The adapter returned invalid signed transaction data.');
      }
    } catch (error) { return this.pause(record, this.errorMessage(error), 'preflight_blocked'); }
    const attempt: AttemptRecord = {
      number: record.attempts.length + 1, hash: prepared.hash, serialized: prepared.serialized, nonce: prepared.nonce,
      side, quantity: quantity.toString(), limitPrice: limitPrice.toString(), reduceOnly: reducing && this.market.nativeReduceOnly,
      beforePosition: snapshot.position.toString(), beforeBlock: snapshot.blockNumber.toString(), phase: 'signed',
    };
    record.attempts.push(attempt); record.status = 'prepared';
    this.record(record, 'transaction_prepared', 'Signed transaction persisted before broadcast.', { hash: attempt.hash, nonce: attempt.nonce, quantity: formatAmount(quantity, this.market.baseDecimals), side, closeProtection: reducing ? (this.market.nativeReduceOnly ? 'native_reduce_only' : 'single_writer_quantity_limit') : 'not_a_close' });
    return this.send(record, attempt);
  }

  private async send(record: IntentRecord, attempt: AttemptRecord): Promise<IntentRecord> {
    if (!this.market.canTrade) {
      return this.pause(record, 'Trading is disabled. The saved signed transaction has not been broadcast.', 'trading_disabled');
    }
    // Preparation can take time, or this signed attempt may have survived a restart.
    // Do not send a stale delta when a liquidation or another actor changed the account.
    try {
      const current = await this.adapter.snapshot(BigInt(attempt.beforeBlock));
      this.validateSnapshot(current);
      if (current.blockNumber < BigInt(attempt.beforeBlock) || current.position !== BigInt(attempt.beforePosition) || current.pendingBuys !== 0n || current.pendingSells !== 0n) {
        return this.pause(record, 'The account changed after preparation. This signed transaction was not sent. Cancel this instruction and create a new one.', 'pre_send_drift');
      }
    } catch (error) { return this.pause(record, this.errorMessage(error), 'pre_send_wait'); }
    if (this.now() >= Date.parse(record.input.deadline)) {
      record.status = 'expired'; this.record(record, 'deadline_expired', 'The deadline passed during preparation. The signed transaction was never broadcast.'); return record;
    }
    const submitted: AttemptRecord = { ...attempt, phase: 'submitted' };
    record.attempts[record.attempts.length - 1] = submitted;
    record.status = 'confirming';
    this.record(record, 'send_started', 'Broadcast started. This transaction must be reconciled before any new order.', { hash: attempt.hash });
    try {
      await this.adapter.broadcast({ hash: attempt.hash, serialized: attempt.serialized, nonce: attempt.nonce });
    } catch (error) {
      record.status = 'uncertain';
      this.record(record, 'broadcast_uncertain', `The response was not confirmed. ${this.errorMessage(error)}`, { hash: attempt.hash });
      return record;
    }
    this.record(record, 'broadcast_acknowledged', 'The venue acknowledged this transaction. Waiting for receipt and account state.', { hash: attempt.hash });
    return this.reconcile(record, submitted);
  }

  private async reconcile(record: IntentRecord, attempt: AttemptRecord): Promise<IntentRecord> {
    let confirmed: Extract<AttemptRecord, { phase: 'confirmed' }>;
    try {
      // Re-read the receipt on every recovery; a persisted receipt alone is not canonicality proof.
      const receipt = await this.adapter.receipt(attempt.hash);
      if (receipt.kind === 'unknown') {
        record.status = 'uncertain'; this.record(record, 'receipt_unknown', 'No confirmed canonical receipt yet. No replacement order was created.', { hash: attempt.hash }); return record;
      }
      if (attempt.phase === 'confirmed' && (attempt.receipt.blockNumber !== receipt.blockNumber.toString() || attempt.receipt.blockHash !== receipt.blockHash || attempt.receipt.success !== receipt.success)) {
        record.status = 'uncertain'; this.record(record, 'receipt_changed', 'The receipt changed after confirmation. Stop and inspect the chain before continuing.'); return record;
      }
      confirmed = { ...attempt, phase: 'confirmed', receipt: { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, success: receipt.success }, afterPosition: null };
      record.attempts[record.attempts.length - 1] = confirmed;
      record.status = 'confirming';
      this.record(record, 'receipt_confirmed', receipt.success ? 'Transaction confirmed. Checking the resulting account state.' : 'The transaction reverted on chain.', { hash: attempt.hash, blockNumber: receipt.blockNumber.toString(), success: receipt.success });
      if (!receipt.success) {
        record.status = 'failed'; this.record(record, 'transaction_reverted', 'The transaction reverted. This instruction will not retry automatically.'); return record;
      }
      const snapshot = await this.adapter.snapshot(receipt.blockNumber);
      this.validateSnapshot(snapshot, { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash });
      const change = snapshot.position - BigInt(attempt.beforePosition);
      const allowedChange = attempt.side === 'buy' ? change >= 0n && change <= BigInt(attempt.quantity) : change <= 0n && -change <= BigInt(attempt.quantity);
      if (!allowedChange || snapshot.pendingBuys !== 0n || snapshot.pendingSells !== 0n) {
        confirmed.afterPosition = snapshot.position.toString();
        record.status = 'failed'; this.record(record, 'account_interference', 'Unexpected position or resting orders appeared. Inspect the dedicated account before creating another instruction.'); return record;
      }
      confirmed.afterPosition = snapshot.position.toString();
      const reached = snapshot.position === parseAmount(record.input.target, this.market.baseDecimals);
      record.status = reached ? 'completed' : 'partial';
      this.record(record, reached ? 'target_reached' : 'partial_fill', reached ? 'The confirmed account position matches the target.' : 'A partial fill was confirmed. Resume to prepare only the remaining quantity.', { position: formatAmount(snapshot.position, this.market.baseDecimals), filledQuantity: formatAmount(absolute(change), this.market.baseDecimals), blockNumber: snapshot.blockNumber.toString() });
      return record;
    } catch (error) {
      record.status = 'confirming'; this.record(record, 'reconciliation_wait', this.errorMessage(error), { hash: attempt.hash }); return record;
    }
  }

  view(record: IntentRecord) {
    return {
      ...record.input, createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.status, message: record.message,
      attempts: record.attempts.map(attempt => ({
        number: attempt.number, hash: attempt.hash, nonce: attempt.nonce, side: attempt.side,
        quantity: formatAmount(BigInt(attempt.quantity), this.market.baseDecimals), limitPrice: formatAmount(BigInt(attempt.limitPrice), this.market.quoteDecimals),
        reduceOnly: attempt.reduceOnly, phase: attempt.phase,
        receipt: attempt.phase === 'confirmed' ? attempt.receipt : null,
        beforePosition: formatAmount(BigInt(attempt.beforePosition), this.market.baseDecimals),
        afterPosition: attempt.phase === 'confirmed' && attempt.afterPosition !== null ? formatAmount(BigInt(attempt.afterPosition), this.market.baseDecimals) : null,
      })),
      events: this.journal.events(record.input.id),
    };
  }

  exportReceipt(id: string) {
    return { schemaVersion: 1, mode: this.market.mode, network: this.market.chainId, account: this.market.account, market: this.market.symbol, exportedAt: new Date(this.now()).toISOString(), scope: 'One dedicated account and one execution writer. Quantity limits are not loss guarantees. Simulation receipts are not on-chain evidence.', intent: this.view(this.require(id)) };
  }

  private errorMessage(error: unknown): string {
    return publicErrorMessage(error);
  }

  async close(): Promise<void> {
    await this.queue;
    try { await this.adapter.close?.(); } finally { this.journal.close(); this.writer.close(); }
  }
}
