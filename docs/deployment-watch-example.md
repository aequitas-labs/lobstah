# Add a watch type without changing consumers

The fixture-backed `DeploymentWatchType` proves the extension contract. It is an
example for adapter authors, with no deployment-service credentials or production
integration. The same class runs in a local `WatchRegistry` and through the
configured process host. The daemon, pickup loop, helm, Stop hook and glass need
no deployment-specific changes.

The implementation lives in `packages/watch-types/src/deployment/`. Its
`DeploymentProvider` composes observation, optional subscription, an authorized
acknowledgment and cleanup. Replace that provider to connect a real service while
retaining the source's domain identity, state and presentation.

## Try the process adapter

After building the repository, create a history file at an absolute path:

```json
[
  {
    "environment": "production",
    "deploymentId": "run-7",
    "sequence": 1,
    "phase": "failed",
    "terminal": false,
    "at": "2026-11-19T00:00:00.000Z",
    "logUrl": "https://deploy.example.test/logs/run-7"
  }
]
```

`sequence` must increase within one deployment. Phases are `queued`, `deploying`,
`failed`, `succeeded` and `cancelled`. Mark the final transition `terminal: true`
when no further observations should arrive. Stable event IDs combine environment,
deployment ID and sequence. The reducer rejects inconsistent checkpoints and
keeps a newer polling cursor when an older stream batch arrives.

Add configuration using the absolute paths of your checkout and history file:

```toml
schemaVersion = 2

[watchTypes.deployment]
module = "process"
command = ["node", "/absolute/lobstah/packages/watch-types/dist/deployment/plugin.js"]
version = "1.0.0"
apiVersion = 1
envAllow = []
allowCapabilities = ["poll", "subscribe", "actions"]
fixturePath = "/absolute/deployment-history.json"
subscribeEveryMs = 25
```

Register it with the helm as its owner:

```sh
lobstah watch add deployment:production/run-7 --type deployment
```

Use `--for <dispatch-id>` to continue an existing chain or `--owner wt:<trap-id>`
for feedback buffered under a stable trap identity. Per-watch overrides use
`--options '{"fixturePath":"/another/history.json"}'`. The ordinary watch loop
checks it, schedules its declared subscription and delivers through the shared
outbox. Repeated polls and replayed stream events do not create another delivery.

The failure supplies an `Open deployment logs` link, an environment/status/revision
row set, a `deployment:failed` attention condition, and separate worker and helm
instructions. Glass renders the source-provided log destination. The condition's
hash includes its sequence so a changed failure becomes a new condition.

For an installed npm SDK, an executable entry point can be just:

```ts
import {
  DeploymentWatchType,
  deploymentActionSchemas,
  serveWatchPlugin,
} from 'lobstah/watch-types';

/** Run the shared deployment contract over the process protocol. */
await serveWatchPlugin(new DeploymentWatchType(), {
  actionSchemas: deploymentActionSchemas,
});
```

Point `command` at the compiled entry point. Nothing is imported dynamically into
the daemon. This fixture adapter needs no environment grants.

## Use the local module

A host can install the same adapter directly at its composition boundary:

```ts
import { DeploymentWatchType, WatchRegistry } from '@lobstah/watch-types';
import { WatchRuntime } from '@lobstah/core';

/** This host supplies ownership and installation; the source supplies behavior. */
const registry = new WatchRegistry();
registry.register(new DeploymentWatchType());
const runtime = new WatchRuntime(registry);
runtime.register(
  'deployment',
  'deployment:production/run-7',
  { fixturePath: '/absolute/deployment-history.json' },
  { kind: 'helm', grounds: 'home' },
);
```

The local and process tests use one history and compare exact events, state,
worker/helm instructions, links and attention presentation.

## Record human authority before effects

A source can display an action, but an observation does not authorize it. This
example declares `acknowledge` only for a failed deployment. A trusted host first
records the selected action, current sequence, note and human authorization with
`WatchActionRunner.authorize`, then executes that recorded request. The arguments
schema accepts `{ note: string }`. No shell command or arbitrary output path comes
from the action arguments.

The fixture provider verifies the expected sequence and writes one receipt per
request ID beside the history file. The result contains no scheduled work and a
JSON acknowledgment payload. If the host restarts before its own completion
receipt commits, the provider returns the recorded result. Reusing a request ID
with different scope is rejected. These local files demonstrate provider recovery;
a production adapter must use its service's idempotency mechanism and permission
model.

## Drain before cleanup

A terminal transition moves the watch to draining. It retains its event tail
until the owner receives a continuation or consumes the inbox pointer. Then the
ordinary cleanup pass calls `close` and retires it. The provider aborts its owned
stream, waits for subscription cleanup and records one close marker. Removing an
idle source through the runtime's close operation also aborts its stream.

The tests cover local and process subscriptions, idle cancellation, one actual
queued continuation, one inbox pointer, glass's supplied log link, forged action
rejection and provider-receipt replay. With the deployment plugin enabled, the
same PR and ume fixtures retain their event IDs, cursors and delivery counts.
The diff contains only the adapter, its export, tests and author documentation.
See [the process adapter guide](watch-plugins.md) for installation limits, protocol
versions and capability grants.
