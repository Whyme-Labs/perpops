import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { Executor } from '../src/executor.ts';
import { Journal } from '../src/journal.ts';
import { SimulationAdapter } from '../src/adapters/simulation.ts';
import { DomainError } from '../src/types.ts';
import type {
  AccountSnapshot, ExchangeAdapter, IntentInput, MarketDescriptor,
  OrderRequest, PreparedTransaction, TransactionReceipt,
} from '../src/types.ts';

function hash(value: bigint): string { return `0x${value.toString(16).padStart(64, '0')}`; }

/** The remote venue is controllable; the executor and SQLite journal are real. */
class ControlledVenue implements ExchangeAdapter {
  market: MarketDescriptor = {
    mode: 'simulation', symbol: 'BTC-PERP', chainId: 50383,
    account: '0x1111111111111111111111111111111111111111',
    pool: '0x2222222222222222222222222222222222222222',
    baseDecimals: 8, quoteDecimals: 6, lotSize: 1n, minQuantity: 1n,
    tickSize: 100000n, explorerUrl: null, canTrade: true, nativeReduceOnly: false,
  };
  position = 0n;
  pendingBuys = 0n;
  pendingSells = 0n;
  block = 100n;
  blockHash = hash(100n);
  observedAt: number | null = null;
  receiptValue: TransactionReceipt = { kind: 'unknown' };
  receiptError: Error | null = null;
  onPrepare: (() => void) | null = null;
  onBroadcast: (() => void) | null = null;
  preparedBytes: string | null = null;
  readonly orders: OrderRequest[] = [];
  readonly broadcasts: PreparedTransaction[] = [];
  readonly snapshotMinimums: Array<bigint | undefined> = [];
  readonly receiptLookups: string[] = [];
  readonly clock: () => number;

  constructor(clock: () => number) { this.clock = clock; }
  async describe(): Promise<MarketDescriptor> { return { ...this.market }; }
  async snapshot(minBlock?: bigint): Promise<AccountSnapshot> {
    this.snapshotMinimums.push(minBlock);
    return {
      blockNumber: this.block, blockHash: this.blockHash,
      observedAt: this.observedAt ?? this.clock(), position: this.position,
      pendingBuys: this.pendingBuys, pendingSells: this.pendingSells,
      markPrice: 100000000000n, bestBid: 99900000000n, bestAsk: 100000000000n,
      collateral: 1000000000n,
    };
  }
  async prepareOrder(order: OrderRequest): Promise<PreparedTransaction> {
    this.orders.push({ ...order });
    this.onPrepare?.();
    return { hash: hash(BigInt(this.orders.length)),
      serialized: this.preparedBytes ?? `0x${this.orders.length.toString(16).padStart(2, '0')}`,
      nonce: this.orders.length - 1 };
  }
  async broadcast(transaction: PreparedTransaction): Promise<void> {
    this.broadcasts.push({ ...transaction });
    this.onBroadcast?.();
  }
  async receipt(transactionHash: string): Promise<TransactionReceipt> {
    this.receiptLookups.push(transactionHash);
    if (this.receiptError !== null) throw this.receiptError;
    return this.receiptValue;
  }
  confirm(position: bigint, block = 101n): void {
    this.position = position; this.block = block; this.blockHash = hash(block);
    this.receiptValue = { kind: 'confirmed', blockNumber: block,
      blockHash: hash(block), success: true };
  }
}

async function setup(context: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-adversarial-'));
  const path = join(directory, 'journal.sqlite');
  let time = Date.parse('2026-10-30T12:00:00Z');
  const now = () => time;
  const venue = new ControlledVenue(now);
  const executor = await Executor.open({ path, adapter: venue, now });
  context.after(async () => {
    await executor.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const input: IntentInput = {
    id: 'adversarial_001', target: '0.001', maxPosition: '0.01',
    limitPrice: '100000', deadline: new Date(time + 60000).toISOString(),
  };
  return { executor, venue, path, input, now, setTime: (value: number) => { time = value; } };
}

function hasCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

test('same instruction normalizes numeric text, conflicting payload never signs again', async (context) => {
  const { executor, venue, input } = await setup(context);
  await executor.create(input);
  await executor.create({ ...input, target: '0.0010', limitPrice: '100000.0' });
  await assert.rejects(executor.create({ ...input, target: '0.002' }), hasCode('id_conflict'));
  assert.equal(venue.orders.length, 1);
  assert.equal(venue.broadcasts.length, 1);
  assert.equal(executor.journal.list().length, 1);
});

test('unknown remote outcome survives its deadline and blocks a new ID and cancellation', async (context) => {
  const { executor, venue, input, setTime } = await setup(context);
  await executor.create(input);
  setTime(Date.parse(input.deadline) + 1000);
  const unresolved = await executor.advance(input.id);
  assert.equal(unresolved.status, 'uncertain');
  assert.equal(unresolved.attempts[0]?.phase, 'submitted');
  await assert.rejects(executor.cancel(input.id), hasCode('unresolved_transaction'));
  await assert.rejects(executor.create({ ...input, id: 'adversarial_002',
    deadline: new Date(Date.parse(input.deadline) + 60000).toISOString() }), hasCode('active_intent'));
  assert.equal(venue.orders.length, 1);
  assert.equal(venue.broadcasts.length, 1);
  assert.equal(executor.journal.events(input.id).filter(event => event.type === 'deadline_expired').length, 0);
});

test('a receipt lookup error cannot authorize a replacement or another instruction', async (context) => {
  const { executor, venue, input } = await setup(context);
  await executor.create(input);
  venue.receiptError = new Error('RPC unavailable');
  const waiting = await executor.advance(input.id);
  assert.equal(waiting.status, 'confirming');
  await assert.rejects(executor.create({ ...input, id: 'adversarial_002' }), hasCode('active_intent'));
  assert.equal(venue.orders.length, 1);
  assert.equal(venue.broadcasts.length, 1);
});

test('receipt block hash must match a snapshot at the same block', async (context) => {
  const { executor, venue, input } = await setup(context);
  await executor.create(input);
  venue.confirm(100000n);
  venue.blockHash = hash(999n);
  const waiting = await executor.advance(input.id);
  assert.equal(waiting.status, 'confirming');
  assert.match(waiting.message, /block hash/i);
  const attempt = waiting.attempts[0];
  assert.equal(attempt?.phase, 'confirmed');
  if (attempt?.phase === 'confirmed') assert.equal(attempt.afterPosition, null);
  assert.equal(venue.orders.length, 1);
  assert.equal(venue.broadcasts.length, 1);

  venue.blockHash = hash(101n);
  const reconciled = await executor.advance(input.id);
  assert.equal(reconciled.status, 'completed');
  assert.equal(venue.snapshotMinimums.at(-1), 101n);
});

test('a stale post-receipt position cannot produce an IOC residual', async (context) => {
  const { executor, venue, input } = await setup(context);
  await executor.create(input);
  venue.confirm(40000n, 102n);
  venue.block = 101n;
  venue.blockHash = hash(101n);
  const waiting = await executor.advance(input.id);
  assert.equal(waiting.status, 'confirming');
  assert.match(waiting.message, /102.*101/);
  assert.equal(venue.orders.length, 1);

  venue.block = 102n; venue.blockHash = hash(102n);
  assert.equal((await executor.advance(input.id)).status, 'partial');
  assert.equal(venue.orders.length, 1);
});

for (const target of ['0.002', '-0.002']) {
  test(`pending buys and sells cannot net out before target ${target}`, async (context) => {
    const { executor, venue, input } = await setup(context);
    venue.pendingBuys = 900000n; venue.pendingSells = 900000n;
    const result = await executor.create({ ...input, target, limitPrice: target.startsWith('-') ? '99000' : input.limitPrice });
    assert.equal(result.status, 'paused');
    assert.equal(executor.journal.events(input.id).at(-1)?.type, 'risk_limit_blocked');
    assert.match(result.message, /0\.011 BTC/);
    assert.equal(venue.orders.length, 0);
    assert.equal(venue.broadcasts.length, 0);
  });
}

test('resting orders below the quantity cap still block this dedicated IOC executor', async (context) => {
  const { executor, venue, input } = await setup(context);
  venue.pendingBuys = 100n; venue.pendingSells = 100n;
  const result = await executor.create(input);
  assert.equal(result.status, 'paused');
  assert.equal(executor.journal.events(input.id).at(-1)?.type, 'external_orders_blocked');
  assert.equal(venue.orders.length, 0);
});

test('sub-lot precision is rejected before persistence or signing', async (context) => {
  const { executor, venue, input } = await setup(context);
  await assert.rejects(executor.create({ ...input, target: '0.000000001' }), hasCode('invalid_precision'));
  assert.equal(executor.journal.list().length, 0);
  assert.equal(venue.orders.length, 0);
});

test('deadline reached during signing persists the attempt but never starts a send', async (context) => {
  const { executor, venue, input, setTime } = await setup(context);
  venue.onPrepare = () => setTime(Date.parse(input.deadline));
  const result = await executor.create(input);
  assert.equal(result.status, 'expired');
  assert.equal(result.attempts[0]?.phase, 'signed');
  assert.equal(venue.broadcasts.length, 0);
  await executor.create(input);
  assert.equal(venue.orders.length, 1);
  assert.equal(venue.broadcasts.length, 0);
});

test('a non-finite snapshot timestamp fails closed', async (context) => {
  const { executor, venue, input } = await setup(context);
  venue.observedAt = Number.NaN;
  const result = await executor.create(input);
  assert.equal(result.status, 'paused');
  assert.equal(venue.orders.length, 0);
  assert.equal(venue.broadcasts.length, 0);
});

test('malformed serialized transaction bytes never reach broadcast', async (context) => {
  const { executor, venue, input } = await setup(context);
  venue.preparedBytes = '0x1';
  const result = await executor.create(input);
  assert.equal(result.status, 'paused');
  assert.equal(result.attempts.length, 0);
  assert.equal(venue.broadcasts.length, 0);
});

test('position drift while signing blocks the old quantity before send', async (context) => {
  const { executor, venue, input } = await setup(context);
  venue.onPrepare = () => { venue.position = 50000n; venue.block = 101n; venue.blockHash = hash(101n); };
  const result = await executor.create(input);
  assert.equal(result.status, 'paused');
  assert.equal(venue.broadcasts.length, 0);
});

test('a partial fill must retain its canonical receipt before preparing a residual', async (context) => {
  const { executor, venue, input } = await setup(context);
  venue.onBroadcast = () => venue.confirm(40000n);
  assert.equal((await executor.create(input)).status, 'partial');
  venue.receiptValue = { kind: 'unknown' };
  venue.block = 102n; venue.blockHash = hash(102n);
  const waiting = await executor.advance(input.id);
  assert.notEqual(waiting.status, 'partial');
  assert.notEqual(waiting.status, 'completed');
  assert.equal(venue.orders.length, 1);
  assert.equal(venue.broadcasts.length, 1);
});

test('exported evidence contains neither raw transaction bytes nor a private key field', async (context) => {
  const { executor, venue, input } = await setup(context);
  venue.preparedBytes = `0x${'f1'.repeat(48)}`;
  await executor.create(input);
  const evidence = JSON.stringify(executor.exportReceipt(input.id));
  assert.equal(evidence.includes(venue.preparedBytes), false);
  assert.equal(evidence.includes('serialized'), false);
  assert.equal(evidence.includes('privateKey'), false);
  assert.equal(JSON.parse(evidence).mode, 'simulation');
});

async function processExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    child.once('exit', () => resolveExit());
    child.once('error', reject);
  });
}

async function waitForMarker(child: ChildProcess, marker: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      const detail = existsSync(`${marker}.error`) ? readFileSync(`${marker}.error`, 'utf8') : '';
      throw new Error(`Executor subprocess exited before its crash point. ${detail}`);
    }
    if (Date.now() >= deadline) throw new Error('Executor subprocess did not reach its crash point.');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

for (const phase of ['after_sign', 'after_broadcast']) {
  test(`SIGKILL ${phase} recovers the persisted transaction without preparing another`, { timeout: 10000 }, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'perpops-crash-'));
    const path = join(directory, 'journal.sqlite');
    const exchangePath = join(directory, 'venue.sqlite');
    const marker = join(directory, 'crash-point');
    const input: IntentInput = {
      id: `process_${phase}`, target: '0.001', maxPosition: '0.002',
      limitPrice: '100100', deadline: new Date(Date.now() + 60000).toISOString(),
    };
    const script = `
      import { writeFileSync } from 'node:fs';
      import { Executor } from ${JSON.stringify(new URL('../src/executor.ts', import.meta.url).href)};
      import { SimulationAdapter } from ${JSON.stringify(new URL('../src/adapters/simulation.ts', import.meta.url).href)};
      const phase = ${JSON.stringify(phase)};
      const adapter = new SimulationAdapter(${JSON.stringify(exchangePath)});
      const snapshot = adapter.snapshot.bind(adapter);
      const broadcast = adapter.broadcast.bind(adapter);
      const stopped = new Promise(() => {});
      let snapshotCalls = 0;
      adapter.snapshot = async (minimum) => {
        const value = await snapshot(minimum);
        snapshotCalls += 1;
        if (phase === 'after_sign' && snapshotCalls === 2) {
          writeFileSync(${JSON.stringify(marker)}, 'signed');
          await stopped;
        }
        return value;
      };
      adapter.broadcast = async (transaction) => {
        await broadcast(transaction);
        if (phase === 'after_broadcast') {
          writeFileSync(${JSON.stringify(marker)}, 'filled');
          await stopped;
        }
      };
      const watchdog = setTimeout(() => process.exit(2), 20000);
      try {
        const executor = await Executor.open({ path: ${JSON.stringify(path)}, adapter });
        await executor.create(${JSON.stringify(input)});
        clearTimeout(watchdog);
        await executor.close();
        process.exit(3);
      } catch (error) {
        writeFileSync(${JSON.stringify(`${marker}.error`)}, error.message);
        process.exit(1);
      }
    `;
    const childEnvironment = { ...process.env };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: childEnvironment, stdio: 'ignore',
    });
    let recovered: Executor | null = null;
    context.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await processExit(child);
      await recovered?.close();
      rmSync(directory, { recursive: true, force: true });
    });
    await waitForMarker(child, marker);
    child.kill('SIGKILL');
    await processExit(child);
    assert.equal(child.signalCode, 'SIGKILL');

    const journal = new Journal(path);
    const before = journal.get(input.id);
    journal.close();
    assert.equal(before?.attempts.length, 1);
    const beforeAttempt = before?.attempts[0];
    assert.equal(beforeAttempt?.phase, phase === 'after_sign' ? 'signed' : 'submitted');

    const venue = new SimulationAdapter(exchangePath);
    recovered = await Executor.open({ path, adapter: venue });
    const result = await recovered.create(input);
    assert.equal(result.status, 'completed');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.hash, beforeAttempt?.hash);
    assert.equal(result.attempts[0]?.serialized, beforeAttempt?.serialized);
    assert.deepEqual(venue.counts(), { broadcasts: 1, executions: 1, prepared: 1 });
    assert.equal((await venue.snapshot()).position, 100000n);
  });
}
