# Changelog

## [5.4.1-beta.1](https://github.com/devicecloud-dev/dcd-cli/compare/v5.4.0-beta.0...v5.4.1-beta.1) (2026-09-10)


### Features

* **device:** add iOS 27 and the iPhone 17 family ([#131](https://github.com/devicecloud-dev/dcd-cli/issues/131)) ([1333960](https://github.com/devicecloud-dev/dcd-cli/commit/133396051511997bd03efe0aeaf2930dd74c83de))
* **device:** drop the iPhone 17 family ([#134](https://github.com/devicecloud-dev/dcd-cli/issues/134)) ([38f6dfa](https://github.com/devicecloud-dev/dcd-cli/commit/38f6dfa8c6724be9ce709ef6845e97911a4ee0da))


### Bug Fixes

* **ci:** point the CLA check at our node24 fork ([#135](https://github.com/devicecloud-dev/dcd-cli/issues/135)) ([3222dda](https://github.com/devicecloud-dev/dcd-cli/commit/3222ddaabc6a133eb88b73e768d992a36ae89118))
* **deps:** adopt bplist-parser 0.5 named exports ([#143](https://github.com/devicecloud-dev/dcd-cli/issues/143)) ([9b5f751](https://github.com/devicecloud-dev/dcd-cli/commit/9b5f7510ea1b9f9b1277763e040b84517c91b3c4))
* **deps:** refresh audit overrides to the patched versions ([#141](https://github.com/devicecloud-dev/dcd-cli/issues/141)) ([7ccb0c9](https://github.com/devicecloud-dev/dcd-cli/commit/7ccb0c98e1834d2689f53c001383c8050c99e17f))


### Dependencies

* bump the minor-and-patch group across 1 directory with 4 updates ([#133](https://github.com/devicecloud-dev/dcd-cli/issues/133)) ([0d2234a](https://github.com/devicecloud-dev/dcd-cli/commit/0d2234a55965b4840c6de1a8ddcc3e4933aab237))
* bump the minor-and-patch group across 1 directory with 5 updates ([#144](https://github.com/devicecloud-dev/dcd-cli/issues/144)) ([9a4ad49](https://github.com/devicecloud-dev/dcd-cli/commit/9a4ad49acad68d90f27c947bcb43db464bd1ef43))


### Miscellaneous

* release 5.4.1-beta.1 ([#137](https://github.com/devicecloud-dev/dcd-cli/issues/137)) ([fc43dc6](https://github.com/devicecloud-dev/dcd-cli/commit/fc43dc6e62a265b9860b92b5a8ace750bcead393))

## [5.4.0-beta.0](https://github.com/devicecloud-dev/dcd-cli/compare/v5.3.1-beta.2...v5.4.0-beta.0) (2026-08-24)


### ⚠ BREAKING CHANGES

* remove iOS 16 ([#126](https://github.com/devicecloud-dev/dcd-cli/issues/126))

### Features

* remove iOS 16 ([#126](https://github.com/devicecloud-dev/dcd-cli/issues/126)) ([fcfa524](https://github.com/devicecloud-dev/dcd-cli/commit/fcfa524ff5213f1ec8ff4b86ef61826c78d6e875))


### Dependencies

* bump the minor-and-patch group with 6 updates ([#121](https://github.com/devicecloud-dev/dcd-cli/issues/121)) ([1c07fc1](https://github.com/devicecloud-dev/dcd-cli/commit/1c07fc14a48e7cc29c6deb56f0ad4aa533794f25))


### Miscellaneous

* release the iOS 16 removal as 5.4.0, not 6.0.0 ([#127](https://github.com/devicecloud-dev/dcd-cli/issues/127)) ([a60611d](https://github.com/devicecloud-dev/dcd-cli/commit/a60611d388fd6c570a5548bd3ece997afc4ae926))

## [5.3.1-beta.2](https://github.com/devicecloud-dev/dcd-cli/compare/v5.3.1-beta.1...v5.3.1-beta.2) (2026-08-13)


### Bug Fixes

* **cloud:** reject malformed executionOrder instead of silently runni… ([#117](https://github.com/devicecloud-dev/dcd-cli/issues/117)) ([1973a42](https://github.com/devicecloud-dev/dcd-cli/commit/1973a42a1c4c01d0db29a106aa9c6a8f82da6853))
* **cloud:** reject malformed executionOrder instead of silently running in parallel ([1973a42](https://github.com/devicecloud-dev/dcd-cli/commit/1973a42a1c4c01d0db29a106aa9c6a8f82da6853)), closes [#110](https://github.com/devicecloud-dev/dcd-cli/issues/110)

## [5.3.1-beta.1](https://github.com/devicecloud-dev/dcd-cli/compare/v5.2.0-beta.4...v5.3.1-beta.1) (2026-08-10)


### Bug Fixes

* **cloud:** exclude config-shaped files from flow discovery ([#114](https://github.com/devicecloud-dev/dcd-cli/issues/114)) ([13d01ee](https://github.com/devicecloud-dev/dcd-cli/commit/13d01eee5d0146049373011f304be2647e7f510b)), closes [#99](https://github.com/devicecloud-dev/dcd-cli/issues/99)


### Dependencies

* bump the minor-and-patch group with 5 updates ([#112](https://github.com/devicecloud-dev/dcd-cli/issues/112)) ([2223dd4](https://github.com/devicecloud-dev/dcd-cli/commit/2223dd48bcb8e19d28a842df807939f5bc9879c5))


### Miscellaneous

* pin the next dev beta to 5.3.1-beta.1 ([#116](https://github.com/devicecloud-dev/dcd-cli/issues/116)) ([6858220](https://github.com/devicecloud-dev/dcd-cli/commit/6858220e3dc54ae5e505e4dd84aa3fedf3ca2e6e))

## [5.2.0-beta.4](https://github.com/devicecloud-dev/dcd-cli/compare/v5.2.0-beta.3...v5.2.0-beta.4) (2026-08-06)


### Features

* **artifacts:** prefer server-assembled bundle delivery for downloads ([#93](https://github.com/devicecloud-dev/dcd-cli/issues/93)) ([f6fcfaf](https://github.com/devicecloud-dev/dcd-cli/commit/f6fcfafa4ce5935decd15952107cd3ac1ebaad7b))
* client-side envelope encryption of binaries, flow zips & env vars ([#94](https://github.com/devicecloud-dev/dcd-cli/issues/94)) ([a34d9d4](https://github.com/devicecloud-dev/dcd-cli/commit/a34d9d4516a985e92e4e07ec54f703358af45f6e))
* **device:** add Android API level 37 (Android 17) ([#107](https://github.com/devicecloud-dev/dcd-cli/issues/107)) ([3d24435](https://github.com/devicecloud-dev/dcd-cli/commit/3d2443533119f9a41fe1aa46967c941818584c73))
* **upload:** dedup encrypted binaries on the plaintext hash ([#101](https://github.com/devicecloud-dev/dcd-cli/issues/101)) ([6e244a9](https://github.com/devicecloud-dev/dcd-cli/commit/6e244a90dedff47c0bba5b1041fa6da4fe2e9d77))


### Bug Fixes

* **deps:** resolve pnpm audit failures in transitive dependencies ([#89](https://github.com/devicecloud-dev/dcd-cli/issues/89)) ([cc5ee4d](https://github.com/devicecloud-dev/dcd-cli/commit/cc5ee4d4595fd4b3e6abd9e3ad0d50b2a7db84ca))
* **deps:** resolve three new transitive security advisories ([#106](https://github.com/devicecloud-dev/dcd-cli/issues/106)) ([f7934b0](https://github.com/devicecloud-dev/dcd-cli/commit/f7934b0743a4bf561f876082f124a87acc41041a))


### Dependencies

* bump chalk from 5.6.2 to 6.0.0 ([#98](https://github.com/devicecloud-dev/dcd-cli/issues/98)) ([1b29d2d](https://github.com/devicecloud-dev/dcd-cli/commit/1b29d2d5ec58d391c04dc29ea2e4c989a0a66e0c))
* bump the minor-and-patch group across 1 directory with 5 updates ([#100](https://github.com/devicecloud-dev/dcd-cli/issues/100)) ([47b9d90](https://github.com/devicecloud-dev/dcd-cli/commit/47b9d905daa49d4d8491b1a8d710545e05822bb0))
* bump the minor-and-patch group across 1 directory with 7 updates ([#92](https://github.com/devicecloud-dev/dcd-cli/issues/92)) ([f333be9](https://github.com/devicecloud-dev/dcd-cli/commit/f333be97d848e2cd40cbff124584de5af4f89a88))
* patch js-yaml and brace-expansion DoS advisories ([#95](https://github.com/devicecloud-dev/dcd-cli/issues/95)) ([a4f11ff](https://github.com/devicecloud-dev/dcd-cli/commit/a4f11ff8d771de213b5acdb4f6fcf40f665e5d7b))


### Code Refactoring

* **cloud:** remove mitmproxy flags ([#102](https://github.com/devicecloud-dev/dcd-cli/issues/102)) ([3888fc5](https://github.com/devicecloud-dev/dcd-cli/commit/3888fc5cb0ea06828ed94c2d672e0215492f5147))

## [5.2.0-beta.3](https://github.com/devicecloud-dev/dcd-cli/compare/v5.2.0-beta.2...v5.2.0-beta.3) (2026-07-13)


### Bug Fixes

* **cloud:** refuse a device matrix on an API that cannot honour it ([#80](https://github.com/devicecloud-dev/dcd-cli/issues/80)) ([5560158](https://github.com/devicecloud-dev/dcd-cli/commit/5560158389440735354be963098a2704a8610040))

## [5.2.0-beta.2](https://github.com/devicecloud-dev/dcd-cli/compare/v5.2.0-beta.1...v5.2.0-beta.2) (2026-07-13)


### Code Refactoring

* **cloud:** rename --ios-config/--android-config to --ios-device-matrix/--android-device-matrix ([#77](https://github.com/devicecloud-dev/dcd-cli/issues/77)) ([fc3ea3f](https://github.com/devicecloud-dev/dcd-cli/commit/fc3ea3f9fa41f51a640827dbe845deca7b355924))

## [5.2.0-beta.1](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.1-beta.1...v5.2.0-beta.1) (2026-07-13)


### Features

* **cloud:** device matrix via repeated --ios-config/--android-config… ([#75](https://github.com/devicecloud-dev/dcd-cli/issues/75)) ([b78a1dc](https://github.com/devicecloud-dev/dcd-cli/commit/b78a1dc92f61428e6c42a914c0779886d3713e79))


### Bug Fixes

* recover cleanly when the stored session is dead ([#72](https://github.com/devicecloud-dev/dcd-cli/issues/72)) ([7fd7748](https://github.com/devicecloud-dev/dcd-cli/commit/7fd7748632fdce2a0f417ee9af73243de5d4b1a8))


### Dependencies

* bump the minor-and-patch group across 1 directory with 9 updates ([#71](https://github.com/devicecloud-dev/dcd-cli/issues/71)) ([cfd9fe2](https://github.com/devicecloud-dev/dcd-cli/commit/cfd9fe23fcee003535f73ab72754eb5aeba5cec5))


### Code Refactoring

* route notice rendering through ui (add ui.deprecation) ([#66](https://github.com/devicecloud-dev/dcd-cli/issues/66)) ([1d331b4](https://github.com/devicecloud-dev/dcd-cli/commit/1d331b4e5e1e02cb86615df6e0315a5171e012ec))


### Miscellaneous

* release 5.2.0-beta.1 ([#76](https://github.com/devicecloud-dev/dcd-cli/issues/76)) ([bc9c61f](https://github.com/devicecloud-dev/dcd-cli/commit/bc9c61f2fc20074980798ce155d14b0571ddbecb))

## [5.0.1-beta.1](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.0-beta.4...v5.0.1-beta.1) (2026-06-26)


### Bug Fixes

* notices render polish ([#60](https://github.com/devicecloud-dev/dcd-cli/issues/60)) ([c99f040](https://github.com/devicecloud-dev/dcd-cli/commit/c99f040baaf069de948c8c982b0dbbeb43218783))


### Miscellaneous

* release 5.0.1-beta.1 ([#62](https://github.com/devicecloud-dev/dcd-cli/issues/62)) ([5adec18](https://github.com/devicecloud-dev/dcd-cli/commit/5adec1855f523ee2396377d44416d09df0ef49e5))

## [5.0.0-beta.4](https://github.com/devicecloud-dev/dcd-cli/compare/v5.0.0-beta.3...v5.0.0-beta.4) (2026-06-26)


### Features

* render DB-driven notices and forward CLI/CI identity ([#58](https://github.com/devicecloud-dev/dcd-cli/issues/58)) ([10dfdbf](https://github.com/devicecloud-dev/dcd-cli/commit/10dfdbf9a5d0ebf12568e90a1fad623213175368))

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
