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
- `terraform-axi`: resource addresses and types, local binary configuration, and session integrations. The pinned 0.1.3 behaviour manifest exposes its missing SessionEnd capture and other published defects; they are not exemptions.
- `search-console-axi`: local credential registration and the two-field `setup check` sites list. The current home command returns site counts and analytics, not that list. `setup hooks` must remain unsupported.
- `k8s-axi`: pod diagnostics and session hooks. Its local pack does not establish npm publication.
- `axi-verify`: static checks, help and version. Its executable command registry declares no setup or uninstall; packed verification is classified as repeatable reconciliation, not recursively invoked.

The normal-command checks exercise each profile's listed commands before and after setup, plus help and version. They are regression samples, not exhaustive coverage of every argument combination.

## Behaviour contracts

`packed` also reads `package/.axi/verify.json` from the installed archive. Commit `.axi/verify.json` at each consumer repository's root and include it in that package's `files` list. The working tree cannot supply a replacement for a different archive. Unknown schema fields, invalid fixture references, escaping paths, and missing command data fail closed. A present case must contain valid data: `null`, `false`, and empty containers cannot disable a check.

`lib/profiles.mjs` retains the existing safety, setup, and retry adapters. Its `contract` entries explicitly declare legacy-manifest availability. Only terraform-axi **0.1.3** has a pinned legacy manifest, at [`lib/legacy-contracts/terraform-axi-0.1.3.json`](lib/legacy-contracts/terraform-axi-0.1.3.json). Other versions and tools without a packed manifest fail with `unconfigured contract`; they are not silently skipped. The verifier ships its own [`.axi/verify.json`](.axi/verify.json).

The checks exercise each of the ten AXI principles:

| Principle | Packed behaviour |
| --- | --- |
| 1. Token-efficient output | Data, empty states, and errors decode as structured TOON on stdout. Version is the bare-text exception. No token-saving percentage is inferred. |
| 2. Minimal schemas | Exact default list fields, at most four columns, fixture identities, and explicitly requested expansion. |
| 3. Truncation | Long text and capped collections report original size and complete recovery commands. Full output matches the original fixture, independently of whether the default hint passes. Small untruncated output must not suggest its own full-output escape hatch. |
| 4. Aggregates | Totals match all fixture records, not the page size. Declared derived summaries match independently expected fixture counts. An empty aggregate mapping explicitly declares no relevant derived summary. |
| 5. Empty states | The zero-record fixture exits 0 and explicitly identifies the empty collection. |
| 6. Errors and exits | Success 0, operational failure 1, usage failure 2. Unknown flags, extra operands, and missing values run per command and alias. Errors name unknown flags and inline valid flags. A directory named like a flag must not turn it into an operand. Closed-stdin and PTY negative probes reject prompts. Real locks and unreadable files test filesystem failures. |
| 7. Ambient context | Existing explicit/idempotent setup and stored-hook checks remain. Context runs in project A, its child, project B, and an unrelated directory. SessionEnd must persist a synthetic session and expose it only in its project. |
| 8. Content first | Home identifies the executable and tool, shows seeded live state, suggests a complete next command, and changes when that state changes. |
| 9. Contextual disclosure | Lists, truncated output, and errors carry relevant complete argv templates. Truncation hints retain original selectors and are followed as argv, never through a shell. |
| 10. Help and version | Every declared route accepts help before/after valid and invalid input without dependency work. Help includes flags, declared defaults, and 2–3 distinct complete examples. An ESM module observer proves all three bare version aliases avoid the declared command graph, with a positive ordinary-command witness. No latency claim is made. |

This is bounded behaviour coverage, not certification of every clause of the AXI skill. Generated-skill consistency remains a source-build responsibility, not a packed-process claim. Manifest-declared defaults and graph roots must describe the actual implementation. The module observer fails if an ordinary invocation cannot witness those roots; it does not infer which modules are semantically heavy. Static rules remain syntax checks, not substitutes for these runs. No new general parser, truncation, or context-scoping ast-grep rule is added because those behaviours do not follow reliably from a local code pattern.

### Manifest fields

The JSON manifest is data only. It cannot supply scripts, new fixture executables, credentials, or network exceptions. Current fixture adapters are `terraform-local`, `kubernetes`, and `axi-verify`; `contract-fixture` is the verifier's minimal packed test tool. Adapter names belong to their package family. Other family profiles explicitly remain unconfigured for new behaviour cases until their command data and adapter are supplied.

| Field | Contract |
| --- | --- |
| `schema`, `package`, `fixture` | Literal schema `1`, exact installed package name, and a verifier-owned fixture adapter. |
| `graph` | Package-relative command-graph module paths. No absolute paths or traversal outside the installed package. |
| `commands` | Entries for every registered/advertised route and alias. Each entry has `route`, `flags` mapping names to `boolean` or `value`, `operands` with `min` and `max`, a complete `probe`, declared `defaults`, and 2–3 `examples` including the binary name. `max: null` explicitly means unlimited operands. Empty defaults must be documented as such in help. |
| `cases.home` | `argv` and expected live `markers`. The adapter changes live state for a second invocation. |
| `cases.list` | Entries with `argv`, JSON Pointer `collection` and `total`, exact `fields`, and complete `next` command templates. Optional `expanded` has its own argv and fields. Optional `aggregates` maps output pointers to adapter-owned expected-count keys; `{}` explicitly means none. |
| `cases.empty` | `list` index. Optional `argv` selects an explicit empty-state invocation; otherwise the same command receives zero backend records. |
| `cases.failure` | Entries with `argv`, `fault` (`missing-file`, `unreadable-file`, or `backend-denied`), expected structured `code`, and `next` templates. Expected exit is 1. |
| `cases.truncation` | Entries with `argv`, `kind` (`text` or `rows`), output `value` and original `size` pointers, `cap`, complete `full` argv, and `next` templates. The adapter supplies data above and below the cap. |
| `cases.readonly` | Ordinary argv arrays to run with HOME/config locked after fixture setup. Existing denial lanes separately test explicit denied mutations. |
| `cases.ambient` | Installed `bin`, `argv`, and scope `directory` or `project-root`; optional `capture` argv (run on that `bin`) when the tool captures sessions outside `context end`. The adapter supplies separate A/B data and a synthetic capture input. |
| `unsupported` | Explicit `check`, `status`, and `reason`. `unconfigured` fails coverage. `not-applicable` is reported separately and accepted only for verifier-known absent capabilities, not missing product features. All required case categories must exist or have an explicit declaration. |

The file-consuming Terraform, verifier, and minimal-test adapters require both missing-file and unreadable-file cases. An operational failure alone cannot silently stand in for an unreadable-input check.

Arguments are arrays, not shell strings. `{module}`, `{plan}`, `{address}`, `{context}`, and `{namespace}` expand only to disposable fixture inputs. JSON Pointers name decoded output fields. `next` templates include the tool name, preserve selectors, and may use dynamic placeholders such as `<address>`. A full-output command must resolve exactly to the declared fixture-local full invocation before execution. There is no shell evaluation.

For example, this filled Kubernetes command entry declares a pods usage/help probe. It is not an admission-complete manifest: the remaining installed routes, defaults, case data, and any missing adapter support must be supplied or explicitly marked `unconfigured`.

```json
{
  "route": ["pods"],
  "flags": {"--fields": "value", "--limit": "value", "--context": "value", "--namespace": "value", "--help": "boolean"},
  "operands": {"min": 0, "max": 0},
  "probe": ["pods", "--context", "{context}", "--namespace", "{namespace}", "--limit", "1"],
  "defaults": {"--context": "current context", "--namespace": "current namespace"},
  "examples": [["k8s-axi", "pods"], ["k8s-axi", "pods", "--context", "probe", "--namespace", "default", "--limit", "1"]]
}
```

Usage validation is generated from each command's own flag set. Missing-value probes preserve otherwise valid inputs and remove only the selected flag's value. The flag-shaped-directory probe replaces an operand, where available, rather than accidentally testing a missing required operand. The executable inventory is independent of manifest claims: a newly registered or advertised route requires command data. A missing manifest fails all ten principles' coverage rather than granting the older sampled checks admission status.

## Idempotency checks

`lib/retry-profiles.mjs` declares exact command routes, operation IDs, arguments, input and fixture state. The inventory imports each installed tool's executable operation/refusal tables directly, independently of help and process output. Every permitted write ID needs a twice-run native fixture or an event/reconcile fixture with a reason; the expected native operation must actually be observed. Operation witnesses come from the backend call log's executable and full argv, never fixture-supplied operation labels. Argo's shared `submit` command is distinguished by its reserved deterministic-resubmit label; refresh requires its explicit refresh flag. A read or generated `--help` row cannot cover a write. Local write routes are explicit profile adapters for the registered wrapper commands, since the SDK command map has no write-tier metadata. New registered or advertised command routes require exact classification; a parent fixture cannot cover a new child. Advertised routes must have explicit profile declarations; discovery never generates read/help fixtures or supplies operation coverage. This is bounded operation/command coverage, not proof of every argument combination.

Each fixture has its own HOME, XDG paths, working directory, native state, and call log. Auxiliary context bins have explicit read fixtures too. The new writable-grant fixture uses a real terminal through Python 3.9 or later's standard-library `pty` module. Python runs in isolated mode, and no confirmation bypass is added. Both invocations share that fixture. Checks include:

- Reads must exit 0, return identical stdout and stderr, submit no mutations, and leave wrapper files unchanged. Only declared structured time fields are ignored; each excluded field must still exist with its declared string type. The current declarations cover workflow-list `age` and application-wait elapsed text.
- Desired-state native writes must establish the fixture's target state. A retry must exit 0, report `already-done` or `in-progress` with current state, submit no extra mutation, and rewrite no wrapper files. Reported state values must match each fixture's native phase/policy or persisted configuration, not merely contain a state-like key. A new writable grant is checked in the actual config immediately after the first invocation. Additional cases seed a committed mutation with a lost response, legitimate partial states, an uncommitted native failure followed by recovery, and persistent upstream authentication failures.
- Waits include satisfied and transient fixtures. A satisfied retry must not repeat a poll or fire a positive-duration timeout. These checks use call and timer events, not a machine-dependent runtime threshold.
- Setup and uninstall run twice. The second invocation must preserve file contents, modes, and modification times from the first invocation. Uninstall starts from an installed fixture.
- Refusals preserve their documented nonzero exit and structured code. Neither invocation may call a backend or change files. Every executable registry refusal needs a refusal-class fixture; an HTTP wildcard pattern gets a concrete request sample, not a claim of exhaustive method/parameter coverage.

File snapshots include SHA-256 content hashes, modes, and nanosecond modification times. Directory modes are checked too. Observation logs and synthetic native stores are excluded from wrapper state. Completed pairs retain both process results and their content snapshots, including failed commands.

Refresh is repeatable reconciliation, including hard refresh. Resource actions have a state-scoped retry contract, not exactly-once delivery. A Progressing resource suppresses another submission, but a completed restart can run again. Concurrent retries before progress is visible are not certified. `axi-verify packed` is also reconciliation: it reruns verification and writes its explicitly requested evidence directory. Its explicit classification is reported without a recursive synthetic-tool invocation. The profile declares setup/uninstall absent, and registration of either without a lifecycle fixture fails.

Update fixtures inject a registry response and a fake npm installer inside a disposable global prefix. They test an already-current version, the npm lookup fallback, and an upgrade followed by an already-current retry. The SDK's documented `already on the latest version` message is accepted for update only. No real installer or update runs. Kubernetes declares self-update as a refusal.

The checks use the existing per-tool failure and known-limitation reporting. CLI `retry_coverage` and summary `retryCoverage` report permitted-write counts, write/event/reconcile coverage, operation IDs, local-write routes, refusal counts and lifecycle presence. The inventory evidence retains the actual operation/refusal tables. Datadog's empty write table and the read-only Terraform, Search Console and Kubernetes executable registries are reported explicitly; no backend write is invented. `retry_limits`/`retryLimits` keep event/reconciliation limits separate from SDK limitations. Use the default `packed` result's per-tool findings for each tool's fix PR; a published defect is not exempted. Archive identity and publication claims remain those recorded by `packed`.

## Packed contract

The runner installs the exact archive with scripts disabled into a unique scratch prefix. It resolves every declared executable through npm's installed bin links and verifies executable permissions and target identity. Auxiliary context bins are invoked as local views, not treated as public version or help interfaces.

Every row uses a fresh HOME and working directory. Child processes receive explicit agent, Google, npm, and Kubernetes paths, closed stdin, a timeout, and a bounded output buffer. Data-command PATH contains the fixture directory first, including Node, native backends, and package-manager shims, followed only by `/bin` and `/usr/bin` for shell compatibility. Startup verifies every named backend resolves to its fixture. Inherited credentials, Node options, and agent paths are discarded. Other commands present in those host directories and absolute host executable paths are not contained; this is not a subprocess sandbox.

Checks cover:

- Exact primary-bin version aliases, observed version graph loading, top-level and per-command help, help alongside other input, and each route's negative usage cases before dependency work.
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

No cluster, Argo CD server, Datadog account, Google account, or Terraform backend is used. The fixture-first PATH intercepts the named backends; other host commands in `/bin` and `/usr/bin` remain available. Datadog uses its loopback HTTP override. Search Console keeps real credential parsing and rendering, with only the Google client's request method replaced in a child-process preload. The Node preload rejects TCP connections except the fixture server's exact loopback port, and refuses Node UDP sends and DNS lookup or resolution calls. Datadog keyring access uses a synthetic file store instead of the OS keychain. This covers only Node processes that receive `NODE_OPTIONS`; a child launched with an environment that removes it loads no preload and is not covered. The Datadog HTTP fixture permits only explicit read endpoints and search-style POST reads. Other paths and methods fail their rows. Fixture credentials are synthetic. Npm registry reads are confined to package acquisition and cache warmup, with package scripts disabled during installation.

This is a regression verifier for trusted family packages, not an operating-system security sandbox for malicious archives. A package's local `npm pack` can run its existing lifecycle scripts. Absolute host executable paths and arbitrary native code are not contained.

Cleanup restores scratch modes and removes only the runner's scratch tree. Evidence stays outside that tree. No user agent configuration, consumer repository, cluster state, npm publication, or infrastructure settings are changed.

## Evidence

By default, evidence is written beneath `.axi-evidence/<timestamp>` in the caller's directory. `--evidence-dir` selects another location. Preserve it as a CI artifact even on failure.

`identity.json` records the archive SHA-512, package version, source claim, archive `gitHead`, both package manifests, runtime versions, platform, architecture, and uid. Numbered row files contain argv, the sanitized environment, process output and exit, decoded output, before/after filesystem metadata snapshots, probes, observations, and fixture request records. Behaviour rows record principle numbers and the installed or pinned-legacy contract source. Version rows also retain module-load logs outside the observed tool state. `summary.json` lists every verdict and per-principle coverage, including explicit `not-applicable` rows. Those rows are not marked passing process runs. CLI `principle_coverage` shows check counts and applicability counts without duplicating full row evidence. A final HTTP-request snapshot also contributes `unexpectedHttp` to the verdict, including rejected requests outside row slices; both summary and request evidence are retained on failure. Requests arriving after that final snapshot are outside this check. `fatal.json` records failures after evidence initialization, never a passing summary. Root and unreadable-archive boundary failures return structured CLI errors before creating evidence.

The published-proof script additionally saves registry metadata, archive bytes, and their verified registry integrity. It records the provenance-attestation URL but does not claim independent signature verification.

## Test the verifier

```sh
npm ci
npm test
npm run proof:history -- /absolute/static-proof
npm run proof:runtime -- /absolute/runtime-proof
npm run proof:published -- /absolute/catalog-proof /absolute/unpublished-k8s.tgz
```

`npm test` includes an installed minimal packed tool that passes the new behaviour checks, deliberate broken controls for each check, strict-manifest controls, and the exact SHA-256-verified terraform-axi 0.1.3 tarball with retained review outputs. The six reviewed failures are asserted against real processes from that artifact, never against prerequisites or only recorded text. Its pinned dev dependency supplies the published runtime dependencies without network access during those tests. Fixture Terraform responses contain only local built-in resources, 105 state entries, a 30-change saved plan, and long attributes. No real Terraform operation or cloud account is used. Test evidence first demonstrated the old runner omitting these checks before the checks were implemented.

Recorded review stdout and argv use stable `/fixtures` paths, `<user>`, and `<host>` placeholders. `provenance.json` hashes the normalized stdout and retains `sourceSha256` for its original capture. The published tarball remains byte-identical. Regeneration uses the same normalization before writing or hashing:

```sh
node --input-type=module -e 'import { recordTerraformEvidence } from "./scripts/record-terraform-evidence.mjs"; await recordTerraformEvidence("/absolute/review-directory", "/absolute/axi-verify/tests/terraform-0.1.3")'
```

Every broken control asserts its expected principle and diagnostic, not merely a failed status. A missing interpreter, unexpected I/O, or another prerequisite failure cannot count as detecting the intended defect.

The suite also includes the normal-command hook-installation negative control, real permission denials, a deliberately ineffective lock, root rejection, same-content and absolute-shell side-effect writes, noisy prepack output, missing and incorrect `gitHead`, CLI validation, fixture-first PATH behavior, exact backend argument vectors, network refusal, unsupported-command side effects, plugin package directories, initialization cleanup, historical artifact identity, evidence destinations, and all four ast-grep families. Rule snapshots record exact matches. Historical fixtures include full source files, their repository revisions, and SHA-256 hashes in `tests/history/provenance.json`.

`proof:history` rejects those exact historical files and scans explicitly repaired disposable copies green. These are static proofs, not claims that the copied modules were executed. Evidence paths are canonicalized through existing parents, and paths inside this repository (including symlink aliases) are rejected before writing. `proof:runtime` compares intended historical Argo CD failures with the fixed published successor and mutates disposable Argo Workflows archives for version and invalid-flag controls. Two optional positional archive paths add the pre-fix Terraform and Argo Workflows source packs. Argo Workflows 0.1.12 is not available from npm at the baseline date, so that proof needs a local pack stamped with its exact historical SHA. Both supplied historical packs require the expected manifest `gitHead`; their proof records use `sourceClaim` and `sourceContentVerified: false`, because a matching manifest is not content verification against the source commit. Exit-code repairs can pass their bounded comparison while the complete current row remains red for a missing structured code or repair hint. It fails if a prerequisite error is mistaken for the intended regression. `proof:published` uses fixed registry versions, reports every failing row, and keeps Kubernetes labelled unpublished. A failing published product is not grandfathered to make this verifier green.

Static rules match bounded syntax, not full control flow or interprocedural behavior. The swallowed-error rule recognizes a direct positive `errors.length`/`failures.length` guard in the collecting block and inline uninstall callbacks that record or throw. Conditional nested propagation and callback references require review; these rules are regression tripwires, not a general proof of error handling. Identifier-backed hook matching covers same-block uses and top-level bindings used in blocks without a same-name local declaration or function parameter. It does not perform full TypeScript binding resolution.

The package CI runs tests, historical static and runtime proofs, and an installed-archive smoke check on Linux and macOS. The Linux lane also invokes the actual root precondition. Consumer wiring, release automation, required-check administration, and recurring maintenance are out of scope.
