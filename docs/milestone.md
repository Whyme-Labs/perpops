# PerpOps first milestone

Build the standalone PerpOps application in Whyme-Labs/perpops. A user sets a BTC position target,
an absolute quantity limit, a limit price and a deadline. The executor persists
the instruction and signed transaction before broadcast, reconciles receipts
and account state, and recovers an interrupted operation without blindly
creating a second trade. Use one dedicated account, one market and one writer.

Deliver a local server and responsive interface, a durable SQLite journal,
an exchange simulator with deliberate faults, a DreamDEX Hideki testnet adapter,
a CLI, reproducible recovery tests, setup instructions and honest status.
No mainnet operations, profit claims, guaranteed loss limits or unverified live
execution evidence. No background remote CI is needed for this milestone.

Acceptance conditions:

- Duplicate request IDs with identical payload resume the same intent.
- Reusing an ID with another payload fails before any trade.
- Signed bytes and transaction hash survive a process crash after broadcast.
- Unknown receipts block new orders and block competing intents.
- After confirmation, account reads must be at or beyond the receipt block.
- Independent pending buy/sell exposure is included in quantity limits.
- Partial IOC fills can resume only after authoritative reconciliation.
- Deadline expiry never erases an unresolved transaction.
- Only one process can execute against a journal at a time.
- Local simulation is visibly distinguished from testnet activity.
- Exported receipts exclude private keys and signed transaction bytes.
- Real testnet execution is reported only when genuine receipts exist.

## Standalone submission milestone

- Run the existing application from the repository root with no parent-project dependency.
- Add explicit saved-transaction rebroadcast with receipt, account, deadline and read-only checks.
- Keep a signed transaction's bytes, hash and nonce unchanged across every resend.
- Add a reproducible browser recording and a judge-oriented submission description.
- Produce feedback reports only for independently reproduced upstream behavior.
- Keep pending external access and live-order requirements visible.
