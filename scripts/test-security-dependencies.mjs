import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import test from "node:test";

// Patched stable release floors from the October 2026 Dependabot review.
// Check every locked copy, including nested development dependencies.
const atLeast = (version, minimum) => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const actual = version.split(".").map(Number);
  const expected = minimum.split(".").map(Number);
  const difference = actual.map((part, index) => part - expected[index]);
  return difference.find((part) => part !== 0) > 0 || difference.every((part) => part === 0);
};

test("npm lockfile excludes the reviewed vulnerable dependency versions", () => {
  const floors = {
    "smol-toml": "1.9.0",
    "source-map-js": "1.2.2",
    "postcss-selector-parser": "7.1.6",
    devalue: "5.9.3",
    "brace-expansion": { 1: "1.1.21", 2: "2.1.7", 5: "5.0.12" },
    undici: { 6: "6.28.1", 7: "7.29.1" },
    "ip-address": "10.7.1",
    "js-yaml": "4.3.2",
    nanoid: "3.3.12",
    "serialize-javascript": "7.0.5",
    "basic-ftp": "6.2.1",
    diff: "8.0.3",
    postcss: "8.5.23",
    vite: "6.4.3",
  };
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  const failures = Object.entries(lock.packages).flatMap(([location, entry]) => {
    const name = location.split("node_modules/").at(-1);
    if (name === "extract-zip") return [`${location}: no patched release; replace its owner`];
    const floor = floors[name];
    if (!floor) return [];
    const minimum = typeof floor === "string" ? floor : floor[entry.version.split(".")[0]];
    return minimum && atLeast(entry.version, minimum)
      ? [] : [`${location}: ${entry.version}, expected >= ${minimum ?? "a reviewed patched major"}`];
  });
  assert.deepEqual(failures, []);
});

test("Cargo lockfile uses patched versions except the documented upstream blockers", () => {
  const floors = { rustls: "0.23.45", tauri: "2.11.1", serde_with: "3.21.0",
    rand: "0.8.6", glib: "0.20.0" };
  const lock = fs.readFileSync("packages/tauri-shell/src-tauri/Cargo.lock", "utf8");
  const failures = [...lock.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)]
    .flatMap(([, name, version]) => {
      // Exact exceptions are documented in SECURITY_DEPENDENCIES.md.
      if (name === "rand" && version === "0.7.3") return [];
      if (name === "glib" && version === "0.18.5") return [];
      if (floors[name] && !atLeast(version, floors[name])) {
        return [`${name}: ${version}, expected >= ${floors[name]}`];
      }
      return [];
    });
  assert.deepEqual(failures, []);
  const legacyRand = lock.split("[[package]]").find((entry) =>
    entry.includes('name = "rand"\nversion = "0.7.3"'));
  assert.ok(legacyRand, "Reassess and remove the exception when upstream removes rand 0.7");
  assert.doesNotMatch(legacyRand, /"log(?: [^"]+)?"/, "Do not enable the vulnerable logging setup");
});

test("patched Mocha supports WebdriverIO 9 hooks and parallel worker serialization", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-mocha-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spec = path.join(root, "fixture.spec.mjs");
  fs.writeFileSync(spec, `import assert from 'node:assert/strict';
    describe('synthetic acceptance', () => {
      let ready = false;
      before(async () => { ready = true; });
      it('runs async assertions', async () => { assert.equal(ready, true); });
      after(() => { assert.equal(ready, true); });
    });`);
  // A child isolates Mocha's global test interface from node:test.
  const runner = path.join(root, "run.mjs");
  fs.writeFileSync(runner, `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { MochaAdapter } from ${JSON.stringify(import.meta.resolve("@wdio/mocha-framework"))};
    const events = [];
    const adapter = await new MochaAdapter('0-0',
      { mochaOpts: { timeout: 1000, ui: 'bdd' } },
      [process.argv[2]], {}, { emit: (event) => events.push(event) }).init();
    assert.equal(adapter.hasTests(), true);
    assert.equal(await adapter.run(), 0);
    assert.equal(events.filter((event) => event === 'test:pass').length, 1);
    const require = createRequire(${JSON.stringify(import.meta.resolve("@wdio/mocha-framework"))});
    const Mocha = require('mocha');
    const parallel = new Mocha({ parallel: true, jobs: 2, reporter: function () {} });
    parallel.addFile(process.argv[2]);
    assert.equal(await new Promise((resolve) => parallel.run(resolve)), 0);
  `);
  const result = spawnSync(process.execPath, [runner, spec],
    { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});

test("WebdriverIO's patched browser installer unpacks a synthetic local ZIP", async (t) => {
  const require = createRequire(import.meta.resolve("@wdio/utils"));
  const { install, Browser, BrowserPlatform, computeExecutablePath } =
    await import(pathToFileURL(require.resolve("@puppeteer/browsers")).href);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-browser-security-"));
  const archive = fs.readFileSync("scripts/fixtures/security-chromedriver.zip");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Length": archive.length });
    response.end(archive);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const options = { cacheDir: root, browser: Browser.CHROMEDRIVER,
    platform: BrowserPlatform.LINUX, buildId: "123.0.0.0",
    baseUrl: `http://127.0.0.1:${server.address().port}` };
  const installed = await install(options);
  assert.equal(installed.executablePath, computeExecutablePath(options));
  assert.equal(fs.readFileSync(installed.executablePath, "utf8"), "synthetic driver\n");
});
