# Add a watch type

A watch type owns source identity, observation, state migration, instructions and
presentation. The host owns durable generations, ownership, scheduling, event
receipts and recorded action authority. Built-in modules and installed process
plugins implement the same `BaseWatchType<Reference, State, Cursor, Options>`
contract.

Use composition for optional capabilities. Adding a provider must not require a
branch in the daemon, helm, Stop hook, report renderer or glass. The [deployment example](deployment-watch-example.md) demonstrates both hosts
with one adapter class.

## Install a process plugin

Process loading is opt-in. Install the executable yourself, then pin its release
and argv in `config.toml`. Arguments are passed directly without a shell.

```toml
schemaVersion = 2

[watchTypes.deployment]
enabled = true
module = "process"
command = ["node", "/opt/watch-adapters/deployment.js"]
version = "1.0.0"
apiVersion = 1
envAllow = []
allowCapabilities = ["poll", "subscribe"]
requestTimeoutMs = 30000
startupTimeoutMs = 5000
maxMessageBytes = 1048576
maxRestarts = 3
restartWindowMs = 60000
restartBackoffMs = 1000

# Remaining fields are adapter-owned defaults, checked against its options schema.
fixturePath = "/absolute/deployment-history.json"
```

`envAllow` names the only ambient credentials the child receives. The host also
passes basic OS launch variables, including PATH and temporary-directory names.
The journal records granted names, executable identity, release and capabilities;
it never records environment values. Credential rotation selects a new transport
connection. A plugin is trusted installed OS code with the user's filesystem and
network access. This mechanism does not sandbox it or install packages at runtime.

Register a typed reference through its declared explicit binding:

```sh
lobstah watch add deploy:production --options '{"application":"web"}'
lobstah watch add deploy:production --type deploy --for DISPATCH_ID
lobstah watch add deploy:production --owner wt:STABLE_TRAP_ID
```

The default owner is the helm. `--for` and `--owner` select durable ownership;
a session ID is never an owner. Configured defaults are merged with per-watch
options before schema validation. Re-registration preserves the cursor and
receipts; changing the owner requires an explicit transfer.

`enabled = false`, a missing executable, an incompatible handshake or a failed
restore retains existing watches and their last valid rows. The runtime holds
them with an error and remedy. Correct the installation and run
`lobstah watch release KEY`. No cursor advances while held.

## Implement the contract

In this repository import `@lobstah/watch-types`. Installed adapters can import
`lobstah/watch-types`, which exports the same base class, types, schemas and
stdio runner. Keep the adapter separate from its executable entry point so the
same history can run in both hosts.

Every typed adapter declares its canonical `keyPrefix`; aliases in its bindings may accept other input spellings. The command transport declares an empty prefix to preserve arbitrary user keys. The host checks canonical identity at registration and restore.

Every adapter supplies these methods:

| Method or declaration | Responsibility |
| --- | --- |
| `descriptor` | Canonical `keyPrefix`, stable type ID, API major, adapter release, state version and attention names. |
| `bindings` | Explicit reference patterns and any supported legacy registration imports. |
| `referenceSchema`, `optionsSchema`, `stateSchema`, `cursorSchema` | JSON schemas and matching parsers. |
| `identify`, `key`, `initialize` | Validate a reference, derive its canonical key and initialize progress. |
| `restore` | Validate or migrate source state without changing the key or ownership. |
| `poll` | Return normalized events and a checkpoint, or a classified failure. |
| `reduce` | Compute state and cursor from one validated batch. |
| `present` | Return declarative rows, links, attention, actions and worker/helm instructions. |
| `failure` | Classify a source failure, retry delay and recovery instructions. |
| `close` | Release source resources after the final event tail is delivered. |

Keep `identify`, `key`, `initialize`, `restore`, `reduce`, `present` and `failure`
deterministic and short. Polling and effects may await provider IO. The synchronous
host uses a worker thread for child stdio and bounded synchronous calls; journal
locks are never held while executing adapter methods. A generation and observation
lease fence every checkpoint publication. Ownership changes invalidate old work.

The schema declarations use JSON Schema draft 7 with strict validation. Parsers
must agree with their declarations. The host does not coerce values, apply schema
defaults, fetch remote schemas or accept executable values. See the
[Ajv guide](https://ajv.js.org/guide/getting-started.html) for schema compilation.

The executable only wraps the adapter:

```ts
import { serveWatchPlugin } from 'lobstah/watch-types';
import { DeploymentWatchType } from './deployment.js';

/** Expose the same adapter contract over versioned stdio. */
await serveWatchPlugin(new DeploymentWatchType());
```

Presentation is a validated data object. Attention display data also declares its card family, shared identity and links, so mirrors need no provider prefix checks. It includes worker and helm steps, optional
read commands, human attention cards and glass rows. It cannot provide JavaScript,
HTML callbacks or arbitrary UI components. Consumers render the recorded object
without knowing the provider's type. Optional read commands are displayed as
instructions; rendering does not execute them.

## Optional capabilities

The handshake advertises capabilities implemented by the adapter. Configuration
must grant each optional capability with `allowCapabilities`; the default is
`["poll"]`. Grants never add a capability that the adapter did not declare.

- `registration`: the adapter's `registration.prepare(request)` interprets its
  declared bindings for explicit keys, report fields and tool parks. It returns
  `{ input, options }` or `undefined`; the host validates the result through the
  adapter's identity and schemas, then registers it with the supplied durable
  owner. Preparation must not write state. The optional `registered(request,
  snapshot)` hook runs after identity, ambiguity and ownership checks pass.
  `registration.sync(now, phase)` reconciles source registrations at
  `before-observe`, `after-observe` and `report` boundaries. A failed source hook
  does not prevent another adapter's reconciliation. Grant `registration` in
  `allowCapabilities` to enable these hooks for a process plugin.
- `commands`: source-owned compatibility command bindings declare a subcommand
  name and optional input pattern. `commands.run({ name, args, flags })` returns
  its output text. These bindings route existing CLI command forms through the
  installed adapter; a replacement source supplies its own handlers. Configuration
  must grant `commands` before the host calls `watch.command`. Ambiguous handlers
  fail before either runs.
- `triggers`: the source parses todo conditions and reads them from its cached
  records. `parse(subject, condition)` returns `{ key, on }`; `read(reference,
  since)` returns `waiting`, `lost`, or `met` with its outcome in `as`. Optional
  `prepare`, `needsWatch` and `watchNote` hooks refresh a source before a todo is
  stored and register a needed watch afterward. Existing PR trigger records remain
  readable; new source triggers store their installed type ID.
- `acknowledgements`: declared key `patterns` select optional `exists(key, culling)` and `retain(ack, standing)`
  rules preserve source-owned legacy item keys and stable acknowledgements. Return
  `undefined` from `exists` for another source's key. These rules read cached data;
  they do not poll the provider. Ordinary source attention uses its journal and
  supplied state hash without this capability.
- `batch`: the source groups compatible checks and returns a batch or failure for
  each requested key. Shared rate limits belong here.
- `subscribe`: an async iterable yields the same batches as `poll`. The host
  leases streams across processes, commits each batch through the ordinary
  reducer/outbox and reconnects from the last durable cursor. Stable event IDs
  dedupe overlap with polling. Abort signals stop streams on removal, completion,
  ownership change or host shutdown. Subscriptions reconnect within the configured
  request lifetime; they do not bypass deadlines.
- `actions`: an effect handler receives the recorded request ID, authorization,
  expected revision and host generation. Pass explicit argument and result JSON
  schemas to `serveWatchPlugin(adapter, { actionSchemas })`. Both ends validate
  these schemas and the authority envelope. The host persists its receipt before
  invoking the effect. The adapter must use the request ID to recover uncertain
  external outcomes without repeating a write.
- `automation` and `dispatch`: source policies propose authorized actions and
  continuations, including source-owned brief preparation and delivery hooks.
  The host reserves durable work IDs and enforces its cycle budget.
- `derived` and `notices`: source-owned projections and notice policies supply
  generic rows and routing through the same contract. An unavailable optional
  projection keeps the last valid presentation and cannot stop other sources.

## Wire protocol and lifecycle

The transport uses [JSON-RPC 2.0](https://www.jsonrpc.org/specification) with one
JSON object per stdout line. Stdout is reserved for protocol messages; diagnostic
text goes to stderr. The host retains at most 16 KiB of recent stderr for errors.
Every request has a unique ID and these `params` fields:

```ts
/** Host context carried by requests and observation notifications. */
interface WatchPluginContext {
  protocolVersion: 1;
  watchKey: string;
  generation: string;
  deadline: number; // Unix milliseconds; at most 120 seconds ahead.
}
```

`params.body` carries method-specific DTOs. `watch.handshake` runs before any
other operation and after every restart. Its result includes protocol and
presentation version 1, the descriptor, four schemas, registration bindings and
capabilities. The configured type ID, API major and release must match. A restarted
process must advertise the same manifest as the original connection.

Required operations are `watch.identify`, `watch.key`, `watch.initialize`,
`watch.restore`, `watch.poll`, `watch.reduce`, `watch.present`, `watch.failure` and
`watch.close`. Restore returns only reference, options, state, cursor and state
version; the host retains ownership, generation, events, authority and receipts.
Before a release or state migration publishes, the journal retains a backup of
the previous installation's snapshot.

Registration uses `watch.registration.prepare`, `watch.registration.registered`
and `watch.registration.sync` when the capability is granted. A request includes
its event, fields, durable owner, adapter options and optional working directory,
cursor and cadence. Bindings match fields with adapter-declared patterns; the host
never recognizes a provider's tool name or key prefix. Unknown parks keep their
ordinary turn-wait process. The source's existing `close` hook also runs on
explicit removal; failed cleanup remains retryable.

A subscription uses `watch.subscribe`. Notifications use `watch.observation` and
repeat the original request ID, watch key, generation, protocol and deadline with
a normalized `batch`. The host rejects stale or mismatched envelopes and queues
at most 1,000 unacknowledged batches. `watch.cancel` identifies the request to
abort. Polls and subscriptions share stable provider event IDs.

Malformed JSON, unknown response IDs, oversized messages, invalid DTOs, missed
deadlines and unexpected exits fail only the affected installation. The transport
stops its owned child, bounds restart attempts and repeats the pinned handshake
before retry. Other types continue their scheduled checks. Error formatting and
presentation failures preserve the prior cursor and valid presentation.

## Verify an adapter

Use one deterministic source history in both hosts and compare exact normalized
events, cursors, role instructions and presentation. Then verify:

1. Unsupported API majors hold existing watches without advancing the cursor.
2. A process exit leaves another type's scheduled observation running.
3. Restart/replay preserves one delivery and its reserved continuation ID.
4. Invalid output, stale generations, oversized frames and deadlines publish no
   progress. Allowed environment variables reach the child and unlisted values
   do not.
5. Streaming and polling overlap without duplicate events; cancellation releases
   only the owning stream. Optional effects require recorded authority and recover
   by their request ID.

Run the focused conformance files on Ubuntu and Windows. Full repository checks
and packaging run through `lobstah heavy`; plugin loading performs no release or
merge operation.
