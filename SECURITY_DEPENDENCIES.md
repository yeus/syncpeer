# Dependency security maintenance

The October 2026 Dependabot review contained 39 open alerts. Compatible npm and
Cargo updates address 37; the two upstream Rust blockers below remain open.
Fixed and auto-dismissed historical alerts are not counted as new fixes.

Run the focused dependency and tooling compatibility regressions with:

```bash
npm run security:test-dependencies
npm audit
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
