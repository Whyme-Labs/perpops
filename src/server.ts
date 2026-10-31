import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { formatAmount, parseAmount } from './amounts.ts';
import { createRuntime } from './runtime.ts';
import type { Runtime } from './runtime.ts';
import { publicErrorMessage } from './errors.ts';
import { DomainError } from './types.ts';
import type { AccountSnapshot, Mode } from './types.ts';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const terminal = new Set(['completed', 'expired', 'failed', 'cancelled']);
const faultRequest = z.object({ fault: z.enum(['none', 'drop_ack', 'drop_before_send', 'stale_read', 'partial_fill', 'pending_receipt']) }).strict();

const safeMessage = publicErrorMessage;

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new DomainError('content_type', 'Send application/json.', 415);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 16_384) throw new DomainError('body_too_large', 'Request body exceeds 16 KiB.', 413);
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new DomainError('invalid_json', 'Request body is not valid JSON.'); }
}

function snapshotView(snapshot: AccountSnapshot, runtime: Runtime) {
  const market = runtime.executor.market;
  return {
    blockNumber: snapshot.blockNumber.toString(), blockHash: snapshot.blockHash, observedAt: snapshot.observedAt,
    position: formatAmount(snapshot.position, market.baseDecimals),
    pendingBuys: formatAmount(snapshot.pendingBuys, market.baseDecimals), pendingSells: formatAmount(snapshot.pendingSells, market.baseDecimals),
    markPrice: formatAmount(snapshot.markPrice, market.quoteDecimals),
    bestBid: snapshot.bestBid === null ? null : formatAmount(snapshot.bestBid, market.quoteDecimals),
    bestAsk: snapshot.bestAsk === null ? null : formatAmount(snapshot.bestAsk, market.quoteDecimals),
    collateral: formatAmount(snapshot.collateral, market.quoteDecimals),
  };
}

async function state(runtime: Runtime) {
  const { executor, simulation } = runtime;
  const market = executor.market;
  let account: ReturnType<typeof snapshotView> | null = null;
  let readiness: { status: 'ready' | 'read_only' | 'offline'; message: string };
  try {
    account = snapshotView(await executor.adapter.snapshot(), runtime);
    readiness = market.canTrade
      ? { status: 'ready', message: market.mode === 'simulation' ? 'Local exchange simulation. No real funds or chain transactions.' : 'Dedicated DreamDEX testnet account. Test funds only.' }
      : { status: 'read_only', message: 'Testnet reads are connected. A funded dedicated signer and PERPOPS_TESTNET_TRADING=1 are required to trade.' };
  } catch (error) { readiness = { status: 'offline', message: safeMessage(error) }; }
  const records = executor.journal.list();
  const intents = records.map(record => executor.view(record));
  const recovered = intents.filter(intent => intent.status === 'completed' && intent.events.some(event => event.type === 'broadcast_uncertain' || event.type === 'reconciliation_wait' || event.type === 'receipt_unknown')).length;
  return {
    mode: runtime.mode,
    market: { ...market, lotSize: formatAmount(market.lotSize, market.baseDecimals), minQuantity: formatAmount(market.minQuantity, market.baseDecimals), tickSize: formatAmount(market.tickSize, market.quoteDecimals) },
    account, readiness, activeIntentId: records.find(record => !terminal.has(record.status))?.input.id ?? null, intents,
    stats: { intentCount: records.length, completed: records.filter(record => record.status === 'completed').length, transactionCount: records.reduce((sum, record) => sum + record.attempts.length, 0), recovered },
    fault: { armed: simulation?.armedFault() ?? 'none' }, now: Date.now(),
  };
}

function guardRequest(request: IncomingMessage): void {
  const host = request.headers.host;
  if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new DomainError('host_rejected', 'This workbench accepts loopback requests only.', 403);
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) throw new DomainError('origin_rejected', 'Cross-origin requests are not accepted.', 403);
  if (request.method === 'POST' && request.headers['x-perpops-client'] !== 'workbench') throw new DomainError('client_header', 'Missing X-PerpOps-Client header.', 403);
}

export async function startServer(options: { mode?: Mode; directory?: string; port?: number } = {}) {
  const runtime = await createRuntime(options);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    try {
      guardRequest(request);
      const url = new URL(request.url ?? '/', `http://${request.headers.host}`);
      const path = url.pathname;
      const method = request.method;
      const { executor, simulation } = runtime;
      if (method === 'GET' && path === '/api/state') return json(response, 200, await state(runtime));
      if (method === 'GET' && path === '/api/health') return json(response, 200, { status: 'ok', mode: runtime.mode, network: executor.market.chainId });
      if (method === 'POST' && path === '/api/intents') {
        const record = await executor.create(await body(request));
        return json(response, 200, { intent: executor.view(record) });
      }
      const intentRoute = /^\/api\/intents\/([a-zA-Z0-9_-]+)\/(resume|rebroadcast|cancel|receipt)$/.exec(path);
      if (intentRoute) {
        const id = intentRoute[1];
        const action = intentRoute[2];
        if (!id) throw new DomainError('not_found', 'Instruction not found.', 404);
        if (method === 'GET' && action === 'receipt') {
          response.setHeader('Content-Disposition', `attachment; filename="perpops-${id}.json"`);
          return json(response, 200, executor.exportReceipt(id));
        }
        if (method === 'POST' && (action === 'resume' || action === 'rebroadcast' || action === 'cancel')) {
          await body(request);
          const record = action === 'resume' ? await executor.advance(id)
            : action === 'rebroadcast' ? await executor.retryBroadcast(id) : await executor.cancel(id);
          return json(response, 200, { intent: executor.view(record) });
        }
      }
      if (method === 'POST' && path === '/api/recover') {
        await body(request);
        const records = executor.journal.list().filter(record => !terminal.has(record.status));
        const recovered = [];
        for (const record of records) recovered.push(executor.view(await executor.advance(record.input.id)));
        return json(response, 200, { intents: recovered });
      }
      if (method === 'POST' && (path === '/api/fault' || path === '/api/demo' || path === '/api/simulation/settle')) {
        if (!simulation) throw new DomainError('simulation_only', 'Fault controls are available only in local simulation.', 403);
        const input = await body(request);
        if (path === '/api/fault') {
          const parsed = faultRequest.safeParse(input);
          if (!parsed.success) throw new DomainError('invalid_fault', 'Choose a supported simulation fault.');
          simulation.arm(parsed.data.fault);
          return json(response, 200, { fault: { armed: simulation.armedFault() } });
        }
        if (path === '/api/simulation/settle') { simulation.settle(); return json(response, 200, { released: true }); }
        if (executor.journal.list().some(record => !terminal.has(record.status))) throw new DomainError('active_intent', 'Resolve the active instruction before running another demo.', 409);
        const account = await simulation.snapshot();
        const opening = account.position === 0n;
        simulation.settle(); simulation.arm('drop_ack');
        const record = await executor.create({ id: randomUUID(), target: opening ? '0.001' : '0', maxPosition: '0.002', limitPrice: opening || account.position < 0n ? '100100' : '99900', deadline: new Date(Date.now() + 600_000).toISOString() });
        return json(response, 200, { intent: executor.view(record) });
      }
      if (method === 'GET') {
        const asset = path === '/' ? 'index.html' : path === '/app.js' ? 'app.js' : path === '/styles.css' ? 'styles.css' : null;
        if (asset) {
          const content = await readFile(join(publicDirectory, asset));
          const type = asset.endsWith('.html') ? 'text/html' : asset.endsWith('.css') ? 'text/css' : 'text/javascript';
          response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' }); response.end(content); return;
        }
      }
      throw new DomainError('not_found', 'Route not found.', 404);
    } catch (error) {
      const known = error instanceof DomainError;
      json(response, known ? error.statusCode : 500, { error: { code: known ? error.code : 'internal_error', message: safeMessage(error) } });
    }
  });
  const port = options.port ?? Number(process.env.PERPOPS_PORT ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) { await runtime.executor.close(); throw new DomainError('invalid_port', 'Invalid HTTP port.'); }
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) { await runtime.executor.close(); throw error; }
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing local server address.');
  return {
    server, runtime, url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
      await runtime.executor.close();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const app = await startServer();
    process.stdout.write(`${JSON.stringify({ event: 'perpops_ready', url: app.url, mode: app.runtime.mode })}\n`);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await app.close(); process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { process.stderr.write(`${safeMessage(error)}\n`); process.exitCode = 1; }
}
