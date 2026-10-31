import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.ts';

test('HTTP workbench completes a real local recovery flow and rejects cross-origin writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'perpops-http-'));
  const app = await startServer({ mode: 'simulation', directory, port: 0 });
  const post = (path: string, data: unknown = {}) => fetch(`${app.url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PerpOps-Client': 'workbench' }, body: JSON.stringify(data) });
  try {
    const page = await fetch(app.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /PerpOps/);
    const forbidden = await fetch(`${app.url}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PerpOps-Client': 'workbench', Origin: 'https://unrelated.invalid' }, body: '{}' });
    assert.equal(forbidden.status, 403);
    assert.equal((await fetch(`${app.url}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const demo = await post('/api/demo');
    assert.equal(demo.status, 200);
    const data: unknown = await demo.json();
    assert.ok(data && typeof data === 'object' && 'intent' in data);
    const intent = data.intent;
    assert.ok(intent && typeof intent === 'object' && 'id' in intent && typeof intent.id === 'string' && 'status' in intent);
    assert.equal(intent.status, 'uncertain');
    assert.equal((await post(`/api/intents/${intent.id}/resume`)).status, 200);
    const receiptResponse = await fetch(`${app.url}/api/intents/${intent.id}/receipt`);
    const receiptText = await receiptResponse.text();
    assert.match(receiptText, /"status":"completed"/);
    assert.match(receiptText, /"mode":"simulation"/);
    assert.doesNotMatch(receiptText, /serialized|PRIVATE_KEY/);
    assert.equal((await post('/api/intents', { id: 'bad' })).status, 400);
    assert.equal((await fetch(`${app.url}/.env`)).status, 404);
  } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
});
