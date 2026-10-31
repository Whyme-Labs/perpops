# Standalone submission verification

Verified on 2026-10-31 with Node.js 24.22.1.

| Check | Result |
| --- | --- |
| TypeScript | `npm run typecheck` passed |
| Automated suite | 56 tests passed, none failed or skipped |
| Browser | Nine workflow checks passed against the actual local HTTP service |
| Desktop and mobile | 1440px and 375px, no horizontal overflow or browser errors |
| Process interruption | Real SIGKILL tests before send and after simulated venue commit recover persisted transaction identity |
| Explicit rebroadcast | Ten tests cover original bytes/hash/nonce, expiry, read-only recovery, account drift, receipt errors, concurrent retries and changed confirmation evidence |
| Network identity | Three added regressions reject the older Hideki network despite its identical chain ID and contract addresses |
| Close-helper feedback | Seven scenarios passed against unchanged pinned upstream functions, including four controls and three modeled zero crossings |
| Bridge feedback | Independently reproduced at Shannon block 528513052; USDso quote reverts, four control routes quote zero, canonical hash unchanged |
| Actual DreamDEX RPC | Hardened read-only doctor passed at Hideki2 block 37728161 |
| Recorded demo | 100-second H.264 video, 1920x1080, with persistent simulation label |
| Live testnet orders | Not performed; the dedicated account has zero gas and margin |

## Evidence

- [Raw local test output](test-output.txt)
- [Browser verification](browser-verification.json)
- [Read-only testnet observation](testnet-readiness.json)
- [Close-helper reproduction](../feedback/evidence/001-close-race.json)
- [Pinned bridge observations](../feedback/evidence/002-bridge-quote.json)
- [Demo and reproduction instructions](demo-script.md)

The browser suite exercises missing acknowledgements, same-ID replay, receipt
export, separate close intents, partial fills, blocked prices, stale reads, the
new saved-transaction resend and the mobile workflow. The captured video verifies
its own API outcomes before each chapter proceeds.

## Review

An independent correctness review found no P1/P2 issue in the new rebroadcast
path. Two additional regression cases now cover a changed confirmation and a
deadline that expires during an awaited account read.

A separate specification review verified that the feedback fixture files match
the pinned upstream checkout byte for byte, their SHA256 values match, the
reproduction output matches retained evidence, and the report separates observed
order parameters from modeled full-fill effects. Its minor wording corrections
were applied.

## Boundaries

The reports are prepared for submission, not accepted or submitted. The
application's recorded demonstrations are local simulations. Live read-only
checks do not establish funded execution, bridge delivery or trade profitability.

Initial faucet access, repository access for judges, and the DoraHacks email
whitelist remain external actions. The MVP additionally needs real testnet order
receipts and published project-update links. See [submission.md](submission.md)
and [funding.md](funding.md).

All automated app checks ran locally. No hosted CI, real-money trade, organizer
message, public post or competition submission was performed.
