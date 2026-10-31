# Funding a dedicated DreamDEX testnet account

PerpOps needs **STT for gas and USDso deposited into the Hideki2 MarginBank**. The current adapter trades from one dedicated EOA. An app wallet's paper margin belongs to that app wallet and cannot fund an unrelated EOA merely by linking a bot.

The live checks below were performed on 2026-10-31 without signing or sending transactions. The project's disposable validation address is:

```text
0x46A99DD5a6852c10D7640f12081A978ADD9D5CD3
```

The first required external step is to receive free **Shannon testnet STT** at this address, through a legitimate faucet. Once gas is available, a WETH bridge and spot conversion provide a plausible self-service collateral route. Its mint, route configuration, and destination order book were checked; actual bridge delivery and the complete funding sequence remain untested.

## Network identity matters

| Network | Chain ID | `net_version` | Purpose | RPC |
|---|---:|---|---|---|
| Somnia Shannon | 50312 | `50312` | Initial faucet, test-token mint, bridge origin | `https://api.infra.testnet.somnia.network` |
| Somnia Hideki2 | 50383 | `50000259` | DreamDEX perp execution and margin | `https://api.hideki2.infra.testnet.somnia.network` |

The older Hideki1 also reports chain ID 50383 and reuses deployed addresses, but has network ID `50000258`. The SDK's bridge registry documents this distinction. PerpOps requires both chain ID 50383 and network ID `50000259` on reads, order preparation, broadcast, and receipt reconciliation. Shannon is a funding origin only; the execution adapter rejects it.

Official references: [perp developer guide](https://app.testnet.dreamdex.io/docs/developers/perps-testnet), [chains walkthrough](https://prd.smk.somnia.host/docs/typescript/chains-walkthrough), and the pinned SDK `@somnia-chain/markets-sdk@0.32.1`, `src/chains/bridge/registry.ts`.

## What was verified

| Check | Observed result | Evidence |
|---|---|---|
| New project address on both chains | Zero native and USDso balances | [Two-chain probe](../feedback/evidence/002-funding-probe.json) |
| Shannon USDso public mint | `mint(address, 100e18)` succeeds in `eth_call` | [Two-chain probe](../feedback/evidence/002-funding-probe.json) |
| STT bridge | Reciprocal route enrollment, zero delivery quote, funded destination router | [Two-chain probe](../feedback/evidence/002-funding-probe.json) |
| Direct USDso bridge | Source gas quote reverts; four other source routes return zero | [Bridge feedback](../feedback/002-usdso-bridge-quote.md) |
| Shannon WETH mint | Direct `mint(address, 0.05e18)` and the documented token faucet both succeed in `eth_call` | [WETH probe](../feedback/evidence/002-weth-funding.json) |
| WETH bridge | Gas quote returns zero; zero-amount dispatch simulation succeeds | [Router comparison](../feedback/evidence/002-router-simulations.json) |
| Hideki WETH/USDso market | Correct bridged WETH and perp collateral tokens; live bids sufficient for 0.05 WETH at the observed block | [WETH probe](../feedback/evidence/002-weth-funding.json) |

An `eth_call` success does not mint tokens, establish relayer delivery, or prove a later funded transaction will succeed. Market prices, liquidity, fees, and network state must be read again before any execution.

## Initial gas: the remaining external step

The official SDK [funding guide](https://prd.smk.somnia.host/docs/typescript/how-to/get-testnet-funds) lists Shannon faucets. Current practical observations are:

| Faucet | What a developer must do | Current limitation |
|---|---|---|
| [Google Cloud Somnia Shannon faucet](https://cloud.google.com/application/web3/faucet/somnia/shannon) | Open the faucet, complete its interactive account/verification flow, and enter the public address above | The unauthenticated page exposes Google sign-in. No faucet request was completed in this build session. |
| [Thirdweb Shannon faucet](https://thirdweb.com/somnia-shannon-testnet) | Use a logged-in wallet session and complete Turnstile verification | The public UI advertises 0.01 STT/day; its eligibility can additionally require a paid plan. This is below the current adapter's observed 0.06 STT transaction admission envelope. |
| [Stakely Shannon faucet](https://stakely.io/faucet/somnia-testnet-stt) | Complete CAPTCHA and publish the request ID on X | It advertises 0.001 STT per request. No message or post was sent. |
| [Somnia testnet hub](https://testnet.somnia.network/) | Follow its current supported funding links | The fetched page and its public assets exposed no faucet form. The older `faucet.somnia.network` endpoint returned HTTP 503. |

Google's [faucet FAQ](https://cloud.google.com/application/web3/faucet/story/aeneid) describes limits per Google account and recipient address. The official [Somnia developer FAQ](https://docs.somnia.network/developer/deployment-and-production/support-and-community/developer-faqs) also lists Google Cloud as a test-token source.

A practical target is about **1 STT on Shannon**, subject to fresh fee checks. No mainnet token, purchase, or bridge from mainnet is required. No publicly documented unattended faucet for an empty new EOA was verified. We did not create an identity, bypass verification, or contact organizers to obtain funds.

Check the public address without loading its private key:

```sh
PERPOPS_ACCOUNT=0x46A99DD5a6852c10D7640f12081A978ADD9D5CD3 NODE_USE_ENV_PROXY=1 npm run doctor
```

This doctor reads Hideki2. A Shannon faucet claim will not appear as Hideki gas until the STT bridge delivers.

## Proposed funding route after Shannon gas arrives

The direct USDso route is currently unsuitable: its documented preflight reverts. Use a different supported route only after fresh validation. The following is a concrete bounded plan, **not an executed runbook result or a command currently implemented by PerpOps**.

| Step | Chain | Operation | Proposed bound |
|---|---|---|---|
| 1 | Shannon | Mint test WETH using the official test-token faucet | 0.05 WETH |
| 2 | Shannon → Hideki2 | Bridge native STT to the same project address | At most 0.5 STT, after reserving source gas |
| 3 | Shannon | Approve WETH only to its official source bridge router | Exactly 0.05 WETH |
| 4 | Shannon → Hideki2 | Dispatch WETH and wait for destination delivery | 0.05 WETH |
| 5 | Hideki2 | Approve the WETH/USDso spot pool and sell the delivered WETH using a bounded IOC | At most the actual delivered balance, with a fresh limit price and deadline |
| 6 | Hideki2 | Check the resulting wallet USDso and approve the MarginBank | At most 100 USDso, or less if the sale receives less |
| 7 | Hideki2 | Deposit approved USDso into the MarginBank | The verified available amount, capped at 100 USDso |
| 8 | Hideki2 | Run doctor, then the project's separately bounded BTC-PERP validation | No existing positions, resting orders, or pending wallet transaction |

At Hideki block `37722234`, WETH/USDso bids were 2239.87 USDso/WETH for 0.0447 WETH, followed by 2238.73 for 0.0551 WETH. Selling 0.05 WETH against that snapshot would receive approximately 112 test USDso before any fees. This is a historical sizing example; it is not a promise of execution or proceeds.

### Exact contracts for the proposed route

| Contract | Address |
|---|---|
| Shannon test-token faucet | `0x89Ebc05dE83aB9752B95030218BB10A542b96B7C` |
| Shannon WETH token, 18 decimals | `0x4d8E02BBfCf205828A8352Af4376b165E123D7b0` |
| Shannon WETH bridge router | `0x41C21248D6CC3883cd577D0eFEF3585b1358A8B2` |
| Hideki2 WETH token/router, 18 decimals | `0x56115cB05652Ac6117Caa1152B630986a51d36b5` |
| Shannon STT bridge router | `0x67CD0778A719099DAF2D346aD0Db0d9E6FF6674C` |
| Hideki2 STT bridge router | `0xB04373932bc05347757da6b8a226d7657584aB35` |
| Hideki2 WETH/USDso spot pool | `0xfd87d984bcdd276c3c411c2590acb6a7ff8ab4ff` |
| Hideki2 USDso token, 18 decimals | `0xed7993A74dAe1e6656B704A424DcD8711aAf4F72` |
| Hideki2 MarginBank | `0x478769E1177C0773c43A593DCCc4Ad15F15F1394` |

The documented faucet call is `requestTokens(address[] tokens, uint256[] amounts)`. The WETH probe used `[0x4d8E02BBfCf205828A8352Af4376b165E123D7b0]` and `[50000000000000000]`. The official [quick-start guide](https://app.dreamdex.io/docs/welcome/quick-start) identifies the faucet and interface; the current pinned SDK bridge registry identifies the token and router addresses.

For bridge preparation, the SDK's pure `createBridgeTransfer` helper returns unsigned approval and dispatch steps. Source transaction success means dispatch only. Wait for the destination router's `ReceivedTransferRemote` event or another canonical delivery check before spending the destination balance. Observe the actual balance after every step and stop on an unknown receipt.

The SDK's default bridge sender uses a 0.6 STT admission envelope before transaction value. At the observed current gas price of 6 gwei, PerpOps' 10-million-gas legacy envelope is 0.06 STT. A funding implementation must choose its transaction fee bounds from fresh network data and available funds; it must not assume that a 1 STT faucet claim can pay a 0.5 STT bridge value plus the SDK's default 0.6 STT ceiling. Never load funding transactions into the BTC-only execution adapter.

## Alternative: an app wallet with a linked bot

The official [Link a Bot guide](https://app.testnet.dreamdex.io/docs/trading/common/link-a-bot) supports a bot using its own key while trading a selected app wallet's margin through `placeOrderFor`. Linking can also transfer STT from the app wallet to the bot. The owner must sign in and grant per-market access; a public address alone is not authorization.

The [Arena rules](https://app.testnet.dreamdex.io/competition) state that registered app wallets receive weekly paper USDso and STT. Arena rewards have separate conditions; they are not prerequisites for developing this bounty project. Keep any externally minted developer collateral separate from an Arena wallet because the Arena rules restrict outside paper funds.

**This operator route is not implemented in the current PerpOps adapter.** The adapter intentionally requires the account address to match its dedicated signer. Supporting a linked app wallet would require a separate owner identity for snapshots, operator permission validation, and the verified `placeOrderFor` call; sharing the app wallet's key is unnecessary.

The plain EOA voucher path remains a separate known limitation: a clean account can be reported eligible while `claim()` reverts. That issue is already covered by [another developer's report](https://github.com/PhiBao/dreamdex-perps-feedback/blob/main/feedback/002-voucher-claim-eligibility.md). It is not presented as a new finding here.

## Current validation boundary

The repository includes real read-only chain evidence, an adapter with offline signing/broadcast fixtures, and a new live bridge-preflight reproduction. It does not yet contain evidence of a funded live opening and closing trade. That final validation needs initial faucet gas, coordinated transaction limits, successful bridge delivery, and a funded account check.
