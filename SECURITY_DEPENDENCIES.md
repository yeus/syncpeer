# Dependency security maintenance

The October 2026 Dependabot review contained 39 open alerts. Compatible npm and
Cargo updates address 37; the two upstream Rust blockers below remain open.
Fixed and auto-dismissed historical alerts are not counted as new fixes.

## November 17, 2026 downloaded alert snapshot

The local `.tmp/dependabot-alerts.json` export contains **109 historical alerts**:
92 fixed, two automatically dismissed, and **15 open**. Of the 15 open:

- **9 npm `undici` alerts** (versions 6.29.0 and 7.30.0): lockfile
  resolves 6.29.1 and 7.30.2, satisfying the 6.29.1/7.30.1 advisory floors.
  These are **development-only transitive dependencies** from WebdriverIO
  and Cheerio; no major-version override is needed.
- **4 `rustls` alerts**: `Cargo.lock` resolves patched 0.23.46, and the
  direct `Cargo.toml` floor is now 0.23.46.
- **2 upstream Rust exceptions**: `glib` 0.18.5 and `rand` 0.7.3 are still
  present; see the documented constraints below. **They are not fixed.**

The repository dependency-floor test guards both `undici` major versions and
`rustls`; never assume the ignored export itself is a repository regression
fixture. A current `npm audit --omit=dev` reports **zero runtime npm
vulnerabilities**. The full npm audit, however, currently reports **34
additional advisories affecting development tooling** (not included among
these 15 open GitHub alerts); this should be triaged separately before any
claim that *all* development dependencies are clean. This section describes
review of the downloaded snapshot, not a live GitHub-alert state transition.

**Local verification for these updates:** clean `npm ci --ignore-scripts`,
`npm run security:test-dependencies` (4/4), `npm run typecheck:app`, `npm run lint`,
`npm run build:app`, `cargo check --locked --tests`, and
`cargo test --locked --lib native_` (10/10, including mutual TLS and relay)
passed. Cargo audit reports the two documented vulnerable Rust crates; the
remaining advisory inventory also includes unmaintained/yanked warnings.
Packaged desktop, cross-platform, and physical Android acceptance were not
rerun for these dependency changes.

Run the focused dependency and tooling compatibility regressions with:

```bash
npm run security:test-dependencies
npm audit --omit=dev
npm audit # separately triage currently open development-tooling reports
```

The regression reads committed lockfiles and uses synthetic fixtures. The ZIP
fixture contains only `chromedriver-linux64/chromedriver` with the text
`synthetic driver`; it is not a real browser driver. Exported alerts and generated
diagnostics belong in ignored `.tmp/` and must not be committed.

## WebdriverIO 9 security overrides

The Tauri service currently requires WebdriverIO 9. Upgrading the whole test
stack to WebdriverIO 10 would conflict with its supported peer dependency.
Scoped overrides in the root `package.json` update the upstream owners instead:

| Owner | Replacement | Reason |
| --- | --- | --- |
| `@wdio/utils` | `@puppeteer/browsers` 3.2.4 or newer | Removes unpatched `extract-zip`; uses the upstream replacement archive implementation. |
| `@wdio/mocha-framework` | Mocha 11.8.0 or newer within major 11 | Removes the old Chokidar/braces dependency while retaining the internal API imported by WebdriverIO 9. |
| That Mocha copy | `serialize-javascript` 7.1.2 or newer | Fixes the affected serializer retained by Mocha 11. |
| That Mocha copy | `diff` 8.0.3 or newer within major 8 | Fixes the patch parser denial of service found by the fresh npm audit. |

The browser installer upgrade also removes the old proxy-download dependency
chain containing the affected `basic-ftp` copy found by the fresh npm audit.

The focused tests run a real WebdriverIO Mocha adapter with asynchronous tests
and hooks, exercise Mocha's parallel worker serialization, and install a
synthetic driver ZIP through the replacement browser
installer against a loopback HTTP server. These checks do not establish full
packaged GUI or cross-platform acceptance. Remove overrides when compatible
upstream releases incorporate these fixes.

Local validation passed: a clean `npm ci --ignore-scripts`, zero reported npm
audit vulnerabilities, 33 focused dependency/build/export tests, lint, sensitive
identifier scanning, the application build and type check, Rust checks with
default and `lan-e2e` features, and 11 native tests including mutual TLS and
relay authentication. Packaged desktop and Android acceptance remains pending
for this dependency change.

## Accepted upstream blockers

These dependencies remain vulnerable according to the advisory version ranges.
They are documented exceptions, not fixed alerts, and no GitHub dismissal is
performed. The user chose to track upstream resolution rather than maintain
vendored forks.

### glib 0.18.5

[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
describes undefined behavior in `VariantStrIter`. The fix is available in glib
0.20, but Tauri's GTK3, WebKitGTK, window and menu dependencies require glib 0.18.
Adding glib 0.20 directly would retain the vulnerable copy and would not migrate
those consumers. This Linux runtime blocker remains after the Tauri update;
the affected iterator's reachability in Syncpeer has not been established.

### rand 0.7.3

[GHSA-cq8v-f236-94qc](https://github.com/advisories/GHSA-cq8v-f236-94qc)
requires logging plus a reentrant custom logger using the thread-local RNG.
Tauri's legacy `kuchikiki` parser retains this version through
`selectors -> phf_codegen -> phf_generator` (a build dependency).
The current default desktop feature tree does not enable rand's `log` feature,
and the lockfile records no `log` dependency for that copy. The regression
guards that dependency boundary. This limits the known exposure; it does not
change the affected version or close the alert. The separate rand 0.8 copy is
updated to a patched release.

[Tauri's upstream advisory policy](https://github.com/tauri-apps/tauri/blob/dev/.cargo/audit.toml)
tracks both blockers: GTK4 is needed for glib, and the legacy parser is planned
for removal in Tauri v3. Reassess dependency paths and feature activation on
Tauri/plugin upgrades, and remove the exceptions when supported releases allow
the vulnerable versions to be eliminated.
