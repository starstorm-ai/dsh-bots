# DSH Bots protocol v1.2

The desktop client and future mobile clients share the JSON DTOs in `packages/protocol/src/index.ts`. Command validation is defined by `packages/protocol/schema/command.schema.json`; `packages/protocol/fixtures/round-trip.json` supplies Unicode, large sequence, mention, stream and access-revocation fixtures. The package exports these as `dsh-bots/protocol` and `dsh-bots/schema/command.json`. HTTPS, authentication and WSS details are in [lan-api.md](lan-api.md).

## Identity and ownership

`hostId` identifies the persistent Host. `storeEpoch` identifies its database generation. A `Person` can own several `Device` identities. Authentication resolves both; command payloads cannot choose the caller's identity. Host owner, room owner and room membership are separate permissions. A room member can read the room and send ordinary messages. Joining by invitation creates invocation grants for the chat's existing assistants. Adding an assistant grants current members access; an explicit later denial stays effective. All existing Sessions can be selected by the local Host owner without a workspace allowlist or a separate Session authorization record. Workspace metadata remains for ownership validation and scheduling.

A `Bot` is a named assistant with one whale avatar shape, one of six colors and a selected existing DSH `sessionId`. The Host derives its Workspace from that Session and retains the Session's preset, model and permissions. A `Binding` connects that Bot's selected Session to one room; adding the Bot does not create another Session. Its `generation` changes when the binding is replaced. One Session cannot be actively bound to two rooms. Adopting an existing Session into a group requires acknowledgement that its model context may include earlier private history; displaying its older messages requires the separate `importHistory` option.

## Commands

Use `{version:1,kind:"command",id,type,payload}` on the wire. `id` correlates the response; it is not the message idempotency key. Unknown commands, wrong field types and extra payload fields are rejected. Responses are `{version:1,kind:"response",id,result}` or `{version:1,kind:"error",id,error:{code,message,retryable}}` over WSS; HTTP returns the result or an error object directly.

| Commands | Purpose and principal checks |
|---|---|
| `person.update`, `person.revoke` | Update own display name; only Host owner can revoke another person |
| `device.revoke` | Revoke own device; Host owner can revoke another person's device |
| `scheduler.update` | Host owner pauses or resumes dispatch |
| `bot.create`, `bot.update` | Host owner manages assistant identity and authorizes an available existing Session for it |
| `bot.delete` | Host owner removes an assistant and its chat bindings, preserving the DSH Session and chat history |
| `room.create` | Host owner creates a direct room or a group, optionally with an assistant |
| `room.update`, `room.delete`, `room.owner.transfer` | Room management; pinning is personal; ownership transfer applies to groups |
| `room.invite.create`, `room.invite.revoke`, `room.member.remove`, `room.leave` | Chat invitations/membership; owner must transfer ownership before leaving |
| `binding.create`, `binding.remove`, `binding.grant.update` | Host owner manages the selected Session's binding and per-person invocation grants |
| `message.send` | Member sends structured text/mentions with a stable `clientMessageId` |
| `invocation.cancel`, `invocation.retry` | Authorized caller controls an existing invocation |
| `interaction.answer` | Authorized caller answers a pending question/approval using its current revision |
| `sync.resume`, `sync.ack`, `read.update` | Read durable events, acknowledge per-device sync, or advance per-person read state |

The desktop owner additionally uses Typert service `dshBots` with `bootstrap`, `command`, `snapshot`, `history` and `stream`. Desktop `room.invite.create` automatically starts the dedicated HTTPS listener and returns an iOS invitation URI with its TLS fingerprint. There is no Connections tab, standalone device pairing, network configuration RPC or browser joining UI. The desktop chat remains part of the same installed plugin.

`bot.create` requires `name` and `sessionId`, with optional `avatar`. Select an available Session from the owner's `bootstrap.sessions`; the Host validates its actual existence, Workspace, availability and explicit access revocations, then authorizes that assistant for the selected Session. No preceding Workspace grant or LAN setup is required. The minimal desktop form contains name, avatar and the actual DSH reference-menu component backed by all available Sessions; it does not open or modify a native draft. `room.create` with `botId` and `binding.create` reuse that Bot's selected Session. Group adoption additionally requires `acknowledgeSharedContext: true`; in a group, leaving `importHistory` unset starts displaying native Session messages from the binding cutoff while retaining its existing model context.

`bot.delete` takes `{botId}` and returns `{deleted:true}`. Repeating deletion of the same assistant is safe. The Host atomically marks the assistant deleted, deactivates its bindings, cancels queued invocations, discards pending background delivery and expires pending chat interactions. It then stops observing those bindings and emits `binding.removed` and `bootstrap.changed`. Active or uncertain invocations reject deletion with `BINDING_BUSY`; stop or reconcile them first. Existing DSH Sessions and messages remain intact, the Session becomes available for a new assistant, and deleted assistants cannot be edited, rebound or invoked. Historical messages retain their author names; deleted bindings do not offer task retries. No database schema migration is needed.

The legacy `binding.reset` command is recognized but rejects with `EXISTING_SESSION_REQUIRED`; it never creates a new Session. Remove the current binding before selecting a replacement existing Session. Legacy default Workspace/preset and instruction fields may remain in stored Bot records for compatibility; they do not override the selected Session's execution configuration.

## Messages, context and tasks

```json
{
  "version": 1,
  "kind": "command",
  "id": "request-19",
  "type": "message.send",
  "payload": {
    "roomId": "room-team",
    "clientMessageId": "device-generated-uuid",
    "parts": [
      { "type": "mention", "botId": "bot-whale", "label": "Whale" },
      { "type": "text", "text": " Check the tests in this Workspace." }
    ]
  }
}
```

Both group and direct chats dispatch only structured mention parts; typing plain `@Whale` text does not grant permission or create a task. The desktop preselects the sole direct assistant as a removable mention. Retrying an identical `message.send` with the same device and `clientMessageId` returns the original result. Reusing that ID for different content yields `IDEMPOTENCY_CONFLICT`. The response contains `message`, `messageId` and `invocationIds`. Clients previously relying on implicit direct invocation must now send an explicit mention part.

Non-mentioned messages in either room kind are persisted as background context for other bound assistants. Supported DSH inbox injection records them without waking the model. The bounded window retains up to 80 messages/48,000 bytes; omission and uncertain recovery remain visible in context delivery state. Dispatch rechecks membership, active assistant bindings and invocation grants. Tasks are queued per binding and serialized around the existing DSH Session. Instructions are frozen with each invocation. A restart reconciles durable request identities instead of automatically submitting uncertain work again.

New direct bindings import visible native history by default (`importHistory: false` opts out). Groups require explicit `importHistory: true` in addition to shared-context acknowledgement. Existing cutoffs are not changed during upgrade. Projected messages optionally carry `sessionId`, `sessionMessageId`, `sourceSeq` and typed `blocks` for text, tool status and attachment labels. A tool call and result update the same message; group membership never grants a raw Session RPC or attachment download capability. The projector deduplicates per Binding so an explicitly shared Session can be imported after rebinding. Context receipts are never displayed as human messages.

`Invocation.status` is one of `queued`, `dispatching`, `accepted`, `running`, `waiting_user`, `completed`, `failed`, `cancelled`, `interrupted`, or `recovery_required`. DSH assistant answers, tool messages, task status and supported questions/approvals are projected back into the chat. Source Session sequence and binding identity prevent duplicate projection. Chat-originated prompts and injected background are not echoed back as new chat messages.

Messages and live streams may carry `turn: {id,number,status,startedAt?,endedAt?,finalMessageId?}`. The identity is derived from the native `turn/start` sequence and is scoped by Binding. Source event `time` supplies timestamps. Native turn completion updates the existing projected message rows with the completed turn and final-answer boundary; it never inserts another tool result. Renderers group all rows of a turn, including when humans or other assistants interleave. Legacy messages remain compatible: renderers fall back to invocation identities and native user-input boundaries. No database version change is needed for these optional JSON fields.

## Synchronization

A durable room event has `{version:1,kind:"event",roomId,seq,type,payload}`. Persist the cursor only after applying the event and deduplicate by `(storeEpoch,roomId,seq)`. Sequences count all durable room events, not just messages. `message.created`, `invocation.updated`, membership, binding and room changes share that order. History contains messages only and supports reverse pagination and text search.

Fetch `bootstrap` for authorized identity and room summaries, then `snapshot` for the chosen room. A snapshot includes messages, bindings, members, grants, tasks, interactions, context delivery states, current streams and a durable `cutoff`. Subscribe/replay after that cutoff. Use paged event catch-up after disconnect; changed `storeEpoch` or a cursor ahead of the Host requires a fresh snapshot. A `bootstrap.changed` notification asks the client to reload its authorized summaries.

`stream.updated` has no durable room sequence. Its payload identifies `bindingId`, `messageId`, `attemptId`, `streamRevision` and `index`; clients reject older frames and replace the displayed accumulated text. A final durable message supersedes the temporary stream. Reloading a snapshot restores an in-progress stream after reconnect.

`sync.ack` is per device; `read.update` is per person. Both move only forward. Removing membership emits targeted `room.access.revoked`; the client must purge that room's cache/outbox. All subsequent reads and commands require current membership. Invitation v1 exposes full existing room history, as shown explicitly in its QR and membership data.

JSON numeric sequence fields are nonnegative safe integers up to `9007199254740991`. Timestamps are ISO 8601 strings. IDs are opaque strings, not paths. Preserve unknown event types by refreshing the affected authorized snapshot; do not reinterpret them as commands. `PROTOCOL_VERSION` is `{major:1,minor:2}` and unsupported command major versions are rejected.

## Invitation and migration changes in 1.1

`pairing.create`, `workspace.grant.update`, `/v1/pair`, `network.info` and `network.configure` are removed. Unknown commands fail closed. A room owner or local Host owner may create one current, ten-minute, multi-member invitation for either room kind. Refresh revokes its predecessor. The first new member converts a direct room to a group in the same transaction as membership creation, preserving its ID, binding, cutoff and history. Expiry/revocation prevents new joins; it does not remove current members. Removing a member also invalidates current invitations to prevent immediate re-entry with the old QR.

SQLite migration 3 removes obsolete workspace/session authorization, old invitations, pairing receipts and remote credentials. Existing rooms, people/devices, messages, task records and Session bindings are retained. Old remote clients must scan a new invitation. No iOS or browser app is shipped, and real-device joining is deferred until the iOS app exists.
