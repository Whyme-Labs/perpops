import {
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  perpPoolWriteAbi,
} from '@somnia-chain/markets-sdk';
import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  zeroAddress,
  type Address,
  type Hex,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  DomainError,
  type AccountSnapshot,
  type ExchangeAdapter,
  type MarketDescriptor,
  type OrderRequest,
  type PreparedTransaction,
  type TransactionReceipt,
} from '../types.ts';

export const DREAMDEX_CHAIN_ID = 50383;
export const DREAMDEX_RPC_URL = 'https://api.hideki2.infra.testnet.somnia.network';
const DREAMDEX_NETWORK_ID = '50000259';
const EXPLORER = 'https://explorer.testnet.somnia.network/tokyo';
const ORDER_GAS_LIMIT = 10_000_000n;
const MAX_SNAPSHOT_AGE_MS = 30_000;
const MAX_POOLS = 64;
const MAX_OPEN_ORDERS = 256;

const hideki = defineChain({
  id: DREAMDEX_CHAIN_ID,
  name: 'Somnia Hideki testnet',
  nativeCurrency: { name: 'Test STT', symbol: 'STT', decimals: 18 },
  rpcUrls: { default: { http: [DREAMDEX_RPC_URL] } },
  testnet: true,
});

// Exact read signatures from markets-sdk 0.32.1 src/readsAbi.ts. The SDK does
// not export its read ABIs. Reads here stay pinned to one externally chosen block.
export const dreamdexReadAbi = parseAbi([
  'function getPerpPools() view returns (address[])',
  'function getBaseTokenForPool(address perpPool) view returns (address)',
  'function marginBank() view returns (address)',
  'function isRestricted() view returns (bool)',
  'function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))',
  'function getOwnOpenOrders() view returns (uint128[])',
  'function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))',
  'function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])',
  'function tryGetMarkPrice() view returns (bool ok, uint256 price)',
  'function getSystemConfig() view returns ((address marginBank, address collateralToken, address perpPoolFactory, address liquidationEngine, address insuranceFund, address feeRecipient, uint16 maxLeverageLimit, bool fullyWired))',
  'function isPerpPoolRegistered(address perpPool) view returns (bool)',
  'function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))',
  'function getAccountState(address account) view returns ((int256 unlockedCollateralBalance, uint256 lockedCollateral, address[] activePerpPools))',
]);

export interface DreamdexConfig {
  privateKey?: string;
  allowTrading?: boolean;
  account?: string;
  rpcUrl?: string;
  symbol?: string;
  /** Dependency injection for RPC protocol tests. Chain and network identity checks still apply. */
  transport?: Transport;
  /** At least two blocks are required before reporting a canonical receipt. */
  confirmations?: number;
}

export interface DreamdexDoctor {
  market: MarketDescriptor;
  snapshot: AccountSnapshot;
  gasBalance: bigint;
  collateralToken: string;
  marginBank: string;
  confirmations: number;
  warnings: string[];
}

function address(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new DomainError('INVALID_ADDRESS', `${name} is not a valid EVM address.`);
  }
  return getAddress(value);
}

function hex(value: string, name: string, bytes?: number): Hex {
  if (!isHex(value, { strict: true }) || value.length % 2 !== 0 ||
      (bytes !== undefined && value.length !== 2 + bytes * 2)) {
    throw new DomainError('INVALID_HEX', `${name} is malformed.`);
  }
  return value;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function signerFrom(value: string | undefined) {
  if (value === undefined) return undefined;
  try {
    return privateKeyToAccount(hex(value, 'Private key', 32));
  } catch {
    // A config error must never echo a private key or the underlying parser input.
    throw new DomainError('INVALID_PRIVATE_KEY', 'The dedicated testnet private key is invalid.');
  }
}

export function encodeDreamdexIoc(order: OrderRequest, market: Pick<MarketDescriptor,
  'lotSize' | 'minQuantity' | 'tickSize'>, now = Date.now()): Hex {
  if (order.reduceOnly) {
    throw new DomainError('NATIVE_REDUCE_ONLY_UNAVAILABLE',
      'The verified DreamDEX IOC ABI has no native reduce-only flag.');
  }
  if (order.side !== 'buy' && order.side !== 'sell') {
    throw new DomainError('INVALID_ORDER', 'Order side must be buy or sell.');
  }
  if (market.lotSize <= 0n || market.tickSize <= 0n || market.minQuantity <= 0n) {
    throw new DomainError('INVALID_MARKET', 'Market tick, lot and minimum size must be positive.');
  }
  if (order.quantity < market.minQuantity || order.quantity % market.lotSize !== 0n) {
    throw new DomainError('INVALID_QUANTITY', 'Quantity must meet the market minimum and lot size.');
  }
  if (order.limitPrice <= 0n || order.limitPrice % market.tickSize !== 0n) {
    throw new DomainError('INVALID_PRICE', 'Limit price must be positive and on the market tick.');
  }
  if (!Number.isSafeInteger(order.deadline) || order.deadline <= now ||
      BigInt(order.deadline) * 1_000_000n > (1n << 64n) - 1n) {
    throw new DomainError('INVALID_DEADLINE', 'Order deadline must be a future Unix timestamp in milliseconds.');
  }
  return encodeFunctionData({
    abi: perpPoolWriteAbi,
    functionName: 'placeOrder',
    args: [order.side === 'buy', 0n, order.limitPrice, order.quantity,
      BigInt(order.deadline) * 1_000_000n, 2, 0, zeroAddress, 0n],
  });
}

export function createDreamdexAdapter(config: DreamdexConfig = {}): ExchangeAdapter & {
  doctor(): Promise<DreamdexDoctor>;
} {
  if (config.symbol !== undefined && config.symbol !== 'BTC-PERP') {
    throw new DomainError('UNSUPPORTED_MARKET', 'This milestone supports BTC-PERP only.');
  }
  const confirmations = config.confirmations ?? 2;
  if (!Number.isSafeInteger(confirmations) || confirmations < 2 || confirmations > 100) {
    throw new DomainError('INVALID_CONFIRMATIONS', 'Receipt confirmations must be between 2 and 100.');
  }
  const signer = signerFrom(config.privateKey);
  const account = config.account === undefined
    ? signer?.address ?? zeroAddress
    : address(config.account, 'Account');
  if (signer && !sameAddress(account, signer.address)) {
    throw new DomainError('ACCOUNT_MISMATCH', 'The account must belong to the configured dedicated key.');
  }
  const factory = address(SOMNIA_HIDEKI_TESTNET_ADDRESSES.perpPoolFactory, 'Official perp factory');
  const expectedBank = address(SOMNIA_HIDEKI_TESTNET_ADDRESSES.marginBank, 'Official margin bank');
  const client = createPublicClient({
    chain: hideki,
    cacheTime: 0,
    transport: config.transport ?? http(config.rpcUrl ?? DREAMDEX_RPC_URL, {
      timeout: 15_000,
      retryCount: 0,
      batch: { batchSize: 32, wait: 5 },
    }),
  });
  let discovery: Promise<{ pool: Address; baseToken: Address }> | undefined;

  async function checkChain() {
    const [chainId, rpcNetworkId] = await Promise.all([
      client.getChainId(),
      client.request({ method: 'net_version' }),
    ]);
    if (chainId !== DREAMDEX_CHAIN_ID) {
      throw new DomainError('WRONG_CHAIN', 'DreamDEX execution requires Hideki testnet chain 50383.');
    }
    // The SDK's bridge registry documents two independent Hideki chains with
    // chainId 50383 and reused contract addresses. Only net_version distinguishes
    // the intended Hideki2 regenesis from the older Hideki1 network (50000258).
    // viem types this RPC response as Hex; these nodes return a decimal string.
    const networkId: unknown = rpcNetworkId;
    if (networkId !== DREAMDEX_NETWORK_ID) {
      throw new DomainError('WRONG_NETWORK',
        'DreamDEX execution requires Hideki2 network 50000259. Chain ID 50383 alone is not sufficient.');
    }
  }

  async function head() {
    const [block] = await Promise.all([client.getBlock({ blockTag: 'latest' }), checkChain()]);
    if (block.number === null || block.hash === null) {
      throw new DomainError('UNCONFIRMED_HEAD', 'RPC returned an unmined block.');
    }
    const observedAt = Number(block.timestamp) * 1000;
    if (!Number.isSafeInteger(observedAt) || Date.now() - observedAt > MAX_SNAPSHOT_AGE_MS ||
        observedAt - Date.now() > 15_000) {
      throw new DomainError('STALE_CHAIN_HEAD', 'RPC head is stale or its timestamp is invalid.');
    }
    return { number: block.number, hash: block.hash, observedAt };
  }

  async function poolsAt(blockNumber: bigint) {
    const pools = await client.readContract({ address: factory, abi: dreamdexReadAbi,
      functionName: 'getPerpPools', blockNumber });
    if (pools.length === 0 || pools.length > MAX_POOLS || new Set(pools.map(p => p.toLowerCase())).size !== pools.length) {
      throw new DomainError('INVALID_POOL_REGISTRY', 'The factory pool list is empty, duplicated or exceeds the supported bound.');
    }
    return pools;
  }

  async function discover(blockNumber: bigint, pools: readonly Address[]) {
    discovery ??= (async () => {
      const rows = await Promise.all(pools.map(async pool => {
        const baseToken = await client.readContract({ address: factory, abi: dreamdexReadAbi,
          functionName: 'getBaseTokenForPool', args: [pool], blockNumber });
        const symbol = await client.readContract({ address: baseToken, abi: erc20Abi,
          functionName: 'symbol', blockNumber });
        return { pool, baseToken, symbol };
      }));
      const matches = rows.filter(row => row.symbol === 'BTC');
      const match = matches[0];
      if (matches.length !== 1 || match === undefined) {
        throw new DomainError('AMBIGUOUS_MARKET', 'The official factory must contain exactly one BTC market.');
      }
      return { pool: match.pool, baseToken: match.baseToken };
    })().catch(error => { discovery = undefined; throw error; });
    const result = await discovery;
    if (!pools.some(pool => sameAddress(pool, result.pool))) {
      throw new DomainError('MARKET_REMOVED', 'The selected market is no longer in the official factory.');
    }
    return result;
  }

  async function context() {
    const block = await head();
    const pools = await poolsAt(block.number);
    const selected = await discover(block.number, pools);
    const read = { address: selected.pool, abi: dreamdexReadAbi, blockNumber: block.number };
    const [bank, restricted, grid, baseDecimals] = await Promise.all([
      client.readContract({ ...read, functionName: 'marginBank' }),
      client.readContract({ ...read, functionName: 'isRestricted' }),
      client.readContract({ ...read, functionName: 'getOrderBookParameters' }),
      client.readContract({ address: selected.baseToken, abi: erc20Abi, functionName: 'decimals', blockNumber: block.number }),
    ]);
    if (!sameAddress(bank, expectedBank)) {
      throw new DomainError('MARGIN_BANK_CHANGED', 'The pool margin bank differs from the verified Hideki deployment.');
    }
    const [system, registered] = await Promise.all([
      client.readContract({ address: bank, abi: dreamdexReadAbi, functionName: 'getSystemConfig', blockNumber: block.number }),
      client.readContract({ address: bank, abi: dreamdexReadAbi, functionName: 'isPerpPoolRegistered',
        args: [selected.pool], blockNumber: block.number }),
    ]);
    if (!system.fullyWired || !sameAddress(system.marginBank, bank) ||
        !sameAddress(system.perpPoolFactory, factory) || sameAddress(system.collateralToken, zeroAddress)) {
      throw new DomainError('INVALID_SYSTEM_CONFIG', 'The market is not wired to the expected perps system.');
    }
    const quoteDecimals = await client.readContract({ address: system.collateralToken, abi: erc20Abi,
      functionName: 'decimals', blockNumber: block.number });
    if (baseDecimals > 36 || quoteDecimals > 36 || grid.lotSize <= 0n || grid.tickSize <= 0n || grid.minQuantity <= 0n) {
      throw new DomainError('INVALID_MARKET', 'Market precision or size parameters are unsupported.');
    }
    const market: MarketDescriptor = {
      mode: 'dreamdex', symbol: 'BTC-PERP', chainId: DREAMDEX_CHAIN_ID, account,
      pool: selected.pool, baseDecimals, quoteDecimals, ...grid,
      explorerUrl: EXPLORER, canTrade: signer !== undefined && config.allowTrading === true && registered && !restricted,
      nativeReduceOnly: false,
    };
    return { block, pools, pool: selected.pool, bank, collateralToken: system.collateralToken, market };
  }

  type Context = Awaited<ReturnType<typeof context>>;

  async function snapshotAt(ctx: Context): Promise<AccountSnapshot> {
    const blockNumber = ctx.block.number;
    const pool = { address: ctx.pool, abi: dreamdexReadAbi, blockNumber };
    const bank = { address: ctx.bank, abi: dreamdexReadAbi, blockNumber };
    const [position, state, mark, bids, asks, idsByPool] = await Promise.all([
      client.readContract({ ...bank, functionName: 'getPosition', args: [account, ctx.pool] }),
      client.readContract({ ...bank, functionName: 'getAccountState', args: [account] }),
      client.readContract({ ...pool, functionName: 'tryGetMarkPrice' }),
      client.readContract({ ...pool, functionName: 'getBookLevels', args: [true, 1n] }),
      client.readContract({ ...pool, functionName: 'getBookLevels', args: [false, 1n] }),
      // getOwnOpenOrders reads msg.sender. HTTP batching preserves the sender;
      // Multicall3 would silently return the aggregator's order list instead.
      Promise.all(ctx.pools.map(async candidate => ({
        pool: candidate,
        ids: await client.readContract({ address: candidate, abi: dreamdexReadAbi,
          functionName: 'getOwnOpenOrders', account, blockNumber }),
      }))),
    ]);
    if (!mark[0] || mark[1] <= 0n) {
      throw new DomainError('STALE_MARK_PRICE', 'The pool reports a stale or zero mark price. Trading is paused.');
    }
    if (state.activePerpPools.some(candidate => !sameAddress(candidate, ctx.pool)) ||
        idsByPool.some(row => !sameAddress(row.pool, ctx.pool) && row.ids.length > 0)) {
      throw new DomainError('OTHER_MARKET_EXPOSURE', 'Use a dedicated account with no positions or orders outside BTC-PERP.');
    }
    const ids = idsByPool.find(row => sameAddress(row.pool, ctx.pool))?.ids;
    if (!ids || ids.length > MAX_OPEN_ORDERS || new Set(ids).size !== ids.length) {
      throw new DomainError('INVALID_ORDER_SET', 'The account order set is missing, duplicated or exceeds the supported bound.');
    }
    const orders = await Promise.all(ids.map(orderId => client.readContract({ ...pool,
      functionName: 'getOrder', args: [orderId] })));
    let pendingBuys = 0n;
    let pendingSells = 0n;
    for (let index = 0; index < orders.length; index += 1) {
      const order = orders[index];
      if (!order || order.orderId !== ids[index] || !sameAddress(order.owner, account) ||
          order.quantityRemaining <= 0n || order.quantityRemaining > order.fullQuantity) {
        throw new DomainError('INCONSISTENT_ORDER', 'The on-chain order set and order details disagree.');
      }
      // Conservatively include even expired orders until the pool removes them.
      if (order.isBid) pendingBuys += order.quantityRemaining;
      else pendingSells += order.quantityRemaining;
    }
    const canonical = await client.getBlock({ blockNumber });
    if (canonical.number !== blockNumber || canonical.hash !== ctx.block.hash) {
      throw new DomainError('SNAPSHOT_REORG', 'The snapshot block changed while it was being read.');
    }
    return {
      blockNumber, blockHash: ctx.block.hash, observedAt: ctx.block.observedAt,
      position: position.size, pendingBuys, pendingSells, markPrice: mark[1],
      bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null,
      collateral: state.unlockedCollateralBalance + state.lockedCollateral,
    };
  }

  async function prepareOrder(order: OrderRequest): Promise<PreparedTransaction> {
    if (!signer) throw new DomainError('READ_ONLY', 'Configure a dedicated testnet key before preparing an order.');
    if (config.allowTrading !== true) throw new DomainError('TRADING_DISABLED', 'Testnet trading must be explicitly enabled.');
    if (order.reduceOnly) throw new DomainError('NATIVE_REDUCE_ONLY_UNAVAILABLE', 'Native reduce-only IOC is not supported by the verified ABI.');
    const ctx = await context();
    if (!ctx.market.canTrade) throw new DomainError('MARKET_UNAVAILABLE', 'The market is restricted or unregistered.');
    const data = encodeDreamdexIoc(order, ctx.market);
    const snapshot = await snapshotAt(ctx);
    if (snapshot.pendingBuys !== 0n || snapshot.pendingSells !== 0n) {
      throw new DomainError('PENDING_ORDERS', 'Cancel resting orders before this single-writer executor submits an IOC.');
    }
    // eth_call validates the exact calldata without signing or broadcasting.
    await client.call({ account, to: ctx.pool, data, value: 0n, gas: ORDER_GAS_LIMIT,
      blockNumber: ctx.block.number });
    const [nonce, minedNonce, gasPrice, balance] = await Promise.all([
      client.getTransactionCount({ address: account, blockTag: 'pending' }),
      client.getTransactionCount({ address: account, blockNumber: ctx.block.number }),
      client.getGasPrice(),
      client.getBalance({ address: account, blockNumber: ctx.block.number }),
    ]);
    if (!Number.isSafeInteger(nonce) || nonce < 0 || gasPrice <= 0n) {
      throw new DomainError('INVALID_TRANSACTION_PARAMETERS', 'RPC returned invalid nonce or gas price.');
    }
    if (nonce !== minedNonce) {
      throw new DomainError('PENDING_TRANSACTION',
        'The wallet has a pending transaction or changed nonce after the snapshot. Reconcile before preparing another order.');
    }
    if (balance < ORDER_GAS_LIMIT * gasPrice) {
      throw new DomainError('INSUFFICIENT_GAS', 'The dedicated account needs testnet STT for the transaction gas ceiling.');
    }
    if (Date.now() - snapshot.observedAt > MAX_SNAPSHOT_AGE_MS || Date.now() >= order.deadline) {
      throw new DomainError('PREPARATION_EXPIRED', 'The snapshot or order deadline expired during preparation.');
    }
    const serialized = await signer.signTransaction({ type: 'legacy', chainId: DREAMDEX_CHAIN_ID,
      to: ctx.pool, nonce, gasPrice, gas: ORDER_GAS_LIMIT, value: 0n, data });
    // The caller must durably commit these exact bytes before calling broadcast.
    return { serialized, hash: keccak256(serialized), nonce };
  }

  async function broadcast(transaction: PreparedTransaction): Promise<void> {
    if (!signer) throw new DomainError('READ_ONLY', 'A read-only adapter cannot broadcast transactions.');
    if (config.allowTrading !== true) throw new DomainError('TRADING_DISABLED', 'Testnet trading must be explicitly enabled.');
    const serialized = hex(transaction.serialized, 'Signed transaction');
    const hash = hex(transaction.hash, 'Transaction hash', 32);
    if (keccak256(serialized).toLowerCase() !== hash.toLowerCase()) {
      throw new DomainError('TRANSACTION_HASH_MISMATCH', 'Stored transaction bytes do not match their recorded hash.');
    }
    let tx;
    try {
      tx = parseTransaction(serialized);
    } catch {
      throw new DomainError('INVALID_SIGNED_TRANSACTION', 'The stored transaction cannot be decoded.');
    }
    if (tx.type !== 'legacy' || tx.r === undefined || tx.s === undefined || tx.v === undefined) {
      throw new DomainError('INVALID_SIGNED_TRANSACTION', 'Only the prepared legacy transaction envelope is supported.');
    }
    const canonicalSerialized = serializeTransaction(tx, { r: tx.r, s: tx.s, v: tx.v });
    if (canonicalSerialized.toLowerCase() !== serialized.toLowerCase()) {
      throw new DomainError('INVALID_SIGNED_TRANSACTION', 'The signed transaction encoding is not canonical.');
    }
    const ctx = await context();
    let recovered;
    try {
      recovered = await recoverTransactionAddress({ serializedTransaction: canonicalSerialized });
    } catch {
      throw new DomainError('INVALID_SIGNED_TRANSACTION', 'The stored transaction signature is invalid.');
    }
    if (tx.chainId !== DREAMDEX_CHAIN_ID || tx.nonce !== transaction.nonce ||
        !tx.to || !sameAddress(tx.to, ctx.pool) || !sameAddress(recovered, account) ||
        (tx.value ?? 0n) !== 0n || !tx.data || tx.gas !== ORDER_GAS_LIMIT) {
      throw new DomainError('INVALID_SIGNED_TRANSACTION', 'The signed transaction is not an authorized Hideki order for this account.');
    }
    const call = decodeFunctionData({ abi: perpPoolWriteAbi, data: tx.data });
    if (call.functionName !== 'placeOrder' || call.args[1] !== 0n || call.args[5] !== 2 ||
        call.args[6] !== 0 || !sameAddress(call.args[7], zeroAddress) || call.args[8] !== 0n) {
      throw new DomainError('INVALID_SIGNED_TRANSACTION', 'Only fee-free bounded IOC order calls may be broadcast.');
    }
    try {
      const returned = await client.sendRawTransaction({ serializedTransaction: serialized });
      if (returned.toLowerCase() !== hash.toLowerCase()) {
        throw new DomainError('TRANSACTION_HASH_MISMATCH', 'RPC returned a different transaction hash. Reconcile the recorded hash.');
      }
    } catch (error) {
      if (error instanceof DomainError) throw error;
      // viem's transport error includes raw signed bytes. Keep that out of API
      // errors and logs; the durable hash is enough to reconcile an unknown send.
      throw new DomainError('BROADCAST_UNCERTAIN',
        'RPC did not confirm submission. Reconcile the persisted transaction hash before retrying.', 503);
    }
  }

  async function receipt(value: string): Promise<TransactionReceipt> {
    const hash = hex(value, 'Transaction hash', 32);
    await checkChain();
    let result;
    try {
      result = await client.getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return { kind: 'unknown' };
      throw error;
    }
    if (result.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new DomainError('RECEIPT_HASH_MISMATCH', 'RPC returned a receipt for a different transaction.');
    }
    const [canonical, latest] = await Promise.all([
      client.getBlock({ blockNumber: result.blockNumber }),
      client.getBlockNumber({ cacheTime: 0 }),
    ]);
    if (canonical.number !== result.blockNumber || canonical.hash !== result.blockHash) {
      throw new DomainError('RECEIPT_REORG', 'The receipt block is no longer canonical.');
    }
    if (latest < result.blockNumber + BigInt(confirmations - 1)) return { kind: 'unknown' };
    return { kind: 'confirmed', blockNumber: result.blockNumber, blockHash: result.blockHash,
      success: result.status === 'success' };
  }

  return {
    describe: async () => (await context()).market,
    // A lagging RPC reports its real block. It never invents minBlock, and core
    // independently refuses snapshots older than the receipt it is reconciling.
    snapshot: async (_minBlock?: bigint) => snapshotAt(await context()),
    prepareOrder,
    broadcast,
    receipt,
    doctor: async () => {
      const ctx = await context();
      const [snapshot, gasBalance] = await Promise.all([
        snapshotAt(ctx), client.getBalance({ address: account, blockNumber: ctx.block.number }),
      ]);
      const warnings = ['Native reduce-only IOC is unavailable. Closing orders require the single-writer account rule.'];
      if (!signer) warnings.push('Read-only mode. No dedicated testnet key was supplied.');
      else if (config.allowTrading !== true) warnings.push('Read-only mode. Testnet trading has not been explicitly enabled.');
      if (gasBalance === 0n) warnings.push('This account has no testnet STT for gas.');
      if (snapshot.collateral <= 0n) warnings.push('This account has no positive perp margin balance.');
      return { market: ctx.market, snapshot, gasBalance, marginBank: ctx.bank,
        collateralToken: ctx.collateralToken, confirmations, warnings };
    },
  };
}
