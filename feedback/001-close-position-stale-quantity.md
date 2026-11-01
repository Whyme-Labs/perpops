# closePosition can submit an oversized close after the position shrinks between reads

Severity: normal

Area: app

Status: independently reproduced offline; not submitted or accepted

## Summary

The official bot kit's `closePosition` takes its order quantity from
`previewPerpClosePnl`, then separately fetches positions and uses that later
observation only to choose buy or sell. It does not compare the saved quantity
with the position size already present in the second response.

When the position shrinks between these observations, the helper can submit a
closing order larger than the position it just read. With a full fill and
sufficient margin, that order would cross zero and open the opposite position.
This report demonstrates the submitted order parameters. It does not claim an
observed on-chain reversal or financial loss.

Affected source:
[orders.ts at 4e75896896e024c03e2033d5920514f249998cd6](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/packages/perp-core/src/orders.ts).
`closePosition` starts at line 234. The quantity is computed before the later
`positionIn` call; `placePerp` receives that saved quantity without a current-size
check.

## Steps to reproduce

Requires Node.js 24 or later. From this repository root:

```sh
npm ci
npm run feedback:close
```

The reproduction:

1. Verifies SHA256 digests of the unchanged upstream modules against
   [provenance.json](upstream/provenance.json).
2. Transpiles and invokes the actual `closePosition`, `placePerp`, `positionIn`,
   `alignPrice`, `alignQuantity`, and receipt assertion functions.
3. Supplies a close preview for 0.001 BTC, then a later position read for 0.0004 BTC.
4. Captures the call to the trader boundary. No signer or network is present.
5. Checks the submitted side and quantity, then separately calculates the result
   under an explicit full-fill assumption.

The harness uses the real installed SDK order-type constant and viem formatting.
Only the external exchange responses and trader write boundary are controlled.
Unused configuration and operator paths throw if reached. No environment file,
private key, RPC, transaction or testnet balance is required.

## Expected

A close helper should derive direction and quantity from a consistent position
observation, or stop when its observations disagree. A later position of
0.0004 BTC should not produce a sell order for 0.001 BTC merely because an earlier
preview described a larger position.

The desired bound for a pure close is that the order quantity is at most the
absolute current position, subject to the lot grid and minimum quantity.

## Actual

Seven scenarios pass assertions against the pinned upstream revision:

| Scenario | Later signed position | Captured order | Modeled position after a full fill |
| --- | ---: | --- | ---: |
| Unchanged long control | 0.001 BTC | Sell 0.001 BTC | 0 BTC |
| Long shrinks between reads | 0.0004 BTC | Sell 0.001 BTC | -0.0006 BTC |
| Unchanged short control | -0.001 BTC | Buy 0.001 BTC | 0 BTC |
| Short shrinks between reads | -0.0004 BTC | Buy 0.001 BTC | 0.0006 BTC |
| Half-close after reduction | 0.0004 BTC | Sell 0.0005 BTC | -0.0001 BTC |
| Position increases control | 0.0012 BTC | Sell 0.001 BTC | 0.0002 BTC |
| Position is already flat | 0 BTC | No order | 0 BTC |

Every non-flat case captures an ordinary `ORDER_TYPE.MARKET` order. The helper
passes no reduce-only flag. The quantity and later side come from different
observations. The calculation for the long-reduction case is
`0.0004 - 0.001 = -0.0006 BTC`.

The unchanged-position controls close correctly, and the absent-position control
sends no order. This isolates the disagreement between reads rather than a
general direction or unit conversion error.

## Evidence

- [Reproduction script](../scripts/repro-close-race.cjs)
- [Recorded structured output](evidence/001-close-race.json)
- [Unchanged upstream modules and SHA256 digests](upstream/provenance.json)
- [Upstream MIT license](upstream/LICENSE)

To save a fresh run:

```sh
node scripts/repro-close-race.cjs --output /tmp/perpops-close-race.json
```

The structured output distinguishes captured order parameters from the arithmetic
model. It includes the source revision, SDK version, source digests and call order.

## Suggested correction and limits

Read the raw signed position once and derive both the close direction and desired
quantity from that observation. Apply the requested fraction to that current
absolute size, align to the lot grid and check the minimum. A second observation
can detect drift before signing and pause the close.

This addresses the demonstrated stale-quantity window. Reads and transaction
inclusion remain separate events. Without an exchange-enforced reduce-only
primitive, a client-side check cannot prevent every change made by liquidations
or another account writer after the final read. Use a dedicated account and
reconcile outstanding orders.

This report concerns the close helper's use of an older quantity despite a later
position response. A search of public reports does not establish first-report
status; the organizer must check duplicates and determine acceptance and severity.

## Environment

- Verified 2026-10-31 with Node.js 24.22.1.
- Official bot kit revision 4e75896896e024c03e2033d5920514f249998cd6.
- Harness SDK @somnia-chain/markets-sdk 0.32.1, viem 2.38.5, TypeScript 5.9.3.
- Venue context: DreamDEX perps on Somnia Hideki testnet, chain 50383.
- BTC fixture uses 8 base decimals, lot 1000 raw, minimum 13000 raw.
- Account 0x0000000000000000000000000000000000000001 is a fixture identifier.
  It is not funded or used for network calls.
- No transaction hash exists for this offline reproduction.

## November 1 reproduction on macOS

Node 24.18.0 reproduced all seven scenarios using the pinned helper. In the shrinking-long case, the mock trader received a sell for 100000 raw units despite the later read showing a long of 40000. [Captured inputs and order calls](evidence/001-close-mac.json)
