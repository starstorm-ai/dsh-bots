# LAN API v1

The plugin owns a separate HTTPS/WSS listener and never exposes the DSH administrative gateway. It starts automatically when the desktop creates a chat invitation. Until first use no LAN listener is opened. Port 49210 is preferred; subsequent launches reuse the saved port. An occupied port or one reserved by the operating system (`EADDRINUSE`/`EACCES`) falls back to an OS-assigned available port. Concurrent invitation requests share one listener. Closing an invitation dialog does not disconnect joined devices. After first activation the listener resumes on Host restart. There is no Connections tab, manual network configuration, Bonjour dependency, standalone device-pairing API or browser application.

Production binds local interfaces automatically. The QR advertises actual local IPv4 addresses and the bound port; `0.0.0.0` and loopback are never advertised as phone endpoints. A computer with no available LAN interface reports an actionable error instead of an unusable QR.

## iOS invitation and TLS trust

`network.json` stores only activation state and the selected port. `tls-identity.json` stores a persistent P-256 key and self-signed certificate in the plugin's private state directory. `room.invite.create` returns an `InviteTicket` with `uri` and `qrPayload`. The QR encodes `dshbots://invite?data=<percent-encoded qrPayload>`. The JSON payload contains `protocol: 1`, `kind: "invite"`, `hostId`, `storeEpoch`, `addresses`, `fingerprint`, `token`, `expiresAt`, `roomId` and `historyVisibility: "full"`.

The iOS client must validate the certificate against the trusted QR fingerprint before submitting the invitation over HTTPS. `fingerprint` is lowercase hex SHA-256 of certificate DER bytes. Trust is specific to that Host and certificate; a changed certificate requires scanning a fresh trusted invitation. Never disable certificate validation globally. This release only prepares the desktop and protocol; the iOS scanner, Keychain storage and real-device integration are deferred.

All JSON requests use `Content-Type: application/json`. Authenticated calls use `Authorization: Bearer <accessToken>`. Tokens in URLs are rejected, cookies are not used, and responses are `Cache-Control: no-store`. Browser origins must exactly match an advertised HTTPS origin; native clients omit Origin. The listener implements no wildcard CORS policy.

| Method | Endpoint | Request / result |
|---|---|---|
| GET | `/v1/health` | Public `{protocol:1,status:"ok"}` only |
| POST | `/v1/invite` | `{token,displayName,deviceName,requestId?,deviceChallenge?}` → credentials; optional existing bearer preserves the member's identity |
| POST | `/v1/refresh` | `{refreshToken}` → new access/refresh credentials; old tokens cease working |
| GET | `/v1/bootstrap` | Authorized identity, rooms and capabilities; members do not receive the Host's workspace/session enumeration |
| GET | `/v1/snapshot?roomId=…` | Authorized room snapshot including durable cutoff and live stream snapshot |
| GET | `/v1/history?roomId=…&beforeSeq=…&limit=…&search=…` | `{messages,hasMore}`; maximum page 100 |
| GET | `/v1/events?roomId=…&afterSeq=…&limit=…` | `{events,cutoff,hasMore}`; maximum page 500 |
| POST | `/v1/command` | Shared protocol Command → command result |

Invitations last ten minutes and can admit several members. Creating a fresh invitation revokes earlier invitations for that room; explicit revocation and expiry block new joins without disconnecting existing members. Removing a member also revokes the current invitation. The first new member joining a direct chat converts it into a group atomically, preserving the room ID, history and Session bindings.

A client retry supplies the same `requestId` and client-held `deviceChallenge` together. The Host replays the encrypted receipt for up to two minutes without creating another identity; a different challenge for that request is rejected. An expired receipt or one superseded by a later credential rotation returns `REQUEST_EXPIRED`; start a new request with the device's current credentials. For a device already authenticated to this Host, send its bearer token to reuse its Person and Device, preserve existing membership and avoid restoring any explicitly denied grants. Joining rotates that device's credentials, so replace old credentials and reconnect its WSS stream. New unauthenticated devices receive independent member identities; nicknames never merge identities.

Joining grants access to the target chat, its full displayed history, and invocation grants for its current assistants. A newly added assistant grants current members access. Members never receive the Host's complete Session catalog or owner capabilities. Existing explicit denials are retained on repeated scans. Credential lifetimes and invitation expiry are returned in the response.

Errors are JSON `{error:{code,message,retryable}}`; failed requests use 400/401/403/404/413/429/500 as appropriate. Unknown backend failures return a generic message instead of exposing local paths or stack traces.

## WSS and reconnect

Connect to `/v1/ws` with the bearer header. Clients that cannot attach an authorization header must send `{kind:"auth",accessToken:"…"}` as their first frame within five seconds. No URL token is supported. The server responds `{version:1,kind:"ready",hostId,storeEpoch}`.

Subscribe with `{kind:"subscribe",id?,roomId,afterSeq,storeEpoch?}`. The server checks membership, sends the persisted ordered room events after that cursor, then `{kind:"subscribed",roomId,cutoff}`. Subsequent room events arrive on the same socket. Reconnect with the last durably applied per-room sequence; deduplicate by `(storeEpoch,roomId,seq)`. If the store epoch changed or the cursor is ahead of the Host, fetch a fresh snapshot. Use the HTTP event pages when paging a large offline gap. Transient stream frames are not durable; a fresh room snapshot restores the current stream state.

Commands use the shared envelope `{version:1,kind:"command",id,type,payload}`. Responses use `{version:1,kind:"response",id,result}` or `{version:1,kind:"error",id,error}`. The same `clientMessageId` must be retained while retrying `message.send`; transport request IDs do not replace message idempotency. A committed message can arrive as an event before its response. `{kind:"unsubscribe",roomId}` removes a subscription; `{kind:"ping",id}` receives a pong.

`room.access.revoked` instructs a removed member to purge that room's local cache and outbox. The server stops delivering room content immediately and denies subsequent history/snapshot reads. Revoked device/person sockets close with 4401. Credentials are rechecked on each request, every event and each heartbeat. Refresh clients should reconnect with their rotated token. Global invalidation events carry only an empty payload; clients refetch their authorized bootstrap data.

Limits: HTTP/WebSocket payload 64 KiB, 64 simultaneous WebSocket connections, 64 room subscriptions per connection, 32 queued socket commands, and 2 MiB socket send backlog. Per-IP rates are 600 ordinary HTTP requests/minute, 30 credential requests/minute, 120 WebSocket upgrades/minute and 600 frames/minute. The server uses TLS 1.2+, request/header timeouts and a 15-second heartbeat. Slow clients reconnect and replay durable history. Disabling/unloading the plugin terminates sockets, removes event subscribers and releases the listener.

The tests in `tests/lan.spec.ts` exercise real local HTTPS/WSS, persistent certificate identity, invitation receipt retries, token rotation, room authorization, catch-up/live ordering, revocation and listener cleanup. LAN firewall, real Wi-Fi/hotspot connectivity and future iOS certificate handling still require device-level validation.
