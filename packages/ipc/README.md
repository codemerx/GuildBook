# @app/ipc

The RPC runtime and the contracts between the processes (ADR 0012, IMPLEMENTATION.md §2.8).

- `endpoint.ts`: `RpcEndpoint` over a `MessagePort`. Requests, cancellation, subscriptions, progress and events, with
  every message checked against its contract. Invalid messages get typed errors and the endpoint keeps running (A1.5).
- `contract.ts`: `defineContract`, queries, commands and events with Zod input and output schemas.
- `contracts/`: `deviceApi` (renderer ↔ main), `instanceApi` (renderer ↔ a worker), `workerApi` (main ↔ a worker),
  `deviceServicesApi` (a worker → main) and the view types the renderer shows (Step 7: `instruction-views.ts` for the
  Instructions page and the Doctor; Step 8: `projection-views.ts` for the local prefix and the projected copies).
- `@app/ipc/test-api`: the test API of test-hooks builds (TESTING.md §6). The app imports it only behind
  `__TEST_HOOKS__`, so production builds don't contain it (A1.6).

- **Imports:** `schemas`, `brand`.
