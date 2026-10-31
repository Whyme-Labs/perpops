import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Executor } from '../src/executor.ts';
import { SimulationAdapter } from '../src/adapters/simulation.ts';
import type { ExchangeAdapter, TransactionReceipt } from '../src/types.ts';

async function fixture() {
  let now = Date.now();
  const directory = mkdtempSync(join(tmpdir(), 'perpops-rebroadcast-'));
  const path = join(directory, 'journal.sqlite');
  const exchangePath = join(directory, 'exchange.sqlite');
  let adapter = new SimulationAdapter(exchangePath, () => now);
  let executor = await Executor.open({ path, adapter, now: () => now });
  const input = { id: 'rebroadcast-intent', target: '0.001', maxPosition: '0.002', limitPrice: '100100', deadline: new Date(now + 60_000).toISOString() };
  return {
    input, get adapter() { return adapter; }, get executor() { return executor; },
    elapse(milliseconds: number) { now += milliseconds; },
    async restart(readOnly = false) {
      await executor.close();
      adapter = new SimulationAdapter(exchangePath, () => now);
      const wrapped: ExchangeAdapter = {
        describe: async () => ({ ...await adapter.describe(), canTrade: !readOnly }),
        snapshot: minimum => adapter.snapshot(minimum),
        prepareOrder: order => adapter.prepareOrder(order),
        broadcast: transaction => adapter.broadcast(transaction),
        receipt: hash => adapter.receipt(hash), close: () => adapter.close(),
      };
      executor = await Executor.open({ path, adapter: wrapped, now: () => now });
    },
    async close() { await executor.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('an interrupted unsent transaction can be explicitly rebroadcast after restart with identical bytes and nonce', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('drop_before_send');
    const first = await f.executor.create(f.input);
    assert.equal(first.status, 'uncertain');
    const original = first.attempts[0];
    assert.ok(original);
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 1, executions: 0 });
    await f.restart();
    assert.equal((await f.executor.advance(f.input.id)).status, 'uncertain');
    const result = await f.executor.retryBroadcast(f.input.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0]?.hash, original.hash);
    assert.equal(result.attempts[0]?.serialized, original.serialized);
    assert.equal(result.attempts[0]?.nonce, original.nonce);
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 2, executions: 1 });
  } finally { await f.close(); }
});

test('rebroadcast reconciles an existing canonical receipt without sending again', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('drop_ack');
    await f.executor.create(f.input);
    assert.equal((await f.executor.retryBroadcast(f.input.id)).status, 'completed');
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 1, executions: 1 });
  } finally { await f.close(); }
});

test('unknown receipt plus changed position prevents rebroadcast and keeps the instruction unresolved', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('pending_receipt');
    await f.executor.create(f.input);
    assert.equal((await f.executor.retryBroadcast(f.input.id)).status, 'uncertain');
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 1, executions: 1 });
    await assert.rejects(() => f.executor.cancel(f.input.id), { code: 'unresolved_transaction' });
    f.adapter.settle();
    assert.equal((await f.executor.advance(f.input.id)).status, 'completed');
  } finally { await f.close(); }
});

test('an expired unknown transaction is retained and cannot be rebroadcast or cancelled', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('drop_before_send');
    await f.executor.create(f.input);
    f.elapse(60_001);
    assert.equal((await f.executor.retryBroadcast(f.input.id)).status, 'uncertain');
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 1, executions: 0 });
    await assert.rejects(() => f.executor.cancel(f.input.id), { code: 'unresolved_transaction' });
    await assert.rejects(() => f.executor.create({ ...f.input, id: 'competing-intent', deadline: new Date(Date.now() + 600_000).toISOString() }), { code: 'active_intent' });
  } finally { await f.close(); }
});

test('read-only recovery cannot rebroadcast, and enabling trading resumes the same transaction', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('drop_before_send');
    const first = await f.executor.create(f.input);
    await f.restart(true);
    assert.equal((await f.executor.retryBroadcast(f.input.id)).status, 'uncertain');
    assert.equal(f.adapter.counts().broadcasts, 1);
    await f.restart(false);
    const result = await f.executor.retryBroadcast(f.input.id);
    assert.equal(result.status, 'completed');
    assert.equal(result.attempts[0]?.hash, first.attempts[0]?.hash);
  } finally { await f.close(); }
});

test('a receipt transport error cannot authorize rebroadcast or leak provider credentials', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('drop_before_send');
    await f.executor.create(f.input);
    f.adapter.receipt = async () => { throw new Error('https://rpc.example/?secret=never-export-this'); };
    assert.equal((await f.executor.retryBroadcast(f.input.id)).status, 'uncertain');
    assert.equal(f.adapter.counts().broadcasts, 1);
    assert.ok(!JSON.stringify(f.executor.exportReceipt(f.input.id)).includes('never-export-this'));
  } finally { await f.close(); }
});

test('concurrent explicit retries retain one attempt and execute it once', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('drop_before_send');
    await f.executor.create(f.input);
    const results = await Promise.all(Array.from({ length: 5 }, () => f.executor.retryBroadcast(f.input.id)));
    assert.ok(results.every(result => result.status === 'completed' && result.attempts.length === 1));
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 2, executions: 1 });
  } finally { await f.close(); }
});

test('rebroadcast never prepares the remainder of a confirmed partial fill', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('partial_fill');
    await f.executor.create(f.input);
    assert.equal((await f.executor.retryBroadcast(f.input.id)).status, 'partial');
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 1, executions: 1 });
  } finally { await f.close(); }
});

test('a missing or changed partial-fill receipt preserves confirmed evidence and blocks rebroadcast', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('partial_fill');
    const first = await f.executor.create(f.input);
    assert.equal(first.status, 'partial');
    const original = first.attempts[0];
    assert.ok(original && original.phase === 'confirmed');
    const receipts: TransactionReceipt[] = [
      { kind: 'unknown' },
      { kind: 'confirmed', blockNumber: BigInt(original.receipt.blockNumber) + 1n,
        blockHash: original.receipt.blockHash, success: original.receipt.success },
      { kind: 'confirmed', blockNumber: BigInt(original.receipt.blockNumber),
        blockHash: `0x${'ff'.repeat(32)}`, success: original.receipt.success },
    ];
    for (const receipt of receipts) {
      f.adapter.receipt = async () => receipt;
      const result = await f.executor.retryBroadcast(f.input.id);
      assert.equal(result.status, 'uncertain');
      assert.deepEqual(result.attempts, [original]);
      assert.deepEqual(f.executor.require(f.input.id).attempts, [original]);
      assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 1, executions: 1 });
      await assert.rejects(() => f.executor.cancel(f.input.id), { code: 'unresolved_transaction' });
    }
  } finally { await f.close(); }
});

test('a deadline passing during the rebroadcast snapshot prevents sending and keeps the saved attempt unresolved', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('drop_before_send');
    const first = await f.executor.create(f.input);
    const original = first.attempts[0];
    assert.ok(original && original.phase === 'submitted');
    f.elapse(59_999);
    const snapshot = f.adapter.snapshot.bind(f.adapter);
    let snapshotReads = 0;
    f.adapter.snapshot = async minimum => {
      snapshotReads += 1;
      const current = await snapshot(minimum);
      f.elapse(2);
      return current;
    };
    const result = await f.executor.retryBroadcast(f.input.id);
    assert.equal(snapshotReads, 1);
    assert.equal(result.status, 'uncertain');
    assert.deepEqual(result.attempts, [original]);
    assert.deepEqual(f.executor.require(f.input.id).attempts, [original]);
    assert.deepEqual(f.adapter.counts(), { prepared: 1, broadcasts: 1, executions: 0 });
    await assert.rejects(() => f.executor.cancel(f.input.id), { code: 'unresolved_transaction' });
  } finally { await f.close(); }
});
