import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import { $, browser } from "@wdio/globals";
import { computeDeviceId } from "../../packages/core/dist/core/transport/node.js";
import { safeNativeFailureText } from "../../packages/app/src/app/storageErrors.js";
import { createFreshEncryptedProfile } from "./profile-setup.js";
import { startLocalRelay } from "./relay.js";
import { generateSyncthingIdentity } from "./syncthing.js";
import { clickButtonByText, readSessionEventNames, selectDiscoveryMode,
  setDirectConnectionFields } from "./ui-helpers.js";

const folderId = "syncpeer-crossapp-folder"; // synthetic disposable emulator fixture
const password = "synthetic-crossapp-folder-password";

function android(serial: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return execFileSync(process.execPath, ["scripts/test-android-e2e.mjs", ...args], {
    cwd: process.cwd(), stdio: "inherit", timeout: 180_000,
    env: { ...process.env, ANDROID_SERIAL: serial, SYNCPEER_E2E_FOLDER_ID: folderId,
      SYNCPEER_E2E_FOLDER_PASSWORD: password, ...extra },
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function startRelayDiscovery(relayAddress: string, root: string) {
  const identity = generateSyncthingIdentity(path.join(root, "discovery"));
  const addresses = new Map<string, string[]>();
  const server = createServer({
    cert: await readFile(identity.certPath, "utf8"),
    key: await readFile(identity.keyPath, "utf8"),
    requestCert: true,
    rejectUnauthorized: false,
  }, async (request, response) => {
    const url = new URL(request.url ?? "/", "https://synthetic.invalid");
    if (url.pathname === "/endpoint") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ relays: [{ url: relayAddress }] }));
      return;
    }
    const certificate = (request.socket as TLSSocket).getPeerCertificate();
    if (request.method === "POST") {
      if (!certificate.raw) {
        response.writeHead(403).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const deviceId = computeDeviceId(new X509Certificate(certificate.raw).raw).replaceAll("-", "");
      const payload = JSON.parse(body) as { addresses?: string[] };
      addresses.set(deviceId, payload.addresses ?? []);
      response.writeHead(204, { "Reannounce-After": "1800" }).end();
      return;
    }
    const deviceId = (url.searchParams.get("device") ?? "").replaceAll("-", "");
    const found = addresses.get(deviceId);
    response.setHeader("Content-Type", "application/json");
    response.writeHead(found ? 200 : 404).end(JSON.stringify({ addresses: found ?? [] }));
  });
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `https://127.0.0.1:${address.port}`;
  return {
    port: address.port,
    discoveryServer: `${base}/v2/?id=${identity.deviceId}`,
    relayPoolUrl: `${base}/endpoint?id=${identity.deviceId}`,
    announcements: () => Object.fromEntries([...addresses.entries()].map(([id, values]) => [id, [...values]])),
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}


async function readDesktopDocumentContent(name: string): Promise<string | null> {
  return browser.execute(async ({ folderId, path }) => {
    const probe = (window as typeof window & { __syncpeerReadCachedDocument?:
      (folderId: string, path: string) => Promise<number[] | null> }).__syncpeerReadCachedDocument;
    if (!probe) throw new Error("The cached-document probe is unavailable.");
    // Attached folders keep their files in the encrypted document owner, so read
    // through the app adapter that holds the folder key instead of the raw cache.
    const bytes = await probe(folderId, path);
    return bytes ? new TextDecoder().decode(new Uint8Array(bytes)) : null;
  }, { folderId, path: name }).catch(error =>
    `error: ${error instanceof Error ? error.message : String(error)}`);
}

async function waitForDesktopFile(name: string, expected: string | null) {
  const deadline = Date.now() + 120_000;
  let observation = "no poll completed";
  while (Date.now() < deadline) {
    const entry = $(`//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(name)}]`);
    const exists = await entry.isExisting();
    if (exists && expected === null) return;
    if (exists) {
      const observed = await readDesktopDocumentContent(name);
      observation = `entry found; content=${JSON.stringify(observed?.slice(0, 120) ?? null)}`;
      if (expected !== null && observed === expected) return;
    } else {
      const view = await browser.execute((id: string) => ({
        inFolder: Boolean(document.querySelector("#folder-upload-input")),
        folderRootVisible: Boolean(document.querySelector(`[data-testid='folder-root-${id}']`)),
      }), folderId).catch(() => ({ inFolder: false, folderRootVisible: false }));
      // Attaching the folder invalidates and reopens the live session; a refresh
      // can briefly rebuild the root list after the folder was opened. Re-open it
      // while the same bounded convergence window elapses.
      if (!view.inFolder && view.folderRootVisible) {
        await browser.execute((id: string) => {
          const row = document.querySelector(`[data-testid='folder-root-${id}']`);
          if (row instanceof HTMLElement) row.click();
        }, folderId).catch(() => undefined);
      }
      const cached = await readDesktopDocumentContent(name);
      const titles = await browser.execute(() =>
        [...document.querySelectorAll(".item-title")].map(element => element.textContent?.trim() ?? ""))
        .catch(() => []);
      observation = `entry missing; inFolder=${view.inFolder}; ` +
        `cached=${JSON.stringify(cached?.slice(0, 120) ?? null)}; ` +
        `rendered titles=${JSON.stringify(titles.slice(0, 20))}`;
    }
    await browser.pause(500);
  }
  throw new Error(`Desktop did not converge ${name} to the expected synthetic state. ` +
    `Last observation: ${observation}`);
}


async function createDesktopEncryptedFolder(label: string): Promise<string> {
  await browser.execute(() => {
    const tab = document.querySelector("[data-testid='tab-folders']");
    if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable.");
    tab.click();
  });
  await clickButtonByText(browser, "Folder settings · New folder");
  await $("//label[contains(., 'New folder name')]/input").setValue(label);
  const create = $("button=Create folder");
  await create.waitForEnabled({ timeout: 30_000 });
  await clickButtonByText(browser, "Create folder");
  await browser.waitUntil(async () => browser.execute((expected: string) =>
    [...document.querySelectorAll("li > span")].some(span => span.textContent?.trim() === expected), label),
  { timeout: 60_000, interval: 500,
    timeoutMsg: "Desktop-created encrypted folder did not appear in Folder settings." });
  await clickButtonByText(browser, "Back");
  await $("[data-testid='tab-folders']").click();
  let folderId = "";
  await browser.waitUntil(async () => {
    folderId = await browser.execute((expected: string) => {
      const row = [...document.querySelectorAll("[data-testid^='folder-root-']")]
        .find(element => element.querySelector(".item-title")?.textContent?.trim() === expected);
      const testId = row?.getAttribute("data-testid") ?? "";
      return testId.startsWith("folder-root-") ? testId.slice("folder-root-".length) : "";
    }, label);
    return Boolean(folderId);
  }, { timeout: 60_000, interval: 500,
    timeoutMsg: "Desktop-created encrypted folder did not appear in the root view." });
  return folderId;
}

async function attachSharedFolder() {
  const desktopState = async () => browser.execute((id: string) => {
    const probe = (window as typeof window & { __syncpeerFolderProbe?: (folderId: string) => unknown })
      .__syncpeerFolderProbe?.(id);
    const settingsRow = [...document.querySelectorAll("li")].find(row =>
      [...row.querySelectorAll("span")].some(span => span.textContent?.trim() === id));
    return { probe, settingsRowVisible: Boolean(settingsRow),
      attachControlVisible: [...settingsRow?.querySelectorAll("button") ?? []]
        .some(button => button.textContent?.includes("Reattach encrypted")),
      attachedControlVisible: [...settingsRow?.querySelectorAll("button") ?? []]
        .some(button => button.textContent?.includes("Move to plaintext")),
      rootView: !document.querySelector(".breadcrumbs .crumb-button"),
      rootRowCount: document.querySelectorAll(".list .item-title").length,
      visibleRoot: [...document.querySelectorAll(".list .item-title")]
        .some(element => element.textContent?.trim() === id),
      error: document.querySelector("p.error, p[role='alert']")?.textContent?.trim() ?? "",
    };
  }, folderId);
  const deadline = Date.now() + 90_000;
  for (let attempt = 0; attempt < 20 && Date.now() < deadline; attempt += 1) {
    if (attempt % 5 === 0) console.log(`Cross-app folder credential check ${attempt + 1}/20.`);
    await browser.execute(() => {
      const tab = document.querySelector("[data-testid='tab-folders']");
      if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable.");
      tab.click();
    });
    await clickButtonByText(browser, "Folder settings · New folder");
    const row = $(`//li[./span[normalize-space()=${JSON.stringify(folderId)}]]`);
    if (await row.isExisting()) {
      const received = await desktopState();
      console.log("Desktop received folder registration:", JSON.stringify({ ...received,
        error: safeNativeFailureText(received.error) }));
      const attach = row.$("button=Reattach encrypted local storage");
      if (await attach.isExisting()) {
        await clickButtonByText(browser, "Reattach encrypted local storage");
        await browser.waitUntil(async () => {
          const state = await desktopState();
          return state.attachedControlVisible || Boolean(state.error);
        }, { timeout: 60_000, interval: 500,
          timeoutMsg: "Desktop did not finish attaching the encrypted folder." });
      }
      const attached = await desktopState();
      console.log("Desktop attachment result in settings:", JSON.stringify({ ...attached,
        error: safeNativeFailureText(attached.error) }));
      if (attached.error) throw new Error(`Desktop folder attachment failed: ${safeNativeFailureText(attached.error)}`);
      assert.ok(attached.attachedControlVisible, "Desktop did not attach the encrypted folder.");
      await clickButtonByText(browser, "Back");
      await $("[data-testid='tab-folders']").waitForExist({ timeout: 30_000 });
      await browser.execute(() => {
        const tab = document.querySelector("[data-testid='tab-folders']");
        if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable after attachment.");
        tab.click();
      });
      await browser.execute(() => {
        const root = document.querySelector(".breadcrumbs .crumb-button");
        if (root instanceof HTMLButtonElement && root.textContent?.includes("All Syncthing Folders")) root.click();
      });
      const root = $(`[data-testid='folder-root-${folderId}']`);
      try { await root.waitForExist({ timeout: 120_000 }); }
      catch (cause) {
        const state = await desktopState();
        throw new Error(`Desktop folder root missing after attachment: ${JSON.stringify({ ...state,
          error: safeNativeFailureText(state.error) })}`, { cause });
      }
      // Re-query the row on every attempt: live session updates re-render the
      // list, which invalidates chained element references.
      const favoritePressed = () => browser.execute((id: string) => {
        const button = document.querySelector(`[data-testid='folder-root-${id}']`)?.closest("li")
          ?.querySelector("button[aria-label='Toggle favorite']");
        return button?.getAttribute("aria-pressed") === "true";
      }, folderId);
      if (!await favoritePressed()) {
        const clicked = await browser.execute((id: string) => {
          const button = document.querySelector(`[data-testid='folder-root-${id}']`)?.closest("li")
            ?.querySelector("button[aria-label='Toggle favorite']");
          if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
          button.click();
          return true;
        }, folderId);
        if (!clicked) {
          const state = await desktopState();
          throw new Error(`Desktop folder root has no favorite control: ${JSON.stringify({ ...state,
            error: safeNativeFailureText(state.error) })}`);
        }
        await browser.waitUntil(favoritePressed, { timeout: 30_000, interval: 250,
          timeoutMsg: "Desktop folder favorite did not persist." });
      }
      return;
    }
    await clickButtonByText(browser, "Back");
    await browser.pause(2_000);
  }
  const events = await readSessionEventNames(browser).catch(() => []);
  throw new Error(`The approved Android folder credential did not reach the packaged desktop. ` +
    `Recent event names: ${events.slice(-25).join(",") || "unavailable"}.`);
}

describe("Packaged desktop to Android pairing", () => {
  before(async () => {
    const expected = process.env.SYNCPEER_LAN_EXPECT_DEV_URL;
    if (expected) assert.equal(await browser.execute(() => location.origin), expected,
      "The desktop test is not using the dedicated Syncpeer Vite dev server.");
  });
  it("enrolls a fresh Android device in the desktop personal space through a local relay", async () => {
    const serial = process.env.SYNCPEER_ANDROID_SERIAL;
    assert.ok(serial?.startsWith("emulator-"), "An explicit emulator serial is required.");
    assert.equal(execFileSync("adb", ["-s", serial, "shell", "getprop", "ro.kernel.qemu"],
      { encoding: "utf8" }).trim(), "1", "The selected Android target is not an emulator.");
    const relay = await startLocalRelay();
    const relayPort = Number(new URL(relay.relayAddress).port);
    assert.ok(relayPort > 0);
    const root = await mkdtemp(path.join(tmpdir(), "syncpeer-crossapp-pairing-"));
    try {
      execFileSync("adb", ["-s", serial, "reverse", `tcp:${relayPort}`, `tcp:${relayPort}`]);
      await createFreshEncryptedProfile(browser);
      await browser.execute(() => { window.confirm = () => true; });
      await $("//label[contains(., 'LAN host/IP or relay:// URL')]/input")
        .setValue(relay.relayAddress);
      const create = $("button=Create pairing invitation");
      await create.waitForEnabled({ timeout: 30_000 });
      await clickButtonByText(browser, "Create pairing invitation");
      const invitationField = $("//label[contains(., 'Invitation')]/textarea[@readonly]");
      await invitationField.waitForExist({ timeout: 30_000 });
      const invitation = await invitationField.getValue();
      assert.ok(invitation.includes(relay.relayAddress),
        "Packaged pairing invitation did not advertise the local relay.");
      const invitationPath = path.join(root, "invitation.json");
      await writeFile(invitationPath, invitation, { mode: 0o600 });
      execFileSync(process.execPath, ["scripts/test-android-e2e.mjs", "--pairing-join",
        "--pairing-invitation", invitationPath], {
        cwd: process.cwd(), stdio: "inherit", timeout: 180_000,
        env: { ...process.env, ANDROID_SERIAL: serial },
      });
      await $("//*[contains(text(),'Device paired and approved.')]")
        .waitForExist({ timeout: 30_000 });
    } finally {
      try {
        execFileSync("adb", ["-s", serial, "reverse", "--remove", `tcp:${relayPort}`],
          { stdio: "ignore" });
      } catch { /* Reverse cleanup is best-effort. */ }
      await relay.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("honors the Android listener port and propagates a desktop-created credential", async () => {
    const serial = process.env.SYNCPEER_ANDROID_SERIAL;
    assert.ok(serial?.startsWith("emulator-"));
    await clickButtonByText(browser, "Back");
    await $("[data-testid='tab-devices']").click();
    const ownerId = (await $("[data-testid='current-device-id']").getText()).trim();
    assert.ok(ownerId);

    const desktopFolderLabel = "desktop-originated-credential";
    const desktopFolderId = await createDesktopEncryptedFolder(desktopFolderLabel);
    await $("[data-testid='tab-devices']").click();

    const root = await mkdtemp(path.join(tmpdir(), "syncpeer-crossapp-listener-"));
    const forwardedPort = await freePort();
    const listenPort = await freePort();
    const androidListenPort = 22999;
    try {
      const androidIdPath = path.join(root, "android-id");
      android(serial, ["--write-device-id", androidIdPath]);
      const androidId = (await readFile(androidIdPath, "utf8")).trim();
      assert.ok(androidId);
      execFileSync("adb", ["-s", serial, "forward", `tcp:${forwardedPort}`,
        `tcp:${androidListenPort}`]);
      await browser.execute(() => { window.prompt = () => "synthetic-desktop-crossapp"; });
      await browser.execute(() => {
        const toggle = document.querySelector("[data-testid='connection-settings-toggle']");
        if (!(toggle instanceof HTMLButtonElement)) throw new Error("Connection settings are unavailable.");
        if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      });
      await setDirectConnectionFields(browser, { remoteId: androidId, host: "127.0.0.1",
        remotePort: forwardedPort, listenPort });

      const androidConnection = spawn(process.execPath,
        ["scripts/test-android-e2e.mjs", "--connect-whole-folder"], {
          cwd: process.cwd(), stdio: "inherit", env: { ...process.env, ANDROID_SERIAL: serial,
            SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
            SYNCPEER_E2E_FOLDER_ID: desktopFolderId,
            SYNCPEER_E2E_FOLDER_PASSWORD: "",
            SYNCPEER_ANDROID_DISCOVERY_MODE: "direct",
            SYNCPEER_ANDROID_DIRECT_HOST: "10.0.2.2",
            SYNCPEER_ANDROID_DIRECT_PORT: String(listenPort),
            SYNCPEER_ANDROID_LISTEN_PORT: String(androidListenPort) },
        });
      await new Promise<void>((resolve, reject) => {
        androidConnection.once("error", reject);
        androidConnection.once("exit", code => code === 0
          ? resolve()
          : reject(new Error(`Android connection failed: ${code}`)));
      });

      const listeners = execFileSync("adb", ["-s", serial, "shell", "ss", "-ltn"], {
        encoding: "utf8", timeout: 30_000,
      });
      assert.match(listeners, new RegExp(`:${androidListenPort}\\b`),
        "Packaged Android did not listen on its configured non-default incoming port.");
      console.log(`Packaged Android listener honored configured port ${androidListenPort}.`);

      android(serial, ["--verify-received-folder"], {
        SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
        SYNCPEER_E2E_FOLDER_ID: desktopFolderId,
        SYNCPEER_E2E_FOLDER_TITLE: desktopFolderLabel,
        SYNCPEER_E2E_FOLDER_PASSWORD: "",
        SYNCPEER_ANDROID_DISCOVERY_MODE: "direct",
        SYNCPEER_ANDROID_DIRECT_HOST: "10.0.2.2",
        SYNCPEER_ANDROID_DIRECT_PORT: String(listenPort),
        SYNCPEER_ANDROID_LISTEN_PORT: String(androidListenPort),
      });
    } finally {
      try {
        execFileSync("adb", ["-s", serial, "forward", "--remove", `tcp:${forwardedPort}`],
          { stdio: "ignore" });
      } catch { /* Forward cleanup is best-effort. */ }
      await rm(root, { recursive: true, force: true });
    }
  });


  it("syncs the packaged desktop and Android app through a local relay", async () => {
    const serial = process.env.SYNCPEER_ANDROID_SERIAL;
    assert.ok(serial?.startsWith("emulator-"));
    const relay = await startLocalRelay();
    const discoveryRoot = await mkdtemp(path.join(tmpdir(), "syncpeer-relay-discovery-"));
    const discovery = await startRelayDiscovery(relay.relayAddress, discoveryRoot);
    const relayPort = Number(new URL(relay.relayAddress).port);
    assert.ok(relayPort > 0);
    try {
      execFileSync("adb", ["-s", serial, "reverse", `tcp:${relayPort}`, `tcp:${relayPort}`]);
      execFileSync("adb", ["-s", serial, "reverse", `tcp:${discovery.port}`,
        `tcp:${discovery.port}`]);

      if (!await $("[data-testid='tab-devices']").isExisting()) {
        await clickButtonByText(browser, "Back");
        await $("[data-testid='tab-devices']").waitForExist({ timeout: 30_000 });
      }
      await $("[data-testid='tab-devices']").click();
      const ownerId = (await $("[data-testid='current-device-id']").getText()).trim();
      assert.ok(ownerId);
      const androidIdRoot = await mkdtemp(path.join(tmpdir(), "syncpeer-relay-android-id-"));
      let androidId = "";
      try {
        const androidIdPath = path.join(androidIdRoot, "device-id");
        android(serial, ["--write-device-id", androidIdPath]);
        androidId = (await readFile(androidIdPath, "utf8")).trim();
      } finally {
        await rm(androidIdRoot, { recursive: true, force: true });
      }
      assert.ok(androidId);
      android(serial, ["--prepare-whole-folder"], {
        SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
      });
      android(serial, ["--write-document-folder"], {
        SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
        SYNCPEER_E2E_FOLDER_ID: folderId,
        SYNCPEER_E2E_FOLDER_PASSWORD: password,
        SYNCPEER_E2E_FILE_NAME: "relay-from-android.txt",
        SYNCPEER_E2E_FILE_CONTENT: "relay-android",
      });

      await browser.execute(() => {
        const settings = document.querySelector("[data-testid='connection-settings-toggle']");
        if (!(settings instanceof HTMLButtonElement)) throw new Error("Connection settings are unavailable.");
        if (settings.getAttribute("aria-expanded") !== "true") settings.click();
        const expert = document.querySelector("[data-testid='expert-view']");
        if (!(expert instanceof HTMLInputElement)) throw new Error("Expert connection controls are unavailable.");
        if (!expert.checked) expert.click();
        const details = document.querySelector("[data-testid='connection-status-toggle']");
        if (!(details instanceof HTMLButtonElement)) throw new Error("Connection status details are unavailable.");
        if (details.getAttribute("aria-expanded") !== "true") details.click();
      });
      const connectionControl = $("[data-testid='expert-connection-control']");
      await connectionControl.waitForExist({ timeout: 5_000 });
      if ((await connectionControl.getText()).includes("Pause automatic connection")) {
        await connectionControl.click();
        await browser.waitUntil(async () =>
          !(await $("[data-testid='connection-status']").getText()).includes("Connected"),
        { timeout: 30_000, interval: 250,
          timeoutMsg: "Packaged desktop did not close the previous direct session before relay testing." });
      }
      const hookInstalled = await browser.execute((poolUrl: string) => {
        const setter = (window as typeof window & {
          __syncpeerSetRelayPoolUrl?: (url: string) => void;
        }).__syncpeerSetRelayPoolUrl;
        if (!setter) return false;
        setter(poolUrl);
        return true;
      }, discovery.relayPoolUrl);
      assert.equal(hookInstalled, true, "Packaged desktop relay-pool test hook is unavailable.");
      await selectDiscoveryMode(browser, "global");
      await browser.$("[data-testid='connection-discovery-server']").waitForExist({ timeout: 5_000 });
      await browser.execute(({ remoteId, discoveryServer }) => {
        for (const [testId, value] of [
          ["connection-remote-id", remoteId],
          ["connection-discovery-server", discoveryServer],
        ]) {
          const field = document.querySelector(`[data-testid='${testId}']`) as HTMLInputElement | null;
          if (!field) throw new Error(`Connection field ${testId} is unavailable.`);
          field.value = value;
          field.dispatchEvent(new Event("input", { bubbles: true }));
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
        const relayFallback = document.querySelector(
          "[data-testid='connection-relay-fallback']") as HTMLInputElement | null;
        if (!relayFallback) throw new Error("Relay fallback control is unavailable.");
        if (!relayFallback.checked) relayFallback.click();
      }, { remoteId: androidId, discoveryServer: discovery.discoveryServer });
      if ((await connectionControl.getText()).includes("Resume automatic connection")) {
        await connectionControl.click();
      }


      const androidRelay = spawn(process.execPath,
        ["scripts/test-android-e2e.mjs", "--connect-whole-folder"], {
          cwd: process.cwd(), stdio: "inherit",
          env: {
            ...process.env,
            ANDROID_SERIAL: serial,
            SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
            SYNCPEER_E2E_FOLDER_ID: folderId,
            SYNCPEER_E2E_FOLDER_PASSWORD: password,
            SYNCPEER_ANDROID_DISCOVERY_MODE: "global",
            SYNCPEER_LAN_DISCOVERY_SERVER: discovery.discoveryServer,
            SYNCPEER_LAN_RELAY_POOL_URL: discovery.relayPoolUrl,
          },
        });
      try {
        await new Promise<void>((resolve, reject) => {
          androidRelay.once("error", reject);
          androidRelay.once("exit", code => code === 0
            ? resolve()
            : reject(new Error(`Android relay connection failed: ${code}`)));
        });
        try {
          await browser.waitUntil(async () =>
            (await $("[data-testid='connection-status']").getText()).includes("Connected"),
          { timeout: 120_000, interval: 500,
            timeoutMsg: "Packaged desktop did not connect to Android through the relay." });
        } catch (cause) {
          const status = await $("[data-testid='connection-status']").getText().catch(() => "unavailable");
          const events = await readSessionEventNames(browser).catch(() => []);
          throw new Error(`Packaged desktop relay connection failed: status=${status}; announcements=${JSON.stringify(discovery.announcements())}; events=${events.slice(0, 80).join(",") || "unavailable"}`,
            { cause });
        }
        await browser.waitUntil(async () => (await browser.getPageSource()).includes("Path: relay"),
          { timeout: 30_000, interval: 500,
            timeoutMsg: "Packaged connection did not report relay transport." });

        await attachSharedFolder();
        console.log("Relay session delivered and attached the Android-created encrypted folder.");

        await browser.execute(() => {
          const tab = document.querySelector("[data-testid='tab-folders']");
          if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable.");
          tab.click();
        });
        await browser.waitUntil(async () => {
          const root = $("[data-testid='folder-root-" + folderId + "']");
          if (!await root.isExisting()) return false;
          await browser.execute((id: string) => {
            const row = document.querySelector(`[data-testid='folder-root-${id}']`);
            if (row instanceof HTMLElement) row.click();
          }, folderId);
          return $("#folder-upload-input").isExisting();
        }, { timeout: 90_000, interval: 1_000,
          timeoutMsg: "Relay session did not reopen the attached folder root." });

        await waitForDesktopFile("relay-from-android.txt", "relay-android");
        console.log("Packaged relay session transferred an Android document into packaged desktop.");
      } finally {
        if (androidRelay.exitCode === null) androidRelay.kill("SIGTERM");
      }
    } finally {
      for (const port of [relayPort, discovery.port]) {
        try {
          execFileSync("adb", ["-s", serial, "reverse", "--remove", `tcp:${port}`],
            { stdio: "ignore" });
        } catch { /* Reverse cleanup is best-effort. */ }
      }
      await discovery.close();
      await relay.close();
      await rm(discoveryRoot, { recursive: true, force: true });
    }
  });
});
