# Draft project updates

These are drafts only. None has been posted. Add genuine published links to the
README's X posts section after posting. The current wording describes completed
local work and does not claim live testnet orders.

## Build

Building PerpOps for @DreamDEXSomnia: set a target position, persist the signed transaction, and reconcile its receipt after a timeout. The local workbench has fault injection, a recovery timeline and receipt export. Repo: https://github.com/Whyme-Labs/perpops

## Demonstration

Our PerpOps simulation fills an order, drops the reply, then recovers the original transaction. Replaying the request keeps one hash and one execution. The 100-second demo is in the repo. Live testnet trade evidence is still pending. @DreamDEXSomnia

## Reproducible feedback

PerpOps now includes reproducible feedback for @DreamDEXSomnia: an offline close-helper sizing case and read-only USDso bridge checks. Reports separate captured behavior from inferred effects, with source revisions, block data and controls. https://github.com/Whyme-Labs/perpops
