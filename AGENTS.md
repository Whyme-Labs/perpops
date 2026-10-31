# PerpOps development

Run commands from this repository root with Node.js 24 or later. Use `npm ci`
and `npm run check`. Browser checks use `npm run test:browser`. Run verification
locally; do not add or trigger hosted CI without a task that needs it.

Keep base amounts and prices in exact integer units. Validate inputs at boundaries.
The journal must commit signed bytes before broadcasting. An unknown receipt never
authorizes a new nonce or replacement order. Keep simulation and testnet evidence
separate. Never include keys, signed bytes, environment files or live databases in
commits or exported evidence.

One dedicated account, one local journal and one execution writer are required.
The ordinary DreamDEX IOC ABI has no native reduce-only flag. Do not promise
unconditional exactly-once effects, no overshoot, or maximum-loss protection.

Feedback reproductions must name their pinned upstream revision, control inputs,
observed output and limits. Do not claim an offline model is an on-chain trade.
