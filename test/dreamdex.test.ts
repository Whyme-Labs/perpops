import assert from 'node:assert/strict';
import test from 'node:test';
import { SOMNIA_HIDEKI_TESTNET_ADDRESSES, perpPoolWriteAbi } from '@somnia-chain/markets-sdk';
import {
  custom, decodeFunctionData, encodeFunctionResult, erc20Abi, isHex, keccak256,
  parseTransaction, recoverTransactionAddress, serializeTransaction, toHex, zeroAddress,
  type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createDreamdexAdapter, dreamdexReadAbi, encodeDreamdexIoc } from '../src/adapters/dreamdex.ts';
import { DomainError, type OrderRequest } from '../src/types.ts';

// Public test vector. This key never connects to a real RPC or holds user funds.
const KEY = '0x0000000000000000000000000000000000000000000000000000000000000001';
const OWNER = privateKeyToAccount(KEY).address;
function fixtureAddress(value: Address | undefined): Address {
  assert.ok(value);
  return value;
}
const BANK = fixtureAddress(SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank);
const FACTORY = fixtureAddress(SOMNIA_HIDEKI_TESTNET_ADDRESSES.perpPoolFactory);
const POOL = '0x1111111111111111111111111111111111111111';
const BASE = '0x2222222222222222222222222222222222222222';
const COLLATERAL = '0x3333333333333333333333333333333333333333';
const OTHER_POOL = '0x4444444444444444444444444444444444444444';
const OTHER_BASE = '0x5555555555555555555555555555555555555555';
const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const OTHER_HASH = `0x${'cd'.repeat(32)}`;
const TX_HASH = `0x${'ef'.repeat(32)}`;
const grid = { lotSize: 1_000n, minQuantity: 13_000n, tickSize: 10n ** 17n };
const rpcAbi = [...dreamdexReadAbi, ...erc20Abi, ...perpPoolWriteAbi];

function request(overrides: Partial<OrderRequest> = {}): OrderRequest {
  return { side: 'buy', quantity: 13_000n, limitPrice: 80_000n * 10n ** 18n,
    reduceOnly: false, deadline: Date.now() + 60_000, ...overrides };
}

function errorCode(code: string) {
  return (error: unknown) => error instanceof DomainError && error.code === code;
}

interface FixtureOptions {
  chainId?: number;
  networkId?: string;
  staleMark?: boolean;
  pending?: boolean;
  otherMarketOrders?: boolean;
  receipt?: 'missing' | 'confirmed' | 'failed' | 'rpc-error' | 'wrong-hash' | 'reorg';
  latestBlock?: bigint;
  failBroadcast?: boolean;
  pendingNonce?: boolean;
}

function rpcFixture(options: FixtureOptions = {}) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const signed: Hex[] = [];
  const timestamp = BigInt(Math.floor(Date.now() / 1000));
  const openOrder = (id: bigint, isBid: boolean, quantityRemaining: bigint) => ({
    orderId: id, isBid, owner: OWNER, userData: 0n, price: 80_000n * 10n ** 18n,
    fullQuantity: 90_000n, quantityRemaining, expireTimestampNs: (timestamp + 60n) * 1_000_000_000n,
  });
  const transport = custom({
    async request({ method, params = [] }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
      calls.push({ method, params });
      if (method === 'eth_chainId') return toHex(options.chainId ?? 50383);
      if (method === 'net_version') return options.networkId ?? '50000259';
      if (method === 'eth_blockNumber') return toHex(options.latestBlock ?? 101n);
      if (method === 'eth_getBlockByNumber') return {
        number: '0x64', hash: options.receipt === 'reorg' && params[0] !== 'latest' ? OTHER_HASH : BLOCK_HASH,
        parentHash: OTHER_HASH, timestamp: toHex(timestamp), transactions: [],
        gasLimit: '0x5f5e100', gasUsed: '0x0', difficulty: '0x0', extraData: '0x',
      };
      if (method === 'eth_getTransactionCount') return options.pendingNonce && params[1] === 'pending' ? '0x8' : '0x7';
      if (method === 'eth_gasPrice') return '0x3b9aca00';
      if (method === 'eth_getBalance') return '0xde0b6b3a7640000';
      if (method === 'eth_sendRawTransaction') {
        const raw = params[0];
        assert.equal(typeof raw, 'string');
        assert.ok(isHex(raw));
        signed.push(raw);
        if (options.failBroadcast) throw new Error(`upstream timed out sending ${raw}`);
        return keccak256(raw);
      }
      if (method === 'eth_getTransactionReceipt') {
        if (options.receipt === 'rpc-error') throw new Error('RPC connection unavailable');
        if (options.receipt === undefined || options.receipt === 'missing') return null;
        return {
          transactionHash: options.receipt === 'wrong-hash' ? OTHER_HASH : params[0],
          blockHash: BLOCK_HASH, blockNumber: '0x64', transactionIndex: '0x0',
          from: OWNER, to: POOL, contractAddress: null, gasUsed: '0x186a0',
          cumulativeGasUsed: '0x186a0', effectiveGasPrice: '0x3b9aca00', logs: [],
          logsBloom: `0x${'00'.repeat(256)}`, status: options.receipt === 'failed' ? '0x0' : '0x1', type: '0x0',
        };
      }
      assert.equal(method, 'eth_call', `Unexpected RPC method ${method}`);
      const call = params[0];
      assert.ok(call && typeof call === 'object' && 'data' in call && 'to' in call);
      assert.ok(typeof call.data === 'string' && isHex(call.data));
      assert.equal(params[1], '0x64', 'Every contract read and simulation must use the snapshot block');
      const decoded = decodeFunctionData({ abi: rpcAbi, data: call.data });
      switch (decoded.functionName) {
        case 'getPerpPools':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getPerpPools',
            result: options.otherMarketOrders ? [POOL, OTHER_POOL] : [POOL] });
        case 'getBaseTokenForPool':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getBaseTokenForPool',
            result: decoded.args[0].toLowerCase() === OTHER_POOL ? OTHER_BASE : BASE });
        case 'symbol':
          return encodeFunctionResult({ abi: erc20Abi, functionName: 'symbol',
            result: call.to === OTHER_BASE ? 'ETH' : 'BTC' });
        case 'decimals':
          return encodeFunctionResult({ abi: erc20Abi, functionName: 'decimals', result: call.to === BASE ? 8 : 18 });
        case 'marginBank':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'marginBank',
            result: BANK });
        case 'isRestricted':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'isRestricted', result: false });
        case 'getOrderBookParameters':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getOrderBookParameters', result: grid });
        case 'getSystemConfig':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getSystemConfig', result: {
            marginBank: BANK,
            collateralToken: COLLATERAL, perpPoolFactory: FACTORY,
            liquidationEngine: zeroAddress, insuranceFund: zeroAddress, feeRecipient: zeroAddress,
            maxLeverageLimit: 20, fullyWired: true,
          } });
        case 'isPerpPoolRegistered':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'isPerpPoolRegistered', result: true });
        case 'getPosition':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getPosition', result: {
            size: 25_000n, avgEntryPrice: 76_000n * 10n ** 18n, entryFundingIndex: 0n,
            lastUpdatedTimestampNs: timestamp * 1_000_000_000n,
          } });
        case 'getAccountState':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getAccountState', result: {
            unlockedCollateralBalance: 900n * 10n ** 18n, lockedCollateral: 100n * 10n ** 18n,
            activePerpPools: [POOL],
          } });
        case 'tryGetMarkPrice':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'tryGetMarkPrice',
            result: [!options.staleMark, 76_000n * 10n ** 18n] });
        case 'getBookLevels':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getBookLevels',
            result: [{ price: (decoded.args[0] ? 75_999n : 76_001n) * 10n ** 18n, quantity: 10_000_000n }] });
        case 'getOwnOpenOrders':
          assert.ok('from' in call && typeof call.from === 'string');
          assert.equal(call.from.toLowerCase(), OWNER.toLowerCase(), 'Caller-scoped order reads must use the owner');
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getOwnOpenOrders',
            result: call.to === OTHER_POOL ? [99n] : options.pending ? [1n, 2n] : [] });
        case 'getOrder':
          return encodeFunctionResult({ abi: dreamdexReadAbi, functionName: 'getOrder',
            result: decoded.args[0] === 1n ? openOrder(1n, true, 13_000n) : openOrder(2n, false, 4_000n) });
        case 'placeOrder':
          return '0x';
        default:
          throw new Error(`Unexpected contract read ${decoded.functionName}`);
      }
    },
  }, { retryCount: 0 });
  return { transport, calls, signed };
}

test('IOC encoding preserves exact base units, expiry nanoseconds and zero builder fee', () => {
  const order = request({ deadline: 1_800_000_000_123 });
  const data = encodeDreamdexIoc(order, grid, 1_799_999_999_999);
  const decoded = decodeFunctionData({ abi: perpPoolWriteAbi, data });
  assert.equal(decoded.functionName, 'placeOrder');
  assert.deepEqual(decoded.args, [true, 0n, order.limitPrice, 13_000n,
    1_800_000_000_123_000_000n, 2, 0, zeroAddress, 0n]);
  assert.throws(() => encodeDreamdexIoc(request({ quantity: 13_001n }), grid), errorCode('INVALID_QUANTITY'));
  assert.throws(() => encodeDreamdexIoc(request({ limitPrice: 1n }), grid), errorCode('INVALID_PRICE'));
  assert.throws(() => encodeDreamdexIoc(request({ reduceOnly: true }), grid), errorCode('NATIVE_REDUCE_ONLY_UNAVAILABLE'));
  assert.throws(() => encodeDreamdexIoc(request({ deadline: Date.now() - 1 }), grid), errorCode('INVALID_DEADLINE'));
});

test('snapshot reads owner orders at one block and counts remaining quantity, including both sides', async () => {
  const fixture = rpcFixture({ pending: true });
  const adapter = createDreamdexAdapter({ privateKey: KEY, allowTrading: true, transport: fixture.transport });
  const result = await adapter.snapshot(200n);
  assert.equal(result.blockNumber, 100n, 'A lagging RPC must report its real block, never requested minBlock');
  assert.equal(result.blockHash, BLOCK_HASH);
  assert.equal(result.position, 25_000n);
  assert.equal(result.pendingBuys, 13_000n);
  assert.equal(result.pendingSells, 4_000n);
  assert.equal(result.collateral, 1_000n * 10n ** 18n);
  assert.equal(fixture.signed.length, 0);
});

test('prepare locally signs a valid transaction but never broadcasts it', async () => {
  const fixture = rpcFixture();
  const adapter = createDreamdexAdapter({ privateKey: KEY, allowTrading: true, transport: fixture.transport });
  const prepared = await adapter.prepareOrder(request());
  assert.equal(fixture.signed.length, 0);
  assert.ok(isHex(prepared.serialized));
  assert.equal(prepared.hash, keccak256(prepared.serialized));
  assert.equal(prepared.nonce, 7);
  const parsed = parseTransaction(prepared.serialized);
  assert.equal(parsed.type, 'legacy');
  assert.equal(parsed.chainId, 50383);
  assert.equal(parsed.to?.toLowerCase(), POOL);
  assert.equal(parsed.value ?? 0n, 0n);
  assert.equal(parsed.gas, 10_000_000n);
  if (parsed.type !== 'legacy') throw new Error('Expected the tested legacy envelope');
  assert.ok(parsed.r && parsed.s && parsed.v !== undefined);
  assert.equal(await recoverTransactionAddress({ serializedTransaction:
    serializeTransaction(parsed, { r: parsed.r, s: parsed.s, v: parsed.v }) }), OWNER);
  await adapter.broadcast(prepared);
  assert.deepEqual(fixture.signed, [prepared.serialized], 'Broadcast must submit the exact previously signed bytes');
});

test('wrong chain, stale mark, unsupported account exposure and resting orders fail closed', async () => {
  for (const [options, expected] of [
    [{ chainId: 1 }, 'WRONG_CHAIN'],
    [{ staleMark: true }, 'STALE_MARK_PRICE'],
    [{ otherMarketOrders: true }, 'OTHER_MARKET_EXPOSURE'],
    [{ pending: true }, 'PENDING_ORDERS'],
    [{ pendingNonce: true }, 'PENDING_TRANSACTION'],
  ] satisfies [FixtureOptions, string][]) {
    const fixture = rpcFixture(options);
    const adapter = createDreamdexAdapter({ privateKey: KEY, allowTrading: true, transport: fixture.transport });
    await assert.rejects(adapter.prepareOrder(request()), errorCode(expected));
    assert.equal(fixture.signed.length, 0);
  }
});

test('chain 50383 on the older Hideki regenesis cannot describe, snapshot, diagnose or confirm', async () => {
  const fixture = rpcFixture({ networkId: '50000258', receipt: 'confirmed' });
  const adapter = createDreamdexAdapter({ account: OWNER, transport: fixture.transport });
  for (const read of [
    () => adapter.describe(),
    () => adapter.snapshot(),
    () => adapter.doctor(),
    () => adapter.receipt(TX_HASH),
  ]) {
    await assert.rejects(read(), errorCode('WRONG_NETWORK'));
  }
  assert.equal(fixture.calls.filter(call => call.method === 'net_version').length, 4);
  assert.ok(!fixture.calls.some(call => call.method === 'eth_call'),
    'Reused factory and pool addresses must not be trusted on the wrong regenesis');
  assert.ok(!fixture.calls.some(call => call.method === 'eth_getTransactionReceipt'),
    'A receipt from a different chain instance cannot confirm a persisted intent');
});

test('signing rechecks network identity after successful market discovery', async () => {
  const options: FixtureOptions = {};
  const fixture = rpcFixture(options);
  const adapter = createDreamdexAdapter({ privateKey: KEY, allowTrading: true, transport: fixture.transport });
  await adapter.describe();
  options.networkId = '50000258';
  const callsBefore = fixture.calls.length;
  await assert.rejects(adapter.prepareOrder(request()), errorCode('WRONG_NETWORK'));
  assert.ok(!fixture.calls.slice(callsBefore).some(call => call.method === 'eth_getTransactionCount'),
    'A cached discovery cannot authorize preparing a nonce on the wrong regenesis');
  assert.equal(fixture.signed.length, 0);
});

test('broadcast rechecks regenesis identity before submitting already signed bytes', async () => {
  const options: FixtureOptions = {};
  const fixture = rpcFixture(options);
  const adapter = createDreamdexAdapter({ privateKey: KEY, allowTrading: true, transport: fixture.transport });
  const prepared = await adapter.prepareOrder(request());
  options.networkId = '50000258';
  await assert.rejects(adapter.broadcast(prepared), errorCode('WRONG_NETWORK'));
  assert.equal(fixture.signed.length, 0,
    'Identical chain IDs do not authorize replaying the signed transaction onto Hideki1');
  assert.ok(!fixture.calls.some(call => call.method === 'eth_sendRawTransaction'));
});

test('prepared bytes cannot be broadcast under another recorded hash or nonce', async () => {
  const fixture = rpcFixture();
  const adapter = createDreamdexAdapter({ privateKey: KEY, allowTrading: true, transport: fixture.transport });
  const prepared = await adapter.prepareOrder(request());
  await assert.rejects(adapter.broadcast({ ...prepared, hash: TX_HASH }), errorCode('TRANSACTION_HASH_MISMATCH'));
  await assert.rejects(adapter.broadcast({ ...prepared, nonce: 8 }), errorCode('INVALID_SIGNED_TRANSACTION'));
  assert.equal(fixture.signed.length, 0);
});

test('a dropped send acknowledgement is uncertain and never leaks serialized bytes in the error', async () => {
  const fixture = rpcFixture({ failBroadcast: true });
  const adapter = createDreamdexAdapter({ privateKey: KEY, allowTrading: true, transport: fixture.transport });
  const prepared = await adapter.prepareOrder(request());
  await assert.rejects(adapter.broadcast(prepared), (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, 'BROADCAST_UNCERTAIN', error.message);
    assert.ok(!String(error).includes(prepared.serialized));
    return true;
  });
  assert.deepEqual(fixture.signed, [prepared.serialized]);
});

test('receipt reports only matching canonical transactions with two confirmations', async () => {
  const confirmed = createDreamdexAdapter({ transport: rpcFixture({ receipt: 'confirmed' }).transport });
  assert.deepEqual(await confirmed.receipt(TX_HASH), {
    kind: 'confirmed', blockNumber: 100n, blockHash: BLOCK_HASH, success: true,
  });
  const reverted = createDreamdexAdapter({ transport: rpcFixture({ receipt: 'failed' }).transport });
  assert.deepEqual(await reverted.receipt(TX_HASH), {
    kind: 'confirmed', blockNumber: 100n, blockHash: BLOCK_HASH, success: false,
  });
  const immature = createDreamdexAdapter({ transport: rpcFixture({ receipt: 'confirmed', latestBlock: 100n }).transport });
  assert.deepEqual(await immature.receipt(TX_HASH), { kind: 'unknown' });
  const absent = createDreamdexAdapter({ transport: rpcFixture({ receipt: 'missing' }).transport });
  assert.deepEqual(await absent.receipt(TX_HASH), { kind: 'unknown' });
  for (const [receipt, expected] of [
    ['wrong-hash', 'RECEIPT_HASH_MISMATCH'], ['reorg', 'RECEIPT_REORG'],
  ] satisfies [FixtureOptions['receipt'], string][]) {
    const adapter = createDreamdexAdapter({ transport: rpcFixture({ receipt }).transport });
    await assert.rejects(adapter.receipt(TX_HASH), errorCode(expected));
  }
  const broken = createDreamdexAdapter({ transport: rpcFixture({ receipt: 'rpc-error' }).transport });
  await assert.rejects(broken.receipt(TX_HASH), /RPC connection unavailable/);
});

test('read-only mode and mismatched account configuration cannot sign', async () => {
  const fixture = rpcFixture();
  const adapter = createDreamdexAdapter({ account: OWNER, transport: fixture.transport });
  assert.equal((await adapter.describe()).canTrade, false);
  await assert.rejects(adapter.prepareOrder(request()), errorCode('READ_ONLY'));
  const disabled = createDreamdexAdapter({ privateKey: KEY, transport: fixture.transport });
  assert.equal((await disabled.describe()).canTrade, false);
  await assert.rejects(disabled.prepareOrder(request()), errorCode('TRADING_DISABLED'));
  assert.throws(() => createDreamdexAdapter({ privateKey: KEY, account: zeroAddress }), errorCode('ACCOUNT_MISMATCH'));
  assert.throws(() => createDreamdexAdapter({ symbol: 'ETH-PERP' }), errorCode('UNSUPPORTED_MARKET'));
  assert.equal(fixture.signed.length, 0);
});
