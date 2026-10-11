# Load testing

Status: **as built in Phase 15** (ADR-053). Results and the capacity model derived from them:
[capacity.md](capacity.md).

## 1. The harness (`tests/load`)

```
pnpm --filter @tessera/load build        # bundles the harness (and the web client code it reuses)
TEST_DATABASE_URL=… TEST_VALKEY_URL=… TEST_S3_URL=… \
  node tests/load/dist/cli.js <scenario> [options]
```

The coordinator (`src/cli.ts`):

1. starts the services **from their production builds** (`pnpm build` first): N API processes
   and M realtime processes ("pods") on a fresh `tessera_load` database and the given Valkey,
   configured as in production apart from per-run secrets (`src/stack.ts`). Ports are below
   32,768, outside Linux's ephemeral range;
2. seeds accounts straight into the database — users, verified e-mail, default privacy
   settings, an active session (only the token's SHA-256 is stored, as the API stores it), a
   device and keys, and direct conversations pairing them (`src/seed.ts`). Seeding is the only
   step that bypasses the API; sign-up through the API would spend most of an hour on Argon2id,
   which is not what is measured;
3. forks generator processes (`src/generator.ts`; one process may hold ~20,000 file descriptors
   here), each holding a slice of virtual users spread over 40 loopback source addresses (the
   per-address flood guard and the ephemeral port range both apply per address, as on a real
   network);
4. runs the scenario, sampling CPU and memory of every service, Postgres, Valkey, the generators
   and the machine every second, and writes a JSON result.

**Virtual users** (`src/client.ts`) speak the public protocol exactly as the web app does:
session cookie and CSRF header on every API call, a single-use ticket, the `tessera.v1`
subprotocol, the `auth` frame — and what the app does on its own: delivery acks coalesced over
150 ms, `GET /sync` plus fetching what was missed after every reconnect, and the app's reconnect
backoff (full jitter, 500 ms base, 30 s cap, reset after a minute connected). A reconnect moves to
the next realtime pod, as a load balancer would. Messages are random bytes of a realistic
ciphertext size (512 bytes by default) whose first 8 bytes carry the send time, so delivery
latency is measured on the receiving socket, across processes. Latencies go into mergeable
logarithmic histograms (≈2 % resolution). Load is **open-loop**: requests leave on schedule
whether or not earlier ones have been answered, so queueing shows up as latency instead of
silently slowing the test down.

**Headless clients** (`src/headless/worker.ts`, crypto scenario) run the web app's own
`MessagingStore`, `E2eeSession` and encryption engine (Rust → WebAssembly) unchanged in worker
threads, with an in-memory IndexedDB, the engine in-process behind the same RPC boundary, `fetch`
bound to the user's cookie and own source address, and a `ws` socket sending the browser's Origin.
Everything they put on the wire is real MLS: device registration, KeyPackage claims, group
creation, Welcomes, encrypted application messages.

## 2. Scenarios

| Scenario | What happens | Measured |
|---|---|---|
| `steady` | every account holds a socket; messages into random direct conversations at `--rate`/s | send latency (API), delivery latency (send start → frame on the peer's socket), loss, resources |
| `storm --mode drain` | as steady; realtime-0 gets SIGTERM (a deploy): reconnect hints with jitter, then it restarts | time until everyone is back, reconnect latency, send latency meanwhile, errors |
| `storm --mode crash` | as steady; realtime-0 gets SIGKILL: sockets just drop | same |
| `group` | a group of `--group-size` (1,024, the E2EE cap) with every member online; members post at `--rate`/s | fan-out per second, send and delivery latency, loss |
| `channel` | a channel with every account plus `--subscribers` synthetic subscribers (default 1M); the owner posts every 2 s; subscribers read the feed at `--rate`/s | publish latency, feed-read latency, writes per subscriber (must be 0) |
| `calls` | `--rate` new 1:1 calls/s between online users, each `--hold` s: ICE, start, ring, join, leave | ring latency, setup latency (press call → callee joined) |
| `crypto` | `--pairs` pairs of headless clients (real MLS) message each other at `--pair-rate`/s each way, under `--rate`/s of synthetic background traffic | device registration, conversation setup, end-to-end latency including encryption and decryption, order and loss of every message |

Common options: `--users`, `--generators`, `--apis`, `--realtimes`, `--duration` (s),
`--warmup` (s), `--connect-rate` (sockets/s), `--payload` (bytes), `--api-env K=V` and
`--realtime-env K=V` (tuning experiments), `--out` (result directory).

## 3. What this environment can and cannot show

- One machine (4 cores, 15 GB) runs everything: services, PostgreSQL, Valkey and the load
  generators compete for the same cores. Results are conservative for the services and say
  nothing about network latency, TLS termination or a load balancer.
- A process may hold 20,000 file descriptors here, so realtime pods are capped at 19,000 sockets
  (production: 50,000 per pod with a raised limit) and generators are split across processes.
- PostgreSQL is a local instance with default settings, not the managed Multi-AZ database of
  deployment.md; Valkey is a single local instance.
- Media (TURN/SFU bandwidth), push delivery to real push services and e-mail are not exercised;
  they are hardware- or vendor-bound and are measured in staging (Phase 17).
- No 24-hour soak: the longest run is 30 minutes (memory growth checked over that window).
