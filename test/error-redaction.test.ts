import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HttpRequestError } from 'viem';
import { createRuntime } from '../src/runtime.ts';
import { startServer } from '../src/server.ts';

const pathCredential = 'FAKE_RPC_PATH_CREDENTIAL_71528';
const queryCredential = 'FAKE_RPC_QUERY_CREDENTIAL_39264';
const rpcUrl = `https://rpc.example.invalid/v2/${pathCredential}?apikey=${queryCredential}`;

function transportError(): HttpRequestError {
  const error = new HttpRequestError({ url: rpcUrl, status: 503 });
  // Use the real dependency's error format, and prove the fixture contains secrets.
  assert.ok(error.message.includes(pathCredential));
  assert.ok(error.message.includes(queryCredential));
  return error;
}

function assertRedacted(text: string): void {
  for (const secret of [pathCredential, queryCredential, rpcUrl]) {
    assert.equal(text.includes(secret), false, 'A transport credential crossed the public error boundary.');
  }
}

for (const failure of ['snapshot', 'receipt'] as const) {
  test(`${failure} transport errors cannot leak RPC credentials into journal events or exported receipts`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'perpops-redaction-'));
    const runtime = await createRuntime({ mode: 'simulation', directory });
    try {
      const simulation = runtime.simulation;
      assert.ok(simulation);
      const error = transportError();
      if (failure === 'snapshot') simulation.snapshot = async () => { throw error; };
      else simulation.receipt = async () => { throw error; };

      const input = {
        id: `redaction_${failure}`, target: '0.001', maxPosition: '0.002',
        limitPrice: '100100', deadline: new Date(Date.now() + 60000).toISOString(),
      };
      const record = await runtime.executor.create(input);
      assert.equal(record.status, failure === 'snapshot' ? 'paused' : 'confirming');
      const events = runtime.executor.journal.events(input.id);
      assert.equal(events.at(-1)?.message, record.message);
      assert.ok(record.message.length > 0);
      assertRedacted(JSON.stringify(runtime.executor.journal.get(input.id)));
      assertRedacted(JSON.stringify(events));
      assertRedacted(JSON.stringify(runtime.executor.exportReceipt(input.id)));
    } finally {
      await runtime.executor.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('HTTP offline state and unexpected-error responses redact credentialized RPC URLs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-http-redaction-'));
  const app = await startServer({ mode: 'simulation', directory, port: 0 });
  try {
    const simulation = app.runtime.simulation;
    assert.ok(simulation);
    const error = transportError();
    simulation.snapshot = async () => { throw error; };

    const state = await fetch(`${app.url}/api/state`);
    assert.equal(state.status, 200);
    const stateText = await state.text();
    assert.match(stateText, /"status":"offline"/);
    assertRedacted(stateText);

    // The demo reads the same failing adapter directly, exercising the route catch.
    const failed = await fetch(`${app.url}/api/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PerpOps-Client': 'workbench' },
      body: '{}',
    });
    assert.equal(failed.status, 500);
    const failedText = await failed.text();
    assert.match(failedText, /"code":"internal_error"/);
    assertRedacted(failedText);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
