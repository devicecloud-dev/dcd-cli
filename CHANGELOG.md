# Changelog

## [5.1.0](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.0...v5.1.0) (2026-06-29)


### Miscellaneous

* release 5.1.0 ([#65](https://github.com/devicecloud-dev/dcd-cli/issues/65)) ([708bf35](https://github.com/devicecloud-dev/dcd-cli/commit/708bf35f5b5e34d5b7d0dd0a3e74f3b695b509c2))

## [5.0.0](https://github.com/devicecloud-dev/dcd-cli/compare/v4.4.9...v5.0.0) (2026-06-25)


### Features

* add dcd-mcp stdio MCP server ([67366c0](https://github.com/devicecloud-dev/dcd-cli/commit/67366c0bc43a105712f4f3245ea045dd227684b8))
* add dcd-mcp stdio MCP server ([0a08f3a](https://github.com/devicecloud-dev/dcd-cli/commit/0a08f3ab64aea753afa6b72bd4a4bc7b8b7af25d))
* realtime test status with polling backstop ([1284cb3](https://github.com/devicecloud-dev/dcd-cli/commit/1284cb31bfacde4a174fd3edd0063ccf018e2057))
* realtime test status with polling backstop ([74d76ce](https://github.com/devicecloud-dev/dcd-cli/commit/74d76ce41ad097425c6943bf8e11bd21774be7e7))
* submit flow tests via client-direct upload ([2e5445e](https://github.com/devicecloud-dev/dcd-cli/commit/2e5445eaa238b53bcf3013b38c9652cb70fbcb9a))
* submit flow tests via client-direct upload ([e9aaa51](https://github.com/devicecloud-dev/dcd-cli/commit/e9aaa51c6c10362e683d9259bf222f6d6b12692c))
* unified CLI output style + polling countdown/realtime indicator ([09d59e9](https://github.com/devicecloud-dev/dcd-cli/commit/09d59e9615d97a3d6ad404181a3557c8d63c39a2))
* unified CLI output style + polling countdown/realtime indicator ([5549daf](https://github.com/devicecloud-dev/dcd-cli/commit/5549dafb218d4f651b9506c390e91b6ed916e1f5))


### Bug Fixes

* harden node-apk/bplist-parser CJS named imports for ESM ([38e0018](https://github.com/devicecloud-dev/dcd-cli/commit/38e001892d981619a76cfa6a2d2b32177e23a012))
* **installer:** manage PATH via sentinel block, self-heal legacy markers ([9aa26c1](https://github.com/devicecloud-dev/dcd-cli/commit/9aa26c15cae3186bd54cbe8d1a4d66badd98a4f8))
* **installer:** manage PATH via sentinel block, self-heal legacy markers ([e848813](https://github.com/devicecloud-dev/dcd-cli/commit/e848813bfa63d7d7955ec23cc5b2ef71e45d57f0))
* use British spelling for clack cancellation message ([8841587](https://github.com/devicecloud-dev/dcd-cli/commit/8841587d81aa4ede1970897f1c5314ea936a07f3))
* use British spelling for clack cancellation message ([3a7aa61](https://github.com/devicecloud-dev/dcd-cli/commit/3a7aa6195ce5bf2715068ff2760f523b328117ed))
* v5 release blockers — installer, binary version, repeated flags, upgrade, CI output ([a041af6](https://github.com/devicecloud-dev/dcd-cli/commit/a041af61dd59a9c25f42f98b969a2654ddc32bd5))


### Miscellaneous

* seed 5.0.0 production release ([319af41](https://github.com/devicecloud-dev/dcd-cli/commit/319af41e06a2e5c507f3e50dea0cf2afed5786bf))
* seed 5.0.0-beta.0 release ([b98a320](https://github.com/devicecloud-dev/dcd-cli/commit/b98a320e88dfdca491dd231a43ee6a7c0acd216d))

## [5.0.0-beta.3](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.0-beta.2...v5.0.0-beta.3) (2026-06-25)


### Features

* **live:** add a beta warning to `dcd live start` ([#54](https://github.com/devicecloud-dev/dcd-cli/issues/54)) ([a02584f](https://github.com/devicecloud-dev/dcd-cli/commit/a02584fe574fd687539d0be424c658c743aaae8a))


### Bug Fixes

* stop CLA locking release PRs (breaks release pipeline) ([#52](https://github.com/devicecloud-dev/dcd-cli/issues/52)) ([bd60298](https://github.com/devicecloud-dev/dcd-cli/commit/bd6029847b9eccfe9078ae21b40ad548e4ef8985))

## [5.0.0-beta.2](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.0-beta.1...v5.0.0-beta.2) (2026-06-24)


### Features

* **cloud:** drop legacy Maestro removed-versions block; soft-warn on deprecated 1.39.5/1.41.0 ([62c7672](https://github.com/devicecloud-dev/dcd-cli/commit/62c767295cb99339cbc3326c6bf319caf637d649))
* **cloud:** Maestro deprecation — drop legacy hard-block, soft-warn 1.39.5/1.41.0 ([ee995e7](https://github.com/devicecloud-dev/dcd-cli/commit/ee995e7ebefb7ddfd3678bea27adf4751a39e879))
* **cloud:** warn on deprecated iOS 16 (removal 2026-08-23) ([d794695](https://github.com/devicecloud-dev/dcd-cli/commit/d794695529c9dce938d16199e336d6698e21bff9))
* **cloud:** warn on deprecated iOS 16 (removal 2026-08-23) ([ea62f72](https://github.com/devicecloud-dev/dcd-cli/commit/ea62f724653b3e1173036c4abe66aa4e110c0a0e))


### Bug Fixes

* **ci:** keep dependabot and fork PRs green ([#46](https://github.com/devicecloud-dev/dcd-cli/issues/46)) ([dc87257](https://github.com/devicecloud-dev/dcd-cli/commit/dc872572846fbe0d9760902cda3380edee1ef2ff))
* **installer:** make beta opt-in, add stable/beta channels ([ec16bcc](https://github.com/devicecloud-dev/dcd-cli/commit/ec16bccd044f892f7fd1997aac977c77aa14376d))
* **installer:** make beta opt-in, default to stable channel ([88c3532](https://github.com/devicecloud-dev/dcd-cli/commit/88c3532f8a3c6de7210c2d66d819838ea4c99fad))
* suppress refresh countdown in quiet mode ([10eade4](https://github.com/devicecloud-dev/dcd-cli/commit/10eade42c80f42df05b165e3f83e1190aeabfd80))
* suppress refresh countdown in quiet mode ([d543981](https://github.com/devicecloud-dev/dcd-cli/commit/d543981b0e2dc274d664bf378da4154a77a6d2e8))
* **upgrade:** compare prerelease versions per SemVer ([f77841f](https://github.com/devicecloud-dev/dcd-cli/commit/f77841fae397e3b8d88b7ba6876b98f65026f089))
* **upgrade:** compare prerelease versions per SemVer ([6c533e7](https://github.com/devicecloud-dev/dcd-cli/commit/6c533e7ae9e55b64e5ffe63a9c9a6934e9250938))
* v5 release blockers — installer, binary version, repeated flags, upgrade, CI output ([d780e55](https://github.com/devicecloud-dev/dcd-cli/commit/d780e55093b314fe9855890db145188e2735beb3))
* v5 release blockers — installer, binary version, repeated flags,… ([#51](https://github.com/devicecloud-dev/dcd-cli/issues/51)) ([d780e55](https://github.com/devicecloud-dev/dcd-cli/commit/d780e55093b314fe9855890db145188e2735beb3))

## [5.0.0-beta.1](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.0-beta.0...v5.0.0-beta.1) (2026-06-23)


### Features

* add dcd-mcp stdio MCP server ([67366c0](https://github.com/devicecloud-dev/dcd-cli/commit/67366c0bc43a105712f4f3245ea045dd227684b8))
* add dcd-mcp stdio MCP server ([0a08f3a](https://github.com/devicecloud-dev/dcd-cli/commit/0a08f3ab64aea753afa6b72bd4a4bc7b8b7af25d))
* realtime test status with polling backstop ([1284cb3](https://github.com/devicecloud-dev/dcd-cli/commit/1284cb31bfacde4a174fd3edd0063ccf018e2057))
* realtime test status with polling backstop ([74d76ce](https://github.com/devicecloud-dev/dcd-cli/commit/74d76ce41ad097425c6943bf8e11bd21774be7e7))
* submit flow tests via client-direct upload ([2e5445e](https://github.com/devicecloud-dev/dcd-cli/commit/2e5445eaa238b53bcf3013b38c9652cb70fbcb9a))
* submit flow tests via client-direct upload ([e9aaa51](https://github.com/devicecloud-dev/dcd-cli/commit/e9aaa51c6c10362e683d9259bf222f6d6b12692c))
* unified CLI output style + polling countdown/realtime indicator ([09d59e9](https://github.com/devicecloud-dev/dcd-cli/commit/09d59e9615d97a3d6ad404181a3557c8d63c39a2))
* unified CLI output style + polling countdown/realtime indicator ([5549daf](https://github.com/devicecloud-dev/dcd-cli/commit/5549dafb218d4f651b9506c390e91b6ed916e1f5))


### Bug Fixes

* harden node-apk/bplist-parser CJS named imports for ESM ([38e0018](https://github.com/devicecloud-dev/dcd-cli/commit/38e001892d981619a76cfa6a2d2b32177e23a012))
* **installer:** manage PATH via sentinel block, self-heal legacy markers ([9aa26c1](https://github.com/devicecloud-dev/dcd-cli/commit/9aa26c15cae3186bd54cbe8d1a4d66badd98a4f8))
* **installer:** manage PATH via sentinel block, self-heal legacy markers ([e848813](https://github.com/devicecloud-dev/dcd-cli/commit/e848813bfa63d7d7955ec23cc5b2ef71e45d57f0))
* use British spelling for clack cancellation message ([8841587](https://github.com/devicecloud-dev/dcd-cli/commit/8841587d81aa4ede1970897f1c5314ea936a07f3))
* use British spelling for clack cancellation message ([3a7aa61](https://github.com/devicecloud-dev/dcd-cli/commit/3a7aa6195ce5bf2715068ff2760f523b328117ed))

## [5.0.0-beta.0](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.0...v5.0.0-beta.0) (2026-06-19)


### Miscellaneous

* seed 5.0.0-beta.0 release ([b98a320](https://github.com/devicecloud-dev/dcd-cli/commit/b98a320e88dfdca491dd231a43ee6a7c0acd216d))
