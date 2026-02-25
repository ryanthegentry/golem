# Ark SDK Issues to File

Issues encountered during Golem development against `@arkade-os/sdk@0.3.13` on Node.js v25.5.0 (macOS, ESM).

---

## 1. Race condition: intent registration before SSE connection causes missed `batch_started` events

**Title:** `Wallet.settle()` registers intent before SSE stream connects, causing `batch_failed` on fast-responding servers

**Environment:**
- `@arkade-os/sdk`: 0.3.13
- Node.js: v25.5.0 (ESM, `eventsource` v4.1.0 polyfill)
- Ark server: mutinynet (`https://mutinynet.arkade.sh`), sessionDuration=60s
- OS: macOS (Darwin 24.6.0)

**Reproduction steps:**
1. Create a wallet with a funded boarding UTXO
2. Call `wallet.settle()` (no params — auto-discovers boarding UTXOs)
3. Observe the SSE event stream

**Expected behavior:**
The SSE stream should receive `batch_started`, the handler should call `confirmRegistration()`, and the batch should proceed through `tree_tx → tree_signing_started → tree_nonces → tree_signature → batch_finalization → batch_finalized`.

**Actual behavior:**
The SSE stream receives `streamStarted` (connection opened), then immediately `batch_failed` with reason:
```
INTERNAL_ERROR (0): not enough intent confirmations received
```
No `batch_started` event is ever received.

**Root cause:**
In `Wallet.settle()` (wallet.js), the intent is registered *before* the SSE EventSource is created:

```js
// wallet.js ~line 734-742
const intentId = await this.safeRegisterIntent(intent);  // ← server sees intent
// ... setup topics and handler ...
const stream = this.arkProvider.getEventStream(signal, topics);  // ← SSE connects
return await Batch.join(stream, handler, ...);
```

The server may start a batch round immediately after receiving the intent. If the `batch_started` event is emitted before the SSE connection is established (~100-500ms for DNS + TLS + HTTP), the client never receives it. The server waits for `confirmRegistration()` which never comes, and the batch fails.

Additionally, the `Batch.join` state machine has no `onBatchFailed` handler in the wallet's `createBatchHandler()`, so ANY `batch_failed` event (including from other batches) causes an immediate throw rather than waiting for the next batch round.

**Error output:**
```
Unknown event type: { streamStarted: { id: '...' } }
[event] batch_failed {"type":"batch_failed","id":"...","reason":"INTERNAL_ERROR (0): not enough intent confirmations received"}
Error: INTERNAL_ERROR (0): not enough intent confirmations received
    at Object.join (wallet/batch.js:92:27)
    at Wallet.settle (wallet/wallet.js:743:32)
```

**Workaround:**
Use a fresh wallet (no prior failed intents). Failed settle attempts can leave the intent in a dirty state on the server (despite the `deleteIntent` cleanup in the catch block). Creating a new wallet with `MockSigner.create()` and re-funding avoids the stale intent problem.

For production, we plan to:
- Add retry logic with exponential backoff around `settle()`
- Catch `batch_failed` events and re-register the intent for the next round

**Suggested fix:**
Connect the SSE EventSource *before* calling `registerIntent()`:

```js
// Connect first
const stream = this.arkProvider.getEventStream(signal, topics);
// Wait for streamStarted or a small delay to ensure connection
// Then register
const intentId = await this.safeRegisterIntent(intent);
// Join
return await Batch.join(stream, handler, ...);
```

The topic list for the SSE stream can be computed from inputs and signing keys before intent registration — the `intentId` is only needed by the handler, not by the stream setup.

Also consider adding an `onBatchFailed` handler to `createBatchHandler()` that ignores failures for batches the client isn't participating in, rather than throwing unconditionally.

---

## 2. `EventSource is not defined` in Node.js — no polyfill guidance

**Title:** SDK crashes with `ReferenceError: EventSource is not defined` in Node.js; needs polyfill documentation

**Environment:**
- `@arkade-os/sdk`: 0.3.13
- Node.js: v25.5.0 (ESM)
- OS: macOS (Darwin 24.6.0)

**Reproduction steps:**
1. Install `@arkade-os/sdk` in a Node.js project
2. Create a wallet and call any method that participates in a batch round: `wallet.settle()`, `Ramps.onboard()`, `VtxoManager.renewVtxos()`
3. Do NOT install or configure an EventSource polyfill

**Expected behavior:**
Either:
- The SDK should work in Node.js without extra setup, OR
- The SDK should provide a clear error message indicating that an EventSource polyfill is required, OR
- The README/docs should document the Node.js setup requirement

**Actual behavior:**
The SDK crashes with an unhandled `ReferenceError`:

```
ReferenceError: EventSource is not defined
    at RestArkProvider.getEventStream (providers/ark.js:230:37)
    at getEventStream.next (<anonymous>)
    at Object.join (wallet/batch.js:57:26)
    at Wallet.settle (wallet/wallet.js:743:32)
```

Line 230 of `ark.js`:
```js
const eventSource = new EventSource(url + queryParams);
```

`EventSource` is a browser API (Server-Sent Events). It is not available in Node.js. The SDK assumes it exists on `globalThis`.

**Workaround:**
Install the `eventsource` npm package (v4+) and set it on `globalThis` before any SDK method that uses batch rounds:

```bash
npm install eventsource
```

```typescript
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

// Now SDK batch operations work
import { Wallet } from '@arkade-os/sdk';
```

**Important:** With ESM, `import` statements are hoisted and executed before module body code. The polyfill assignment `(globalThis as any).EventSource = EventSource` runs after all imports resolve. This is fine because the SDK only calls `new EventSource()` at runtime (inside `getEventStream()`), not at import time.

**Suggested fix:**
Option A: Accept an `EventSource` constructor in the SDK configuration:
```typescript
const wallet = await Wallet.create({
  identity,
  arkServerUrl: '...',
  eventSourceConstructor: EventSource,  // optional, defaults to globalThis.EventSource
});
```

Option B: Document the polyfill requirement in the README for Node.js users.

Option C: Bundle a lightweight SSE client internally (e.g., using `fetch` with streaming, which Node.js supports natively since v18).
