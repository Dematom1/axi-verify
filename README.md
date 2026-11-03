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

`lib/profiles.mjs` selects the profile by the archive's package name. Unknown names fail. Profiles define actual commands, help routes, structured failure codes, and list fields:

- `argocd-axi`: applications, local context allowlist, and session hooks.
- `argo-workflows-axi`: workflows and session hooks. `setup status` is unsupported.
- `datadog-axi`: monitor search and user or project session hooks.
- `terraform-axi`: resource addresses and types, local binary configuration, and SessionStart integrations. No SessionEnd feature is required.
- `search-console-axi`: local credential registration and the two-field `setup check` sites list. The current home command returns site counts and analytics, not that list. `setup hooks` must remain unsupported.
- `k8s-axi`: pod diagnostics and session hooks. Its local pack does not establish npm publication.

The normal-command checks exercise each profile's listed commands before and after setup, plus help and version. They are regression samples, not exhaustive coverage of every argument combination.

## Packed contract

The runner installs the exact archive with scripts disabled into a unique scratch prefix. It resolves every declared executable through npm's installed bin links and verifies executable permissions and target identity. Auxiliary context bins are invoked as local views, not treated as public version or help interfaces.

Every row uses a fresh HOME and working directory. Child processes receive explicit agent, Google, npm, and Kubernetes paths, closed stdin, a timeout, and a bounded output buffer. Their PATH contains Node and synthetic upstream executables, but no real AXI or infrastructure executable. Inherited credentials, Node options, and agent paths are discarded.

Checks cover:

- Exact primary-bin version aliases, top-level and profile route help, and invalid flags before dependency work.
- Writable setup controls, repeat installation, status read-back, and seeded removal.
- Denied `.claude`, `.codex`, `.config`, and all-writes cases. Project cases also lock project agent directories. Existing nested files are locked too. Independent probes must receive EACCES or EPERM.
- Unreadable and malformed settings, missing and unreadable credential files, local config persistence, and unrelated-setting preservation.
- JSON hook entries, TOML Codex feature settings, and managed OpenCode plugin files reopened independently of the tool's status helper.
- Stored hook commands executed from an unrelated directory without an AXI executable on PATH. SessionEnd receives a synthetic transcript and must change a persisted session file.
- Repair after relocation to a path with spaces and a quote, including a generated legacy hook. A real offline `npm exec --package <archive>` invocation follows an isolated dependency-cache warmup.
- Nonempty default lists containing healthy and problem fixtures, exact default fields, and explicit expansion where supported. Lists with two fields remain valid.

The hook-model check is strict. Normal commands must not write beneath `.claude`, `.codex`, `.config`, or a custom `CLAUDE_CONFIG_DIR`. File contents and nanosecond change timestamps detect same-content rewrites and temporary create/remove pairs without filesystem-call mocks. Two `setup hooks` runs must leave exactly one managed entry per integration. Removal must remove **all entries installed by setup**, while another tool's hooks and settings survive. This supersedes the original plan's SessionEnd-only exemption for Argo CD and Datadog. Those published implementations can fail until their complete-removal fixes ship.

Only non-root Linux and macOS are supported. Root, ineffective locks, unavailable fixtures, unexpected external calls, malformed output, and timeouts fail rather than skip.

## External boundaries and safety

No cluster, Argo CD server, Datadog account, Google account, or Terraform backend is used. Subprocess fixtures reject unexpected calls. Datadog uses its loopback HTTP override. Search Console keeps real credential parsing and rendering, with only the Google client's request method replaced in a child-process preload. The preload records child-process creation and rejects executables outside Node, the stored-hook shell, and sandbox fixture PATH, including absolute paths. It rejects outbound socket connections except the fixture server's exact loopback port. Fixture credentials are synthetic. Npm registry reads are confined to package acquisition and cache warmup, with package scripts disabled during installation.

This is a regression verifier for trusted family packages, not an operating-system security sandbox for malicious archives. A package's local `npm pack` can run its existing lifecycle scripts. The Node boundary guard is not a general containment mechanism for arbitrary native code.

Cleanup restores scratch modes and removes only the runner's scratch tree. Evidence stays outside that tree. No user agent configuration, consumer repository, cluster state, npm publication, or infrastructure settings are changed.

## Evidence

By default, evidence is written beneath `.axi-evidence/<timestamp>` in the caller's directory. `--evidence-dir` selects another location. Preserve it as a CI artifact even on failure.

`identity.json` records the archive SHA-512, package version, source claim, archive `gitHead`, both manifests, runtime versions, platform, architecture, and uid. Numbered row files contain argv, the sanitized environment, process output and exit, decoded output, before/after file contents and timestamps, probes, observations, and fixture request records. `summary.json` lists every verdict. A fatal prerequisite produces `fatal.json`, never a passing summary.

The published-proof script additionally saves registry metadata, archive bytes, and their verified registry integrity. It records the provenance-attestation URL but does not claim independent signature verification.

## Test the verifier

```sh
npm ci
npm test
npm run proof:history -- /absolute/static-proof
npm run proof:runtime -- /absolute/runtime-proof
npm run proof:published -- /absolute/catalog-proof /absolute/unpublished-k8s.tgz
```

`npm test` includes the normal-command hook-installation negative control, real permission denials, a deliberately ineffective lock, root rejection, same-content writes, noisy prepack output, missing and incorrect `gitHead`, CLI validation, network refusal, and all four ast-grep families. Rule snapshots record exact matches. Historical fixtures include full source files, their repository revisions, and SHA-256 hashes in `tests/history/provenance.json`.

`proof:history` rejects those exact historical files and scans explicitly repaired disposable copies green. These are static proofs, not claims that the copied modules were executed. `proof:runtime` compares intended historical Argo CD failures with the fixed published successor and mutates disposable Argo Workflows archives for version and invalid-flag controls. Two optional positional archive paths add the pre-fix Terraform and Argo Workflows source packs. Argo Workflows 0.1.12 is not available from npm at the baseline date, so that proof needs a local pack stamped with its exact historical SHA. Exit-code repairs can pass their bounded comparison while the complete current row remains red for a missing structured code or repair hint. It fails if a prerequisite error is mistaken for the intended regression. `proof:published` uses fixed registry versions, reports every failing row, and keeps Kubernetes labelled unpublished. A failing published product is not grandfathered to make this verifier green.

The package CI runs tests, historical static and runtime proofs, and an installed-archive smoke check on Linux and macOS. The Linux lane also invokes the actual root precondition. Consumer wiring, release automation, required-check administration, and recurring maintenance are out of scope.
