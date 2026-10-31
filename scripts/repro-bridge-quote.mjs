// Node 24. Public, read-only JSON-RPC only. No packages, key, signature or transaction.
// Run: NODE_USE_ENV_PROXY=1 node scripts/repro-bridge-quote.mjs
const RPC = 'https://api.infra.testnet.somnia.network';
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--block' || !/^(latest|\d+)$/.test(args[1]))) {
  throw new Error('Usage: node scripts/repro-bridge-quote.mjs [--block latest|DECIMAL_BLOCK_NUMBER]');
}
const blockTag = !args.length || args[1] === 'latest' ? 'latest' : `0x${BigInt(args[1]).toString(16)}`;
const routers = {
  STT: '0x67CD0778A719099DAF2D346aD0Db0d9E6FF6674C',
  USDso: '0x94E2E7f4B2B0a8E3032c7D3ff3c86790BB5979E6',
  WBTC: '0x888d8C8090b8cDcEa5d05b1C206c2bFF18cd2DA9',
  WETH: '0x41C21248D6CC3883cd577D0eFEF3585b1358A8B2',
  HBTT: '0x04a276255FfB8487E94b07a2187aB56A281bb6eE',
};
let requestId = 0;
async function rpc(method, params) {
  if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(method)) {
    throw new Error(`This reproduction permits read-only calls only: ${method}`);
  }
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
const identity = await rpc('eth_chainId', []);
if (identity.result !== '0xc488') throw new Error(`Expected Shannon 50312: ${JSON.stringify(identity)}`);
const head = await rpc('eth_getBlockByNumber', [blockTag, false]);
if (!head.result?.number || !head.result.hash) throw new Error(`No block: ${JSON.stringify(head)}`);
const block = head.result;
const destination = BigInt(50383).toString(16).padStart(64, '0');
const quoteData = `0xf2ed8c53${destination}`; // quoteGasPayment(uint32)
const enrollmentData = `0x2ead72f6${destination}`; // routers(uint32)
const observations = await Promise.allSettled(Object.entries(routers).map(async ([token, address]) => {
  const calls = {
    quoteGasPayment: quoteData,
    hook: '0x7f5a7c7b',
    enrolledRouter: enrollmentData,
  };
  const readings = {};
  for (const [name, data] of Object.entries(calls)) {
    const response = await rpc('eth_call', [{ to: address, data }, block.number]);
    readings[name] = { request: { to: address, data, block: block.number }, ...response };
  }
  return { token, address, readings };
}));
const canonical = await rpc('eth_getBlockByNumber', [block.number, false]);
const rows = observations.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
const usdsoQuote = rows.find(row => row.token === 'USDso')?.readings.quoteGasPayment;
const controls = rows.filter(row => row.token !== 'USDso');
const controlsQuoteZero = controls.length === 4 && controls.every(row => {
  const value = row.readings.quoteGasPayment.result;
  return typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) && BigInt(value) === 0n;
});
const canonicalBlockUnchanged = canonical.result?.hash === block.hash;
const output = {
  observedAt: new Date().toISOString(),
  rpcUrl: RPC,
  chainId: 50312,
  destinationChainId: 50383,
  block: { number: Number(BigInt(block.number)), hash: block.hash, timestamp: Number(BigInt(block.timestamp)) },
  canonicalBlockUnchanged,
  expectedFailureObserved: canonicalBlockUnchanged && controlsQuoteZero && usdsoQuote?.error?.code === 3 && usdsoQuote.error.data === '0x',
  controlsQuoteZero,
  observations: observations.map((result) => result.status === 'fulfilled'
    ? result.value
    : { error: result.reason instanceof Error ? result.reason.message : String(result.reason) }),
};
console.log(JSON.stringify(output, null, 2));
if (!output.canonicalBlockUnchanged || observations.some((r) => r.status === 'rejected')) process.exitCode = 1;
