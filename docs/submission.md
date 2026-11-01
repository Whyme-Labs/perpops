# DreamDEX bounty submission package

## Current status

The standalone application, local recovery demonstration and reproducible
feedback materials are complete. The feedback reports can be reviewed and
submitted without a funded trading account. The MVP still needs genuine testnet
order evidence before it meets the event's stated execution requirement.

DoraHacks published [PerpOps Build #50740](https://dorahacks.io/build/50740) and confirmed hacker registration. On November 1 at 13:56 Malaysia time, the event rejected the Feedback submission with the message “You are not in the whitelist for this hackathon”. The entry has no review receipt. The organizer must whitelist the registered DoraHacks email before the build can be resubmitted.

Public repository: https://github.com/Whyme-Labs/perpops

Judge page: https://perpops-feedback.pages.dev/

The judge page serves both reports, the raw November 1 evidence, a standalone reproduction ZIP and the captioned simulation video. A clean Chrome session retrieved all four downloads and verified their SHA256 hashes against the local files.

## Feedback submission text

### Title

PerpOps: reproducible DreamDEX execution and funding feedback

### Description

While building a durable position executor for DreamDEX, we investigated two
behaviors that affect builders trying to close positions and fund test accounts.
Each report contains exact steps, expected and observed behavior, controlled
comparisons, source or block provenance, and a script that reproduces the result.

1. The official bot kit's close helper can retain a quantity from an earlier
   preview while using the direction from a later position response. An offline
   invocation of the unchanged upstream helper captures an oversized close after
   the position shrinks. Seven scenarios include unchanged long/short controls,
   a partial close and an already-flat account. Resulting exposure is explicitly
   an arithmetic model, not an observed blockchain execution.
2. The documented Shannon-to-Hideki USDso bridge quote reverts while other token
   routes return successfully at the same pinned block. The report includes raw
   read-only RPC observations, control routes and the applicable network identity.
   The configured hook's interface is a diagnostic lead, not a proven root cause.

The accompanying PerpOps workbench demonstrates why execution needs persistent
transaction identity and authoritative account reconciliation. Its simulation
video is supplementary product context. It is not transaction evidence for
either feedback item.

### Report links

- [Close helper report](../feedback/001-close-position-stale-quantity.md)
- [USDso bridge quote report](../feedback/002-usdso-bridge-quote.md)
- [Offline close reproduction](../scripts/repro-close-race.cjs)
- [Read-only bridge reproduction](../scripts/repro-bridge-quote.mjs)
- [Verification](verification.md)

### Reproduction commands

```sh
npm ci
npm run feedback:close
npm run feedback:bridge
```

The close reproduction is offline after dependency installation. The bridge
reproduction performs read-only calls to the official public RPC. Historical
blocks can be unavailable on a non-archive endpoint; retain the recorded evidence
and use the script's documented latest-state option to check whether behavior has
changed.

## MVP description draft

### Title and tagline

PerpOps: recover interrupted DreamDEX trades before attempting another order.

### Who it is for

Bot builders and traders who operate a dedicated DreamDEX testnet account and
need a clear record of what happened when a request times out or a process stops.

### Problem

A timeout does not reveal whether an order reached the exchange. A bot that
creates another order from stale position data can trade more than intended.
Recovery must preserve the original transaction identity, inspect its canonical
receipt, and wait for sufficiently recent account state.

### What PerpOps does

The user specifies a total BTC position, an absolute position limit, a bounded
execution price and a deadline. PerpOps records the instruction in SQLite and
persists the signed transaction before broadcasting it. Repeating an instruction
ID resumes its existing record. Conflicting contents under that ID are rejected.

Unknown outcomes block competing instructions. Once a receipt is confirmed,
PerpOps reconciles the position at or beyond that block. A partial fill requires
an explicit resume before the remaining quantity is prepared. An explicit resend
can reuse the original signed transaction before its deadline, subject to fresh
account checks. It does not create a new nonce or replace the order.

The local interface has a fault lab, account and intent views, an event timeline,
receipt export and a deliberate close flow. The DreamDEX adapter uses the official
SDK's order ABI with exact integer units and pinned on-chain account reads.

### Demonstration and evidence

- [100-second captioned simulation video](demo.mp4)
- [Narrative and reproduction instructions](demo-script.md)
- [Screenshots](screenshots/)
- [Automated verification](verification.md)
- [Read-only testnet observation](testnet-readiness.json)

**Live testnet orders are pending.** Before using this text for an MVP entry, add
actual opening and closing transaction hashes, an exported execution receipt and
the resulting account state. Do not substitute the simulator's hashes.

### Limits

One dedicated account and one execution writer are required. The verified
ordinary IOC ABI has no native reduce-only flag. The final account read and
transaction inclusion are not atomic. The application does not promise maximum
loss protection or unconditional exactly-once exchange effects.

## Submission actions outside the build

- Repository access for judges is complete. The two Feedback reports and reproduction code are public.
- Obtain whitelist confirmation for the registered email through the organizer’s official process.
- Submit the feedback report files and their evidence through the bounty's
  Feedback track. Acceptance, duplicates and severity are the organizer's decision.
- For an MVP entry, complete the funded testnet execution in [funding.md](funding.md),
  capture real order evidence, and publish the required project updates. Drafts
  are in [social-posts.md](social-posts.md).

## Requirements sources

- [Bounty page](https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail)
- [Organizer listing and whitelist instructions](https://www.eventbrite.com/e/dreamdex-perps-builder-bounty-tickets-2003605109819)
- [Public copy of detailed rules](https://github.com/DanhCaTuanNgoc/lucid-perps/blob/main/hackathon_details.md)

On November 1, the official DoraHacks event page was checked in Chrome. It confirms the GitHub requirement, the per-item Feedback format and the whitelisted-email requirement. MVP entries also need real Tokyo testnet perp orders and links to two or three X posts tagging DreamDEX. The account registration form requires a public EVM reward address on Somnia mainnet.

The event page shows two times. Its written timeline gives November 1 at 23:59 UTC (November 2 at 07:59 in Malaysia). Its event widget lists an extension to November 15 at 22:30 in Malaysia. Use the earlier cutoff unless the organizer confirms that the extension applies to the bounty.
