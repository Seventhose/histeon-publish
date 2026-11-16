# Histeon builder vendored source

- Upstream: the Histeon builder repository (formerly Histos) (`https://github.com/Seventhose/histeon`, formerly `https://github.com/Seventhose/xb`)
- Pinned commit: `6dd9f790ff63f6c494f7b37147058f098b818681` (builder `main`, 16 November 2026, Histeon 0.5.15: the compact mini GUI and the alternative names of the recipes, texts)
- Previous pin: `c4223ec4e809cf856296a81798de68bf153b17ce`
- License: GPL-3.0-or-later, preserved from the upstream `LICENSE`.
- Snapshot includes only the editor, DSL, block schema and block specification needed for local authoring and rendering: `editor/`, `packages/dsl/`, `packages/spec/`, `docs/spec/blocks.md`, `LICENSE`, `tsconfig.base.json`.
- Copied from git objects with `npm run cms:vendor:snapshot -- --from <builder checkout> --commit <rev>`; the builder checkout is neither read beyond its git objects nor modified.
- The four transfer schemas in `packages/spec/schemas/` and `packages/spec/package.json` were a local contract overlay up to 9bc2120; upstream now ships them byte for byte, so they are upstream files of the snapshot and `patches/histos/spec-contract.patch` is gone.
- Local host integration changes are recorded separately under `patches/` and must not be applied to the WP plugin build.
