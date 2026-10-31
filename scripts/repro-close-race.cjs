#!/usr/bin/env node
// An offline correctness reproduction. No wallet, RPC, signer or broadcast.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const sdk = require('@somnia-chain/markets-sdk');
const viem = require('viem');

const root = resolve(__dirname, '..');
const fixtures = resolve(root, 'feedback/upstream');
const provenance = JSON.parse(readFileSync(resolve(fixtures, 'provenance.json'), 'utf8'));
for (const [file, expected] of Object.entries(provenance.files)) {
  const actual = createHash('sha256').update(readFileSync(resolve(fixtures, file))).digest('hex');
  assert.equal(actual, expected.sha256, `Pinned upstream file changed: ${file}`);
}

const logs = [];
const loaded = new Map();
function forbidden() { throw new Error('This offline fixture does not support network, signing, configuration or operator writes.'); }
function load(file) {
  if (loaded.has(file)) return loaded.get(file).exports;
  const source = readFileSync(resolve(fixtures, file), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  loaded.set(file, module);
  const dependencies = name => {
    if (name === '@somnia-chain/markets-sdk') return sdk;
    if (name === 'viem') return viem;
    if (name === './markets.js') return load('markets.ts');
    if (name === './exchange.js') return load('exchange.ts');
    if (name === './operator.js') return { placeFor: forbidden, cancelFor: forbidden, createTradingKey: forbidden, linkProblem: forbidden, linkStatus: forbidden };
    if (name === './config.js') return { loadConfig: forbidden, loadEnv: forbidden, makeChain: forbidden };
    throw new Error(`Unexpected upstream dependency: ${name}`);
  };
  runInNewContext(compiled, {
    module, exports: module.exports, require: dependencies,
    console: { log: (...items) => logs.push(items.join(' ')) },
  }, { filename: provenance.files[file].path, timeout: 2_000 });
  return module.exports;
}

const { closePosition } = load('orders.ts');
const market = {
  symbol: 'BTC/USDso:USDso', display: 'BTC-PERP',
  info: {
    poolAddress: '0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0',
    marginBank: '0x478769E1177C0773c43A593DCCc4Ad15F15F1394',
    baseSymbol: 'BTC', baseDecimals: 8, quoteDecimals: 18,
    lotSize: '1000', minQuantity: '13000', tickSize: '100000000000000000',
  },
};
const account = '0x0000000000000000000000000000000000000001';
const cases = [
  { name: 'unchanged long control', preview: 100_000n, current: 100_000n, fraction: 1, expectedAfter: 0n, expectedQuantity: 100_000n },
  { name: 'long reduced between reads', preview: 100_000n, current: 40_000n, fraction: 1, expectedAfter: -60_000n, expectedQuantity: 100_000n },
  { name: 'unchanged short control', preview: 100_000n, current: -100_000n, fraction: 1, expectedAfter: 0n, expectedQuantity: 100_000n },
  { name: 'short reduced between reads', preview: 100_000n, current: -40_000n, fraction: 1, expectedAfter: 60_000n, expectedQuantity: 100_000n },
  { name: 'partial close after reduction', preview: 100_000n, current: 40_000n, fraction: 0.5, expectedAfter: -10_000n, expectedQuantity: 50_000n },
  { name: 'position increased control', preview: 100_000n, current: 120_000n, fraction: 1, expectedAfter: 20_000n, expectedQuantity: 100_000n },
  { name: 'already flat control', preview: 100_000n, current: 0n, fraction: 1, expectedAfter: 0n, expectedQuantity: 0n },
];

async function run() {
  const results = [];
  for (const scenario of cases) {
    const calls = [];
    let modeledPosition = scenario.current;
    let order;
    const exchange = {
      client: {
        async previewPerpClosePnl() { calls.push('preview'); return { priceable: true, closedQuantity: scenario.preview }; },
      },
      async fetchPositions() {
        calls.push('positions');
        return scenario.current === 0n ? [] : [{
          symbol: market.symbol, chainId: 50383, side: scenario.current > 0n ? 'long' : 'short',
          contracts: Number(scenario.current < 0n ? -scenario.current : scenario.current) / 1e8,
          info: { position: { size: scenario.current } },
        }];
      },
      async fetchOrderBook() { calls.push('book'); return { bids: [[100_000, 1]], asks: [[100_010, 1]] }; },
      trader: {
        async placePerpOrder(input) {
          calls.push('captured-order');
          order = input;
          // A full-fill arithmetic model, not an exchange or chain execution.
          modeledPosition += input.isBid ? input.quantity : -input.quantity;
          return { receipt: { status: 'success' }, fills: [{ quantityFilled: input.quantity }], orderId: 1n };
        },
      },
    };
    const outcome = await closePosition({ exchange, config: { dryRun: false } }, market, account, { fraction: scenario.fraction });
    assert.equal(order?.quantity ?? 0n, scenario.expectedQuantity, scenario.name);
    assert.equal(modeledPosition, scenario.expectedAfter, scenario.name);
    assert.equal(outcome.sent, scenario.expectedQuantity > 0n, scenario.name);
    if (order) {
      assert.equal(order.orderType, sdk.ORDER_TYPE.MARKET);
      assert.equal(order.isBid, scenario.current < 0n);
      assert.equal(order.reduceOnly, undefined);
      assert.deepEqual(calls, ['preview', 'positions', 'book', 'captured-order']);
    } else assert.deepEqual(calls, ['preview', 'positions']);
    const crossedZero = scenario.current * modeledPosition < 0n;
    results.push({
      scenario: scenario.name, previewQuantityRaw: scenario.preview.toString(),
      currentPositionRaw: scenario.current.toString(), fraction: scenario.fraction,
      capturedQuantityRaw: (order?.quantity ?? 0n).toString(),
      capturedSide: order ? (order.isBid ? 'buy' : 'sell') : null,
      modeledFullFillPositionRaw: modeledPosition.toString(), crossedZero, calls,
    });
  }
  assert.equal(results.filter(row => row.crossedZero).length, 3);
  const report = {
    schemaVersion: 1, evidence: 'Offline invocation of the actual pinned upstream closePosition and placePerp helpers. No network calls or transactions.',
    upstreamRevision: provenance.revision, verifiedSourceSha256: Object.fromEntries(Object.entries(provenance.files).map(([file, item]) => [file, item.sha256])),
    sdkVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/@somnia-chain/markets-sdk/package.json'), 'utf8')).version,
    nodeVersion: process.version, baseDecimals: 8, assertionsPassed: true,
    scenarios: results,
    limitation: 'Only the captured order parameters are observed from upstream code. Resulting positions assume full fill, sufficient margin/liquidity and no further state change; no on-chain reversal or financial loss is claimed.',
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) {
    const filename = process.argv[outputIndex + 1];
    if (!filename) throw new Error('--output requires a file path');
    const destination = resolve(filename);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, json);
  }
  process.stdout.write(json);
}
run().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
