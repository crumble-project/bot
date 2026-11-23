# Workspace machine lifecycle

`apps/server/src/workspaces/machine-workspaces.ts` owns the lifecycle shared by workspace backends. This record preserves decisions previously documented beside its implementation and in `workspace.ts`.

## Startup and guest setup

- Creating an environment is lazy. Its first operation starts the machine; `running()` only inspects local state.
- Boot uses `GUEST_DAEMON`. A desktop image already has a VNC listener, but browser readiness is separate. Non-desktop readiness succeeds immediately.
- Backend boot calls run serially per bot. Lifecycle operations use an uninterruptible semaphore permit, preventing overlapping starts and stops or half-finished startup after cancellation.
- Write guest files before running setup commands, then start the desktop. Its browser must find the credential authority at startup.
- Attempt memory overcommit at every boot because the kernel setting does not persist. Tools such as oxlint reserve more address space than small guests permit by default. Failure logs a warning instead of preventing jobs that do not need overcommit.
- Backends without transparent proxy routing provide environment variables for job HTTPS traffic.
- Backend machine names can share an account-wide namespace. Prefix names, and validate bot IDs before constructing them to prevent naming another bot's machine.

## Lifetime and image changes

- Hold the workspace during requests, `info()`, and `session()`. Even metadata operations establish connections and can fail if idle shutdown races daemon startup.
- Read a configured base-image override at boot. Only OCI-image backends use it; recipe-based backends select images themselves.
- Defer a base-image replacement until idle shutdown, rather than swapping machines under a running job. Desktop capability changes can require an image transition.
- Restart force-stops the machine but retains the pi-env connection. Losing its bridge permits reconnection; calling `Connection.close()` does not. Close that connection only for terminal shutdown or removal.
- Removal deletes the stopped machine and its files. Removing an already absent machine succeeds.
- Machine stop performs its persistence step before stopping and releasing resources. Railway's failure and checkpoint semantics are recorded in [ADR 0005](0005-railway-workspaces.md).
- `sync()` delegates persistence to the backend and does nothing for a stopped workspace. Railway schedules a checkpoint rather than awaiting durability; callers must account for [ADR 0005](0005-railway-workspaces.md).

## Desktop connections

Active desktop streams boot and hold the machine until they close. Passive streams neither boot nor hold it and end when it stops. VNC travels through `socat` over an exec stream, without exposing a guest port. Serialize asynchronous guest writes to preserve byte order.

## pi-env boundary

pi-env obtains its connection command through `Effect.runPromise`, preserving tagged startup failures at the Promise boundary. Only the server process owning the machine opens guest exec streams. A spawned bridge forwards stdio over a local Unix socket instead of accessing the backend itself.

The bridge sends daemon arguments as a JSON array of strings on its first line; remaining bytes are daemon stdin. Parse malformed arguments without throwing through the socket event handler, which could terminate the server. Queue guest writes to preserve their order.
