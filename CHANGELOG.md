# Changelog

## [5.1.0](https://github.com/moropo-com/cli/compare/v5.0.0...v5.1.0) (2026-06-16)


### Features

* **login:** confirm before clobber, faster polling, surface auth errors ([6b0f616](https://github.com/moropo-com/cli/commit/6b0f616a5a36844b468ac34293a23745de55113c))
* **login:** pick org in the CLI, hide ids from users ([4130c3e](https://github.com/moropo-com/cli/commit/4130c3ec5afcffe191fa1e2f2621473e8621c7c4))
* **login:** replace loopback with PKCE device-code polling ([135f486](https://github.com/moropo-com/cli/commit/135f48650bf466d8a60b157e8ce9c9932db2718a))
* ship CLI lifecycle/error telemetry to /cli/logs ([001d3ba](https://github.com/moropo-com/cli/commit/001d3ba2b70453d16402fd20a3500e4c53b59292))
* standalone binary distribution via curl|sh ([f491caf](https://github.com/moropo-com/cli/commit/f491caf40c5710a7110be91938281c5c2c43518d))


### Bug Fixes

* address correctness and security findings from full code review ([db33830](https://github.com/moropo-com/cli/commit/db3383088fb478559333bf0c2d3ba3b1b5253110))
* address full code-review findings (correctness, security, CI) ([2bf88a1](https://github.com/moropo-com/cli/commit/2bf88a189611971462329fbaf1cb13f413c5e75c))
* create parent directories when writing JSON output files ([ba895cc](https://github.com/moropo-com/cli/commit/ba895ccfaccfe3cec7244875228b89e0f9d71001))
* **deps:** bump brace-expansion and ws overrides for CVE patches ([5692c9d](https://github.com/moropo-com/cli/commit/5692c9dfddc8955b3e93d2b5c2e7b8de30b2f556))
* **deps:** override esbuild to &gt;=0.28.1 for GHSA-gv7w-rqvm-qjhr ([cdd9e7f](https://github.com/moropo-com/cli/commit/cdd9e7f2a247654eb03f420f4dbda880284581a6))
* **deps:** override esbuild to &gt;=0.28.1 for GHSA-gv7w-rqvm-qjhr ([f476ea8](https://github.com/moropo-com/cli/commit/f476ea8c0522a037366fd681f304d88e3741ffdb))
* enable TypeScript strict mode and type-check tests in CI ([369eb2a](https://github.com/moropo-com/cli/commit/369eb2aebb766dab9cd87d82c96edd65116d2a35))
* enable TypeScript strict mode and type-check tests in CI ([bb1d769](https://github.com/moropo-com/cli/commit/bb1d7692ff7c742da62f8b0b7b1951aa98e3d6b0))
* honor logged-in env for api-url, stop live menu leak, fix --env docs ([4fee5a6](https://github.com/moropo-com/cli/commit/4fee5a6fea6bd431d01818a0368e131858b44763))
* honor logged-in env for api-url, stop live menu leak, fix --env docs ([8c9fee0](https://github.com/moropo-com/cli/commit/8c9fee092fa7d3df11f75e3b9d58206acc1b7b5f))
* **login:** accept POST /callback with JSON body + origin-scoped CORS ([79ec77d](https://github.com/moropo-com/cli/commit/79ec77defb99ac7f3990f90a60d123f424a93d9b))
* stream uploads from disk instead of holding binaries in memory ([0af9d50](https://github.com/moropo-com/cli/commit/0af9d501d95e0c3c0a8c27ab3a03ac259be94381))
* stream uploads from disk instead of holding binaries in memory ([91b4332](https://github.com/moropo-com/cli/commit/91b4332c4a83e8ed24589f57b39d45dc9a441eec))


### Dependencies

* swap app-info-parser for node-apk, drop consola/ts-node/@types/tar ([15bafe3](https://github.com/moropo-com/cli/commit/15bafe38e2682e9a0898f3946b754ee583dc43e6))
* swap archiver for yazl, glob for fs.globSync ([a420a95](https://github.com/moropo-com/cli/commit/a420a95a40c9276cfed0dfda41e691069a9e46fc))


### Code Refactoring

* move live session types to src/types/domain ([f0082fa](https://github.com/moropo-com/cli/commit/f0082fa8cb6877e8af1ecd594c5279f56162c73a))
* route live session commands through ApiGateway ([6757aa5](https://github.com/moropo-com/cli/commit/6757aa51a5d2df537a21c35a998876e8194fdb92))
* route live session commands through ApiGateway ([c63f3c2](https://github.com/moropo-com/cli/commit/c63f3c22701f788430a4e104ed8c056bbabb11d6))
