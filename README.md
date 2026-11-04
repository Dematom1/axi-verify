# axi-verify

Shared packed-process checks and ast-grep rules for Dematom1's AXI repositories. `axi-verify` is a development dependency, not part of a tool's runtime. Publication and consumer integration are separate work.

## Verify a tool

Run the tool's existing build gate first. In particular, Argo CD and Kubernetes do not build through `prepack`.

```sh
npm run build
axi-verify packed
axi-verify static
```

`packed` runs `npm pack` with the package's existing lifecycle scripts. It selects the archive from that command's JSON result. It never searches for an old archive.

For a staged release archive, use its absolute path and the checked-out tool's full commit SHA:

```sh
axi-verify packed --tarball /absolute/tool.tgz \
	--expected-git-head "$(git rev-parse HEAD)" \
	--evidence-dir /absolute/evidence
```

Archive mode never repacks. A missing or different archive `gitHead` fails before installation. `--expected-git-head` requires `--tarball`. Without a release SHA, evidence remains labelled pre-release or supplied-archive evidence. Registry publication is never inferred from a local pack.

`static` scans the current directory with this package's absolute rule configuration and installed ast-grep binary. It excludes dependencies, build output, generated skills, and test fixtures. It has no automatic fixes.

Commands return TOON on stdout. Exit codes are 0 for a passing suite or help, 1 for a failed verification or prerequisite, and 2 for invalid arguments. `--version`, `-v`, and `-V` return the package version.

## Supported profiles

`lib/profiles.mjs` selects the profile by the archive's package name. Unknown names fail. Profiles define actual commands, help routes, structured failure codes, list fields, and retry fixtures:

- `argocd-axi`: applications, local context allowlist, and session hooks.
- `argo-workflows-axi`: workflows and session hooks. `setup status` is unsupported.
- `datadog-axi`: monitor search and user or project session hooks.
- `terraform-axi`: resource addresses and types, local binary configuration, and SessionStart integrations. No SessionEnd feature is required.
- `search-console-axi`: local credential registration and the two-field `setup check` sites list. The current home command returns site counts and analytics, not that list. `setup hooks` must remain unsupported.
- `k8s-axi`: pod diagnostics and session hooks. Its local pack does not establish npm publication.
- `axi-verify`: static checks, help, version, and repeated packed verification against a generated fixture archive.

The normal-command checks exercise each profile's listed commands before and after setup, plus help and version. They are regression samples, not exhaustive coverage of every argument combination.

## Idempotency checks

`lib/retry-profiles.mjs` declares each command's class, arguments, input, and fixture state. The inventory check captures the tool's SDK command registration without dispatching data commands. It checks advertised nested help and command-refusal registries against the declared fixtures. New registered or advertised commands without fixtures fail. Discovered non-refused help routes also get repeat-read checks. This is bounded command coverage, not proof of every argument combination or an unadvertised branch inside a dispatcher.

Each fixture has its own HOME, XDG paths, working directory, native state, and call log. Auxiliary context bins have explicit read fixtures too. The new writable-grant fixture uses a real terminal through Python 3.9 or later's standard-library `pty` module. Python runs in isolated mode, and no confirmation bypass is added. Both invocations share that fixture. Checks include:

- Reads must exit 0, return identical stdout and stderr, submit no mutations, and leave wrapper files unchanged. Only declared structured time fields are ignored. The current declarations cover workflow-list `age` and application-wait elapsed text.
- Desired-state native writes must establish the fixture's target state. A retry must exit 0, report `already-done` or `in-progress` with current state, submit no extra mutation, and rewrite no wrapper files. Additional cases seed a committed mutation with a lost response, legitimate partial states, an uncommitted native failure followed by recovery, and persistent upstream authentication failures.
- Waits include satisfied and transient fixtures. A satisfied retry must not repeat a poll or fire a positive-duration timeout. These checks use call and timer events, not a machine-dependent runtime threshold.
- Setup and uninstall run twice. The second invocation must preserve file contents, modes, and modification times from the first invocation. Uninstall starts from an installed fixture.
- Refusals preserve their documented nonzero exit and structured code. Neither invocation may call a backend or change files.

File snapshots include SHA-256 content hashes, modes, and nanosecond modification times. Directory modes are checked too. Observation logs and synthetic native stores are excluded from wrapper state. Completed pairs retain both process results and their content snapshots, including failed commands.

Refresh is repeatable reconciliation, including hard refresh. Resource actions have a state-scoped retry contract, not exactly-once delivery. A Progressing resource suppresses another submission, but a completed restart can run again. Concurrent retries before progress is visible are not certified. `axi-verify packed` is also reconciliation: it reruns verification and writes its explicitly requested evidence directory without changing source or user configuration.

Update fixtures inject a registry response and a fake npm installer inside a disposable global prefix. They test an already-current version, the npm lookup fallback, and an upgrade followed by an already-current retry. The SDK's documented `already on the latest version` message is accepted for update only. No real installer or update runs. Kubernetes declares self-update as a refusal.

The family uses the existing per-tool failure and known-limitation reporting. CLI `retry_limits` and summary `retryLimits` report event and reconciliation limits separately from SDK limitations. It does not exempt a defect because a published tool currently fails. To collect findings for supplied archives:

```sh
npm run proof:idempotency -- /absolute/evidence /absolute/archives/*.tgz
```

`idempotency-summary.json` contains per-tool verdict counts, findings, and evidence paths for the corresponding tool's fix PR. Archive identity and publication claims remain those recorded by `packed`.

## Packed contract

The runner installs the exact archive with scripts disabled into a unique scratch prefix. It resolves every declared executable through npm's installed bin links and verifies executable permissions and target identity. Auxiliary context bins are invoked as local views, not treated as public version or help interfaces.

Every row uses a fresh HOME and working directory. Child processes receive explicit agent, Google, npm, and Kubernetes paths, closed stdin, a timeout, and a bounded output buffer. Data-command PATH contains the fixture directory first, including Node, native backends, and package-manager shims, followed only by `/bin` and `/usr/bin` for shell compatibility. The self-packed reconciliation fixture uses the host PATH for acquisition of a generated dependency-free archive. Its nested data-command children still use fixture-first PATH. Startup verifies every named backend resolves to its fixture. Inherited credentials, Node options, and agent paths are discarded. Other commands present in those host directories and absolute host executable paths are not contained; this is not a subprocess sandbox.

Checks cover:

- Exact primary-bin version aliases, top-level and profile route help, and invalid flags before dependency work.
- Writable setup controls, repeat installation, status read-back, and seeded removal.
- Denied `.claude`, `.codex`, `.config`, and all-writes cases. Project cases also lock project agent directories. Existing nested files are locked too. Independent probes must receive EACCES or EPERM.
- Unreadable and malformed settings, missing and unreadable credential files, local config persistence, and unrelated-setting preservation.
- JSON hook entries, TOML Codex feature settings, and managed OpenCode plugin files reopened independently of the tool's status helper.
- Stored hook commands executed from an unrelated directory without an AXI executable on PATH. SessionEnd receives a synthetic transcript and must change a persisted session file.
- Repair after relocation to a path with spaces and a quote, including a generated legacy hook. A real offline `npm exec --package <archive>` invocation follows an isolated dependency-cache warmup.
- Nonempty default lists containing healthy and problem fixtures, exact default fields, and explicit expansion where supported. Lists with two fields remain valid.

The hook-model check is strict. Normal commands must not change files anywhere in the disposable HOME or scratch root (excluding observation-owned fixture and network logs). Path, type, size, mode, and modification-time snapshots detect filesystem changes without filesystem-call mocks. Two `setup hooks` runs must leave exactly one managed entry per integration. Removal must remove **all entries installed by setup**, while another tool's hooks and settings survive. This supersedes the original plan's SessionEnd-only exemption for Argo CD and Datadog. Those published implementations can fail until their complete-removal fixes ship.

Only non-root Linux and macOS are supported. Root, ineffective locks, unavailable fixtures, unexpected external calls, malformed output, and timeouts fail rather than skip.

### CLAUDE_CONFIG_DIR SessionStart

The current axi-sdk-js SessionStart installer uses `~/.claude` rather than `CLAUDE_CONFIG_DIR`. If a custom-directory hook-model row observes no selected-directory SessionStart and exactly one managed SessionStart in the default directory after successful explicit setup, it reports `known-limitation` with this explanation as its pointer. This is an SDK limitation, not a tool defect; no upstream issue is filed.

Known-limitation-only rows have `passed: false` but are listed separately from tool failures in `summary.json` (`knownLimitations`) and CLI output (`known_limitations`). They do not fail the suite. If the same composite row also observes ordinary-command writes or unexpected I/O, that independent defect still fails the row, while the SDK diagnostic remains separately reported with `rowStatus: failed`; the SessionStart limitation itself is never counted as a tool defect. The remainder of that custom-directory lifecycle row is **not verified**, not marked passing; the default-directory row still runs the full lifecycle. Normal-command writes or unexpected I/O remain failures and cannot be hidden by this classification. A missing default-directory fallback remains a tool failure.

## External boundaries and safety

No cluster, Argo CD server, Datadog account, Google account, or Terraform backend is used. The fixture-first PATH intercepts the named backends; other host commands in `/bin` and `/usr/bin` remain available. Datadog uses its loopback HTTP override. Search Console keeps real credential parsing and rendering, with only the Google client's request method replaced in a child-process preload. The Node preload rejects TCP connections except the fixture server's exact loopback port, and refuses Node UDP sends and DNS lookup or resolution calls. The nested verifier may resolve the literal `127.0.0.1` address to start its own fixture server. That literal-address lookup does not contact DNS. Datadog keyring access uses a synthetic file store instead of the OS keychain. This covers only Node processes that receive `NODE_OPTIONS`; a child launched with an environment that removes it loads no preload and is not covered. The Datadog HTTP fixture permits only explicit read endpoints and search-style POST reads. Other paths and methods fail their rows. Fixture credentials are synthetic. Npm registry reads are confined to package acquisition and cache warmup, with package scripts disabled during installation.

This is a regression verifier for trusted family packages, not an operating-system security sandbox for malicious archives. A package's local `npm pack` can run its existing lifecycle scripts. Absolute host executable paths and arbitrary native code are not contained.

Cleanup restores scratch modes and removes only the runner's scratch tree. Evidence stays outside that tree. No user agent configuration, consumer repository, cluster state, npm publication, or infrastructure settings are changed.

## Evidence

By default, evidence is written beneath `.axi-evidence/<timestamp>` in the caller's directory. `--evidence-dir` selects another location. Preserve it as a CI artifact even on failure.

`identity.json` records the archive SHA-512, package version, source claim, archive `gitHead`, both manifests, runtime versions, platform, architecture, and uid. Numbered row files contain argv, the sanitized environment, process output and exit, decoded output, before/after filesystem metadata snapshots, probes, observations, and fixture request records. `summary.json` lists every verdict. A fatal prerequisite produces `fatal.json`, never a passing summary.

The published-proof script additionally saves registry metadata, archive bytes, and their verified registry integrity. It records the provenance-attestation URL but does not claim independent signature verification.

## Test the verifier

```sh
npm ci
npm test
npm run proof:history -- /absolute/static-proof
npm run proof:runtime -- /absolute/runtime-proof
npm run proof:published -- /absolute/catalog-proof /absolute/unpublished-k8s.tgz
```

`npm test` includes the normal-command hook-installation negative control, real permission denials, a deliberately ineffective lock, root rejection, same-content and absolute-shell side-effect writes, noisy prepack output, missing and incorrect `gitHead`, CLI validation, fixture-first PATH behavior, exact backend argument vectors, network refusal, unsupported-command side effects, plugin package directories, initialization cleanup, historical artifact identity, evidence destinations, and all four ast-grep families. Rule snapshots record exact matches. Historical fixtures include full source files, their repository revisions, and SHA-256 hashes in `tests/history/provenance.json`.

`proof:history` rejects those exact historical files and scans explicitly repaired disposable copies green. These are static proofs, not claims that the copied modules were executed. Evidence paths are canonicalized through existing parents, and paths inside this repository (including symlink aliases) are rejected before writing. `proof:runtime` compares intended historical Argo CD failures with the fixed published successor and mutates disposable Argo Workflows archives for version and invalid-flag controls. Two optional positional archive paths add the pre-fix Terraform and Argo Workflows source packs. Argo Workflows 0.1.12 is not available from npm at the baseline date, so that proof needs a local pack stamped with its exact historical SHA. Both supplied historical packs require the expected manifest `gitHead`; their proof records use `sourceClaim` and `sourceContentVerified: false`, because a matching manifest is not content verification against the source commit. Exit-code repairs can pass their bounded comparison while the complete current row remains red for a missing structured code or repair hint. It fails if a prerequisite error is mistaken for the intended regression. `proof:published` uses fixed registry versions, reports every failing row, and keeps Kubernetes labelled unpublished. A failing published product is not grandfathered to make this verifier green.

Static rules match bounded syntax, not full control flow or interprocedural behavior. The swallowed-error rule recognizes a direct positive `errors.length`/`failures.length` guard in the collecting block and inline uninstall callbacks that record or throw. Conditional nested propagation and callback references require review; these rules are regression tripwires, not a general proof of error handling. Identifier-backed hook matching covers same-block uses and top-level bindings used in blocks without a same-name local declaration or function parameter. It does not perform full TypeScript binding resolution.

The package CI runs tests, historical static and runtime proofs, and an installed-archive smoke check on Linux and macOS. The Linux lane also invokes the actual root precondition. Consumer wiring, release automation, required-check administration, and recurring maintenance are out of scope.
