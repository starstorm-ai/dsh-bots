# DSH Bots

Implement the MVP in docs/design.md and the native iOS client from dsh-bots-design.md (the user explicitly expanded scope to iOS). This repository publishes one additive DSH plugin with Host and desktop-client bundles. iOS lives in apps/ios; do not implement Android. Use the existing DSH Host and its session/runtime services; never launch a second model runtime over the same session.

- Source modules: packages/protocol/src, packages/core/src, packages/dsh-plugin/src, packages/desktop-ui/src. Root scripts own build, packaging and the embedded-codex development integration.
- Core and protocol cannot import DSH, Cordis or React. Put DSH adaptation and HTTPS/WSS in dsh-plugin.
- Use Swift 6 strict concurrency and SwiftUI for iOS. Use strict TypeScript, ESM and explicit .ts imports for Host/desktop. Persist identity, messages, dispatch, context deliveries and recovery state in SQLite.
- Keep changes additive. Never overwrite other repositories' user changes. Local DSH integration must preserve installed plugins and existing settings.
- Validate meaningful behavior with tests, including authorization, duplicate requests, restart recovery, non-waking context, task projection, and lifecycle cleanup. Run build, typecheck and focused tests before delivery.
- Do not report unimplemented or unverified features as complete. Record exact commands and any remaining platform verification in README/docs.
- Generated assets, state, installed dependencies and local paths do not belong in commits.
