import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createDreamdexAdapter } from './adapters/dreamdex.ts';
import { createRuntime } from './runtime.ts';
import { DomainError } from './types.ts';
import { publicErrorMessage } from './errors.ts';

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2)}\n`);
}

try {
  const command = process.argv[2] ?? 'help';
  if (command === 'wallet:create') {
    const key = generatePrivateKey();
    const account = privateKeyToAccount(key);
    const destination = resolve(process.argv[3] ?? '.env.testnet');
    writeFileSync(destination, `PERPOPS_MODE=dreamdex\nPERPOPS_PRIVATE_KEY=${key}\nPERPOPS_ACCOUNT=${account.address}\nPERPOPS_TESTNET_TRADING=0\n`, { flag: 'wx', mode: 0o600 });
    output({ account: account.address, configFile: destination, network: 50383, next: 'Fund this disposable account with test STT and paper USDso. Copy this config to .env and set PERPOPS_TESTNET_TRADING=1 only when ready. The private key is stored only in the config file.' });
  } else if (command === 'doctor') {
    const adapter = createDreamdexAdapter({
      ...(process.env.PERPOPS_ACCOUNT ? { account: process.env.PERPOPS_ACCOUNT } : {}),
      ...(process.env.PERPOPS_PRIVATE_KEY ? { privateKey: process.env.PERPOPS_PRIVATE_KEY } : {}),
      ...(process.env.PERPOPS_RPC_URL ? { rpcUrl: process.env.PERPOPS_RPC_URL } : {}),
      allowTrading: false,
    });
    output({ evidence: 'read-only live RPC checks; no transactions submitted', ...(await adapter.doctor()) });
  } else if (command === 'demo') {
    const directory = mkdtempSync(join(tmpdir(), 'perpops-demo-'));
    let runtime = await createRuntime({ mode: 'simulation', directory });
    if (!runtime.simulation) throw new Error('Simulation unavailable.');
    const request = { id: randomUUID(), target: '0.001', maxPosition: '0.002', limitPrice: '100100', deadline: new Date(Date.now() + 600_000).toISOString() };
    runtime.simulation.arm('drop_ack');
    const interrupted = await runtime.executor.create(request);
    const beforeHash = interrupted.attempts[0]?.hash;
    await runtime.executor.close();
    runtime = await createRuntime({ mode: 'simulation', directory });
    try {
      const recovered = await runtime.executor.create(request);
      const counts = runtime.simulation?.counts();
      if (recovered.status !== 'completed' || recovered.attempts.length !== 1 || recovered.attempts[0]?.hash !== beforeHash || counts?.executions !== 1) throw new Error('Recovery demonstration failed.');
      output({ evidence: 'local simulation, not an on-chain transaction', interruptedStatus: interrupted.status, recoveredStatus: recovered.status, sameTransaction: recovered.attempts[0]?.hash === beforeHash, counts, dataDirectory: directory, receipt: runtime.executor.exportReceipt(request.id) });
    } finally { await runtime.executor.close(); }
  } else if (command === 'execute' || command === 'resume' || command === 'rebroadcast' || command === 'receipt') {
    const argument = process.argv[3];
    if (!argument) throw new DomainError('missing_argument', `${command} requires an instruction JSON path or intent ID.`);
    const runtime = await createRuntime();
    try {
      if (command === 'execute') output(runtime.executor.view(await runtime.executor.create(JSON.parse(readFileSync(argument, 'utf8')))));
      else if (command === 'resume') output(runtime.executor.view(await runtime.executor.advance(argument)));
      else if (command === 'rebroadcast') output(runtime.executor.view(await runtime.executor.retryBroadcast(argument)));
      else output(runtime.executor.exportReceipt(argument));
    } finally { await runtime.executor.close(); }
  } else {
    output({ commands: ['npm start', 'npm run demo', 'npm run doctor', 'npm run wallet:create', 'node --env-file-if-exists=.env src/cli.ts execute instruction.json', 'node --env-file-if-exists=.env src/cli.ts resume INTENT_ID', 'node --env-file-if-exists=.env src/cli.ts rebroadcast INTENT_ID', 'node --env-file-if-exists=.env src/cli.ts receipt INTENT_ID'], note: 'The server and CLI share a writer lock. Stop the server before executing a CLI trade.' });
  }
} catch (error) { process.stderr.write(`${JSON.stringify({ error: publicErrorMessage(error) })}\n`); process.exitCode = 1; }
