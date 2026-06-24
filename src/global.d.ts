/**
 * Build-time constants injected by `bun --define` (see
 * scripts/build-binaries.mjs). Declared as an ambient global — this file must
 * stay free of top-level import/export or it stops being a global declaration.
 *
 * `__DCD_CLI_VERSION__` holds the package version stamped into the compiled
 * standalone binary. On the npm/tsx path it is never defined; `getCliVersion()`
 * guards every read with `typeof`.
 */
declare const __DCD_CLI_VERSION__: string | undefined;
