import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor } from '../src/executor.ts';
import { SimulationAdapter } from '../src/adapters/simulation.ts';

function request(id = 'intent-12345678') {
  return { id, target: '0.001', maxPosition: '0.002', limitPrice: '100100', deadline: new Date(Date.now() + 600_000).toISOString() };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-recovery-'));
  const path = join(directory, 'journal.sqlite');
  const exchangePath = join(directory, 'exchange.sqlite');
  const adapter = new SimulationAdapter(exchangePath);
  const executor = await Executor.open({ path, adapter });
  return { directory, path, exchangePath, adapter, executor, async cleanup() { await executor.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('same ID survives a lost acknowledgement and an actual database reopen without another trade', async () => {
  const f = await fixture();
  const input = request();
  f.adapter.arm('drop_ack');
  const interrupted = await f.executor.create(input);
  assert.equal(interrupted.status, 'uncertain');
  assert.equal((await f.adapter.snapshot()).position, 100_000n);
  const hash = interrupted.attempts[0]?.hash;
  await f.executor.close();
  const reopenedAdapter = new SimulationAdapter(f.exchangePath);
  const reopened = await Executor.open({ path: f.path, adapter: reopenedAdapter });
  try {
    const recovered = await reopened.create(input);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.attempts.length, 1);
    assert.equal(recovered.attempts[0]?.hash, hash);
    assert.deepEqual(reopenedAdapter.counts(), { broadcasts: 1, executions: 1, prepared: 1 });
    assert.equal((await reopenedAdapter.snapshot()).position, 100_000n);
    const exported = JSON.stringify(reopened.exportReceipt(input.id));
    assert.ok(!exported.includes('serialized'));
    assert.ok(!exported.includes(interrupted.attempts[0]?.serialized ?? 'MISSING'));
    await assert.rejects(() => reopened.create({ ...input, target: '0.002' }), { code: 'id_conflict' });
  } finally { await reopened.close(); rmSync(f.directory, { recursive: true, force: true }); }
});

test('partial IOC reconciliation prepares only the remaining quantity', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('partial_fill');
    const first = await f.executor.create(request());
    assert.equal(first.status, 'partial');
    assert.equal((await f.adapter.snapshot()).position, 50_000n);
    const second = await f.executor.advance(first.input.id);
    assert.equal(second.status, 'completed');
    assert.equal(second.attempts[1]?.quantity, '50000');
    assert.equal((await f.adapter.snapshot()).position, 100_000n);
  } finally { await f.cleanup(); }
});

test('stale account state after a confirmed receipt blocks every replacement order', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('stale_read');
    const first = await f.executor.create(request());
    assert.equal(first.status, 'confirming');
    for (let i = 0; i < 3; i++) assert.equal((await f.executor.advance(first.input.id)).status, 'confirming');
    assert.equal(f.adapter.counts().prepared, 1);
    f.adapter.settle();
    assert.equal((await f.executor.advance(first.input.id)).status, 'completed');
    assert.equal(f.adapter.counts().executions, 1);
  } finally { await f.cleanup(); }
});

test('unknown receipt blocks competing instructions and cancellation', async () => {
  const f = await fixture();
  try {
    f.adapter.arm('pending_receipt');
    const first = await f.executor.create(request());
    assert.equal(first.status, 'uncertain');
    await assert.rejects(() => f.executor.create(request('another-intent')), { code: 'active_intent' });
    await assert.rejects(() => f.executor.cancel(first.input.id), { code: 'unresolved_transaction' });
    for (let i = 0; i < 3; i++) await f.executor.advance(first.input.id);
    assert.equal(f.adapter.counts().prepared, 1);
    f.adapter.settle();
    assert.equal((await f.executor.advance(first.input.id)).status, 'completed');
  } finally { await f.cleanup(); }
});

test('concurrent replays of one request produce one fill', async () => {
  const f = await fixture();
  try {
    const input = request();
    const results = await Promise.all(Array.from({ length: 12 }, () => f.executor.create(input)));
    assert.ok(results.every(result => result.status === 'completed'));
    assert.equal(f.adapter.counts().executions, 1);
  } finally { await f.cleanup(); }
});

test('closing is a separate intent and preserves the previous receipt', async () => {
  const f = await fixture();
  try {
    await f.executor.create(request());
    const closed = await f.executor.create({ ...request('close-12345678'), target: '0', limitPrice: '99900' });
    assert.equal(closed.status, 'completed');
    assert.equal(closed.attempts[0]?.reduceOnly, true);
    assert.equal((await f.adapter.snapshot()).position, 0n);
    assert.equal(f.executor.journal.list().length, 2);
  } finally { await f.cleanup(); }
});
