# Documented Shannon → Hideki USDso bridge route reverts during gas-quote preflight

**Severity:** normal  
**Area:** SDK  
**Status:** reproduced read-only; not submitted or accepted

## Summary

The documented Shannon → Hideki2 USDso bridge route cannot currently complete its advertised gas-quote preflight. On 2026-10-31, the SDK's Shannon USDso router reverted on `quoteGasPayment(50383)` while the other four Shannon routers returned zero at the same block. The USDso router alone has a nonzero configured hook. Its public interface strongly matches Hyperlane's `TestRecipient`, which does not implement the required post-dispatch hook interface.

This is a reproducible deployed-route/docs discrepancy. The precise configuration cause is an inference pending operator verification. This report does not establish that all ways to fund Hideki are unavailable.

## Context and impact

Perp developers using a dedicated EOA need native STT and USDso on Hideki2. The SDK registry's USDso destination token, `0xed7993A74dAe1e6656B704A424DcD8711aAf4F72`, is exactly the collateral returned by the current Hideki MarginBank's `getSystemConfig()`.

The official bridge guide lists USDso as live, uses USDso in its exchange bridge example, and says every router returns a zero gas quote. A client that implements the documented preflight encounters an empty revert instead. A client that assumes the documented zero quote can approve tokens before discovering a later dispatch failure. Our validation stopped before approving or broadcasting.

The public mint on Shannon succeeds in simulation, so the failure is distinct from the separate voucher-claim eligibility problem already reported by other developers.

## Environment

| Field | Value |
|---|---|
| SDK | `@somnia-chain/markets-sdk@0.32.1` |
| Source chain | Somnia Shannon, chain ID `50312` |
| Source RPC | `https://api.infra.testnet.somnia.network` |
| Destination | Hideki2, chain ID `50383`, `net_version` `50000259` |
| Source USDso router | `0x94E2E7f4B2B0a8E3032c7D3ff3c86790BB5979E6` |
| Source USDso token | `0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171` |
| Destination USDso router/token | `0xed7993A74dAe1e6656B704A424DcD8711aAf4F72` |
| Configured source USDso hook | `0xF11C364Da4B5e22b3040be8EA77DccDBfD1277De` |
| Quote reproduction block | `528513052` |
| Quote reproduction block hash | `0xb866da4efcc05fe8b3376f4a6bbb56e3e5275a0402ce9a753ebb80d582aa9af3` |

## Retained evidence

- [Block-pinned quote, hook, and enrollment responses](evidence/002-bridge-quote.json).
- [Supplementary zero-amount simulations and hook selector scan](evidence/002-router-simulations.json).
- [Two-chain funding prerequisites and public USDso mint simulation](evidence/002-funding-probe.json).
- [Alternative WETH mint and Hideki spot liquidity probes](evidence/002-weth-funding.json).

## Reproduction

The accompanying `scripts/repro-bridge-quote.mjs` uses only `eth_chainId`, `eth_getBlockByNumber`, and `eth_call`. It needs Node 24 and public network access. It does not load a key, sign, send a transaction, approve a token, claim funds, or alter chain state.

```sh
NODE_USE_ENV_PROXY=1 node scripts/repro-bridge-quote.mjs
```

By default the script selects the latest block, then pins every quote, hook,
and enrollment read to it. Use `--block 528513052` to reproduce the retained
observation on a node that still serves that historical block.

The `expectedFailureObserved` field is true only when USDso returns the recorded
empty revert, all four controls return zero and the block hash remains unchanged.
A false result can mean the route has changed; retain the full responses.

All quote, hook, and enrollment reads are pinned to one source block. The script checks that block's hash again before returning. Run it without `NODE_USE_ENV_PROXY=1` if your environment does not use an outbound proxy.

The minimal failing JSON-RPC call is:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "eth_call",
  "params": [
    {
      "to": "0x94E2E7f4B2B0a8E3032c7D3ff3c86790BB5979E6",
      "data": "0xf2ed8c53000000000000000000000000000000000000000000000000000000000000c4cf"
    },
    "latest"
  ]
}
```

Observed response:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":3,"message":"execution reverted","data":"0x"}}
```

Adding a fresh EOA as `from` gives the same result. This quote does not require a token balance or allowance.

## Expected and observed results

| Source route | `quoteGasPayment(50383)` | `hook()` |
|---|---|---|
| STT | `0` | zero address |
| USDso | empty revert | `0xF11C364Da4B5e22b3040be8EA77DccDBfD1277De` |
| WBTC | `0` | zero address |
| WETH | `0` | zero address |
| HBTT | `0` | zero address |

All five source routes remain enrolled. USDso's `routers(50383)` returns the expected destination router. The inverse destination enrollment also matches the source router. This rules out an obvious missing enrollment as the explanation for the quote failure.

As a supplementary diagnostic at block `528509576` (hash `0x3467e6161413cedcd9628abc2d50473ea580c50fa954a8e5b2751512f6da5311`), zero-amount `transferRemote` calls were simulated with `eth_call` from the same fresh EOA. STT, WBTC, WETH, and HBTT returned message IDs; USDso reverted. These were zero-amount simulations, not live dispatches or positive-amount bridge tests.

## Diagnostic inference: incompatible hook

The deployed hook bytecode exposes these ten selectors, all matching the official Hyperlane `TestRecipient` source and its inherited ownership methods:

| Selector | Function |
|---|---|
| `0xde523cf3` | `interchainSecurityModule()` |
| `0x256fec88` | `lastSender()` |
| `0x2113522a` | `lastCaller()` |
| `0xa4982fde` | `lastCallMessage()` |
| `0x56d5d475` | `handle(uint32,bytes32,bytes)` |
| `0xf07c1f47` | `fooBar(uint256,string)` |
| `0x0e72cc06` | `setInterchainSecurityModule(address)` |
| `0x8da5cb5b` | `owner()` |
| `0x715018a6` | `renounceOwnership()` |
| `0xf2fde38b` | `transferOwnership(address)` |

The bytecode selector scan did not find `hookType()`, `quoteDispatch(bytes,bytes)`, or `postDispatch(bytes,bytes)`. `hookType()` also reverts in a direct call. `TestRecipient` does not implement the post-dispatch hook interface. Hyperlane's `GasRouter.quoteGasPayment` uses the configured hook in its quote path.

This makes an incompatible configured hook a strong explanation. We have not established a byte-for-byte compiler match or traced a positive-amount transfer, so the report should not label the inferred contract identity as proven.

## Suggested resolution

1. Operators should verify the source USDso router's configured hook and restore a supported hook or the intended default, if the current address is unintended.
2. Add the USDso gas quote and hook-interface check to the live bridge health check. Return a route-specific unavailable status when preflight fails.
3. The SDK's execution path should obtain a current quote and stop before token approval if that quote fails. Static registry availability is not evidence that a deployed route is currently executable.
4. Update the bridge documentation to distinguish deployment-time verification from current route health, and explain the initial Shannon gas requirement for dedicated perp EOAs.

## Sources

The SDK revision is npm release `0.32.1` (the exact version pinned in this repository). Hyperlane interface comparisons are pinned to commit `0063de628aeddfd5fecec6ca4719f7944223c1bd`, dated 2026-10-30. These sources describe the expected interface, not proof of the deployed hook's compiler identity.

- Official current bridge guide: https://prd.smk.somnia.host/docs/typescript/bridge
- Official chains walkthrough: https://prd.smk.somnia.host/docs/typescript/chains-walkthrough
- Official token funding guide: https://prd.smk.somnia.host/docs/typescript/how-to/get-testnet-funds
- Official perp network and collateral: https://app.testnet.dreamdex.io/docs/developers/perps-testnet
- Published SDK package: https://www.npmjs.com/package/@somnia-chain/markets-sdk/v/0.32.1. `src/chains/bridge/registry.ts`, `src/chains/bridge/abi.ts`, and `docs/BRIDGE.md`
- Hyperlane recipient source: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/0063de628aeddfd5fecec6ca4719f7944223c1bd/solidity/contracts/test/TestRecipient.sol
- Hyperlane hook interface: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/0063de628aeddfd5fecec6ca4719f7944223c1bd/solidity/contracts/interfaces/hooks/IPostDispatchHook.sol
- Hyperlane quote implementation: https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/0063de628aeddfd5fecec6ca4719f7944223c1bd/solidity/contracts/client/GasRouter.sol

## Scope and duplicate check

No live bridge transfer was attempted, so delivery and relayer liveness remain unverified. A different bridged asset followed by a legitimate Hideki spot trade may still provide collateral. This report is about the documented USDso route's quote preflight and diagnostic hook mismatch.

On 2026-10-31, no equivalent report was found in the inspected public findings of PhiBao/dreamdex-perps-feedback (15), Bortlesboat/dreamdex-perps-feedback (2), DanhCaTuanNgoc/lucid-perps (15), or DreamCat's SDK feedback. That does not rule out private or unpublished reports.
