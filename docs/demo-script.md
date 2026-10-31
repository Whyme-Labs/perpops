# PerpOps demonstration

The video is a roughly 100-second walkthrough of the actual PerpOps workbench and local execution service. It uses a fresh, isolated simulation account. It does not place blockchain orders or establish DreamDEX testnet execution.

The persistent label at the top of the video identifies this scope. Captions describe the actions and results. The recording script checks each result against the API before it proceeds.

## Watch

[Captioned demonstration](demo.mp4)

## Narrative

| Time | What the viewer sees | Point to make |
| --- | --- | --- |
| 00:00 to 00:10 | The workbench, local simulation label, empty account and target composer | The user specifies a total position. The application records an execution intent. |
| 00:10 to 00:22 | Run recovery demo creates an uncertain intent after a controlled missing acknowledgement | A missing response leaves the transaction outcome uncertain. The persisted intent and transaction hash remain available. |
| 00:22 to 00:32 | Original transaction hash and the uncertain execution timeline | The simulated exchange has executed one order. The account has 0.001 BTC. |
| 00:32 to 00:46 | Recover intent resolves the original transaction | Reconciliation reads the transaction receipt and sufficiently recent account state. The transaction count stays at one. |
| 00:46 to 00:58 | Retry same request reuses the original intent ID | The request ID, transaction hash, transaction count and 0.001 BTC position remain unchanged. |
| 00:58 to 01:12 | Export receipt downloads JSON, then the receipt viewer opens | The export includes the intent, order, transaction receipt and events. It omits private keys and signed transaction payloads. |
| 01:12 to 01:30 | Prepare close sets a zero target; the user reviews the price and submits | Closing is a separate intent with a bounded price. The demo records its execution separately. |
| 01:30 to 01:40 | The account returns to zero with two intents and two transactions | Recovery reused the first transaction. A separate close changed the position to zero. |

## Suggested spoken narration

PerpOps lets a trader or agent request a target position and inspect what happened to that instruction. This demonstration uses the local simulator, with fictional prices and balances.

I will run a recovery scenario with a target of 0.001 BTC. The simulator executes the order, then deliberately drops its acknowledgement. The intent becomes uncertain. PerpOps has already persisted the transaction hash, so it has a concrete transaction to investigate.

Recover intent checks the receipt and reconciles account state. The intent completes. There is still one transaction and the position remains 0.001 BTC.

Now I retry the same request. The intent ID and transaction hash stay the same. The retry does not create an additional order in this scenario.

I can export the receipt to inspect the instruction, transaction and recovery timeline. The export excludes private keys and signed transaction payloads.

Finally, I prepare a zero target, review its sell limit and submit a separate close intent. The position returns to zero. The history records two instructions and two transactions.

This demonstrates recovery behavior in the local simulator. DreamDEX testnet execution needs its own transaction evidence.

## Reproduce the recording

Run from the repository root with Node 24 or newer. FFmpeg must be on `PATH` with the `libass` subtitle renderer and H.264 encoder available.

```sh
npm ci
npx playwright install chromium
node scripts/record-demo.cjs
```

To use an existing Chromium executable:

```sh
PERPOPS_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell node scripts/record-demo.cjs
```

The default output is `docs/demo.mp4`. The script also updates the screenshots in `docs/screenshots/`. Temporary account state, raw footage and caption files stay in the operating system's temporary directory and are removed after recording.

A short rehearsal uses the same interactions and assertions with shorter pauses:

```sh
node scripts/record-demo.cjs --speed 5 --output demo-rehearsal.mp4
```

The recorded page permits requests only to the isolated local application. The script explicitly selects simulation mode and does not load a private key or a wallet configuration.

## What the recording verifies

- The controlled missing acknowledgement leaves one transaction and a 0.001 BTC position.
- Recovery preserves the original transaction hash and completes the original intent.
- Repeating the same request preserves the intent count, transaction count and position.
- The receipt is valid simulation JSON and omits private keys and serialized signed transactions.
- Closing creates a distinct intent and returns the position to zero.
- The mobile page has no document-level horizontal overflow at 375 pixels.

These checks describe the recorded scenario. They do not establish a guarantee against trading losses, all possible infrastructure failures, or changes made by another account writer.

## Screenshots

- [Workbench overview](screenshots/overview.png)
- [Uncertain intent](screenshots/uncertain-intent.png)
- [Recovered intent](screenshots/recovered-intent.png)
- [Closed position](screenshots/closed-position.png)
- [Mobile workbench](screenshots/mobile.png)
