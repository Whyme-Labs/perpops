export type Mode = 'simulation' | 'dreamdex';
export type Side = 'buy' | 'sell';

/** All quantities and prices are exact integers in the market's own decimals. */
export interface MarketDescriptor {
  mode: Mode;
  symbol: string;
  chainId: number;
  account: string;
  pool: string;
  baseDecimals: number;
  quoteDecimals: number;
  lotSize: bigint;
  minQuantity: bigint;
  tickSize: bigint;
  explorerUrl: string | null;
  canTrade: boolean;
  nativeReduceOnly: boolean;
}

export interface AccountSnapshot {
  blockNumber: bigint;
  blockHash: string;
  observedAt: number;
  position: bigint;
  pendingBuys: bigint;
  pendingSells: bigint;
  markPrice: bigint;
  bestBid: bigint | null;
  bestAsk: bigint | null;
  collateral: bigint;
}

export interface OrderRequest {
  side: Side;
  quantity: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  deadline: number;
}

/** Never expose serialized bytes through the HTTP API or exported receipts. */
export interface PreparedTransaction {
  hash: string;
  serialized: string;
  nonce: number;
}

export type TransactionReceipt =
  | { kind: 'unknown' }
  | { kind: 'confirmed'; blockNumber: bigint; blockHash: string; success: boolean };

/** prepareOrder MUST NOT broadcast. snapshot must either meet minBlock or report
 * its real older block; the executor independently checks this before trading. */
export interface ExchangeAdapter {
  describe(): Promise<MarketDescriptor>;
  snapshot(minBlock?: bigint): Promise<AccountSnapshot>;
  prepareOrder(order: OrderRequest): Promise<PreparedTransaction>;
  broadcast(transaction: PreparedTransaction): Promise<void>;
  receipt(hash: string): Promise<TransactionReceipt>;
  close?(): Promise<void>;
}

export interface IntentInput {
  id: string;
  target: string;
  maxPosition: string;
  limitPrice: string;
  deadline: string;
}

export type IntentStatus =
  | 'queued'
  | 'prepared'
  | 'uncertain'
  | 'confirming'
  | 'partial'
  | 'completed'
  | 'paused'
  | 'expired'
  | 'failed'
  | 'cancelled';

export type Fault = 'none' | 'drop_ack' | 'drop_before_send' | 'stale_read' | 'partial_fill' | 'pending_receipt';

export class DomainError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
