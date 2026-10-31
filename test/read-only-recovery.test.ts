import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor } from '../src/executor.ts';
import { SimulationAdapter } from '../src/adapters/simulation.ts';
import type { IntentRecord } from '../src/journal.ts';
import type { ExchangeAdapter, IntentInput } from '../src/types.ts';

test('a signed attempt survives a read-only restart and resumes its original bytes after trading is enabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-read-only-recovery-'));
  const journalPath = join(directory, 'journal.sqlite');
  const exchangePath = join(directory, 'exchange.sqlite');
  let executor: Executor | undefined;
  try {
    const initialAdapter = new SimulationAdapter(exchangePath);
    executor = await Executor.open({ path: journalPath, adapter: initialAdapter });
    const input: IntentInput = {
      id: 'prepared-read-only-restart', target: '0.001', maxPosition: '0.002',
      limitPrice: '100100', deadline: new Date(Date.now() + 600_000).toISOString(),
    };
    const before = await initialAdapter.snapshot();
    const prepared = await initialAdapter.prepareOrder({
      side: 'buy', quantity: 100_000n, limitPrice: 100_100n * 10n ** 18n,
      reduceOnly: false, deadline: Date.parse(input.deadline),
    });
    // This is the durable state left by a crash after preparation, before send-start.
    const record: IntentRecord = {
      input, fingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      createdAt: Date.now(), updatedAt: Date.now(), status: 'prepared', message: 'Prepared before restart.',
      attempts: [{
        number: 1, hash: prepared.hash, serialized: prepared.serialized, nonce: prepared.nonce,
        side: 'buy', quantity: '100000', limitPrice: String(100_100n * 10n ** 18n),
        reduceOnly: false, beforePosition: before.position.toString(),
        beforeBlock: before.blockNumber.toString(), phase: 'signed',
      }],
    };
    executor.journal.save(record, 'transaction_prepared', record.message);
    await executor.close();
    executor = undefined;

    const readOnlyExchange = new SimulationAdapter(exchangePath);
    let readOnlyBroadcastCalls = 0;
    const readOnlyAdapter: ExchangeAdapter = {
      describe: async () => ({ ...await readOnlyExchange.describe(), canTrade: false }),
      snapshot: minimum => readOnlyExchange.snapshot(minimum),
      receipt: hash => readOnlyExchange.receipt(hash),
      prepareOrder: async () => { throw new Error('Read-only recovery must not prepare another transaction.'); },
      broadcast: async () => {
        readOnlyBroadcastCalls += 1;
        throw new Error('Read-only recovery must not call broadcast.');
      },
      close: () => readOnlyExchange.close(),
    };
    executor = await Executor.open({ path: journalPath, adapter: readOnlyAdapter });
    const paused = await executor.advance(input.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.attempts.length, 1);
    assert.equal(paused.attempts[0]?.phase, 'signed');
    assert.equal(paused.attempts[0]?.hash, prepared.hash);
    assert.equal(paused.attempts[0]?.serialized, prepared.serialized);
    assert.equal(readOnlyBroadcastCalls, 0);
    assert.equal(executor.journal.events(input.id).filter(event => event.type === 'send_started').length, 0);
    assert.deepEqual(readOnlyExchange.counts(), { prepared: 1, broadcasts: 0, executions: 0 });
    await executor.close();
    executor = undefined;

    const enabledExchange = new SimulationAdapter(exchangePath);
    executor = await Executor.open({ path: journalPath, adapter: enabledExchange });
    const recovered = await executor.advance(input.id);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.attempts.length, 1);
    assert.equal(recovered.attempts[0]?.hash, prepared.hash);
    assert.equal(recovered.attempts[0]?.serialized, prepared.serialized);
    assert.equal(recovered.attempts[0]?.nonce, prepared.nonce);
    assert.deepEqual(enabledExchange.counts(), { prepared: 1, broadcasts: 1, executions: 1 });
    assert.equal((await enabledExchange.snapshot()).position, 100_000n);
  } finally {
    await executor?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
