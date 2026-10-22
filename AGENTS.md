# DSH Bots

Implement the non-iOS MVP in docs/design.md. This repository publishes one additive DSH plugin with Host and desktop-client bundles. Do not implement apps/ios or Android. Use the existing DSH Host and its session/runtime services; never launch a second model runtime over the same session.

- Source modules: packages/protocol/src, packages/core/src, packages/dsh-plugin/src, packages/desktop-ui/src. Root scripts own build, packaging and the embedded-codex development integration.
- Core and protocol cannot import DSH, Cordis or React. Put DSH adaptation and HTTPS/WSS in dsh-plugin.
- Use strict TypeScript, ESM and explicit .ts imports. Persist identity, messages, dispatch, context deliveries and recovery state in SQLite.
- Keep changes additive. Never overwrite other repositories' user changes. Local DSH integration must preserve installed plugins and existing settings.
- Validate meaningful behavior with tests, including authorization, duplicate requests, restart recovery, non-waking context, task projection, and lifecycle cleanup. Run build, typecheck and focused tests before delivery.
- Do not report unimplemented or unverified features as complete. Record exact commands and any remaining platform verification in README/docs.
- Generated assets, state, installed dependencies and local paths do not belong in commits.
