# Workspace proxy and tunnel boundaries

`apps/server/src/workspaces/workspace-proxy.ts` treats a client's CONNECT hostname as untrusted. Ordinary upstream forwarding resolves the hostname inspected from TLS SNI or HTTP Host and dials a public address from that resolution. This prevents forwarding to a private address supplied by the client. An interceptor that answers a host locally can handle it without upstream resolution; other TLS interception follows the public-address check.

An interceptor receives the socket positioned at its TLS ClientHello, including bytes already read during inspection. A backend can request a fixed proxy port so an existing machine reconnects to the address configured when it was created.

Railway carries proxy traffic over the guest exec tunnel in `apps/server/src/workspaces/railway/workspace-tunnel.ts`. Serialize asynchronous writes to the guest so frames remain whole and ordered. The matching guest implementation is `workspace-tunnel.py` in that directory. This transport does not impose network-wide egress filtering; see [ADR 0005](0005-railway-workspaces.md).
