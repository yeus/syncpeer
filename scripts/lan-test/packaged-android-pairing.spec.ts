import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { $, browser } from "@wdio/globals";
import { createFreshEncryptedProfile } from "./profile-setup.js";
import { safeNativeFailureText } from "../../packages/app/src/app/storageErrors.js";
import { clickButtonByText, readSessionEventNames, setDirectConnectionFields } from "./ui-helpers.js";

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

async function uploadDesktopFile(name: string, content: string) {
  await browser.execute(({ name, content }) => {
    const input = document.getElementById("folder-upload-input") as HTMLInputElement | null;
    if (!input) throw new Error("The folder upload input is unavailable.");
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], name));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name, content });
  await $(`//*[contains(@class,'hint') and normalize-space()=${JSON.stringify(`Uploaded ${name}.`)}]`)
    .waitForExist({ timeout: 120_000 });
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
  it("enrolls a fresh Android device in the desktop personal space", async () => {
    const serial = process.env.SYNCPEER_ANDROID_SERIAL;
    assert.ok(serial?.startsWith("emulator-"), "An explicit emulator serial is required.");
    assert.equal(execFileSync("adb", ["-s", serial, "shell", "getprop", "ro.kernel.qemu"],
      { encoding: "utf8" }).trim(), "1", "The selected Android target is not an emulator.");
    await createFreshEncryptedProfile(browser);
    await browser.execute(() => { window.confirm = () => true; });
    await $("//label[contains(., 'LAN host/IP or relay:// URL')]/input")
      .setValue("10.0.2.2");
    const create = $("button=Create pairing invitation");
    await create.waitForEnabled({ timeout: 30_000 });
    await clickButtonByText(browser, "Create pairing invitation");
    const invitationField = $("//label[contains(., 'Invitation')]/textarea[@readonly]");
    await invitationField.waitForExist({ timeout: 30_000 });
    const invitation = await invitationField.getValue();
    assert.ok(invitation.includes("endpoint"));
    const root = await mkdtemp(path.join(tmpdir(), "syncpeer-crossapp-pairing-"));
    try {
      const invitationPath = path.join(root, "invitation.json");
      await writeFile(invitationPath, invitation, { mode: 0o600 });
      execFileSync(process.execPath, ["scripts/test-android-e2e.mjs", "--pairing-join",
        "--pairing-invitation", invitationPath], {
        cwd: process.cwd(), stdio: "inherit", timeout: 180_000,
        env: { ...process.env, ANDROID_SERIAL: serial },
      });
      await $("//*[contains(text(),'Device paired and approved.')]")
        .waitForExist({ timeout: 30_000 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("syncs a whole favorite folder with Android's separate editor", async () => {
    const serial = process.env.SYNCPEER_ANDROID_SERIAL;
    assert.ok(serial?.startsWith("emulator-"));
    await clickButtonByText(browser, "Back");
    await $("[data-testid='tab-devices']").click();
    const ownerId = (await $("[data-testid='current-device-id']").getText()).trim();
    assert.ok(ownerId);
    const root = await mkdtemp(path.join(tmpdir(), "syncpeer-crossapp-folder-"));
    const forwardedPort = await freePort();
    const listenPort = await freePort();
    try {
      const androidIdPath = path.join(root, "android-id");
      android(serial, ["--write-device-id", androidIdPath]);
      const androidId = (await readFile(androidIdPath, "utf8")).trim();
      assert.ok(androidId);
      android(serial, ["--prepare-whole-folder"], { SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId });
      execFileSync("adb", ["-s", serial, "install", "-r",
        "packages/tauri-shell/src-tauri/plugins/syncpeer-android/editor-test-app/build/outputs/apk/debug/syncpeer-document-editor-debug.apk"],
        { stdio: "inherit", timeout: 120_000 });
      android(serial, ["--grant-whole-folder-editor"], { SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId });
      console.log("Cross-app editor grant completed; configuring direct connection.");
      execFileSync("adb", ["-s", serial, "forward", `tcp:${forwardedPort}`, "tcp:22000"]);
      await browser.execute(() => { window.prompt = () => "synthetic-desktop-crossapp"; });
      console.log("Cross-app opening desktop connection settings.");
      await browser.execute(() => {
        const tab = document.querySelector("[data-testid='tab-devices']");
        if (!(tab instanceof HTMLButtonElement)) throw new Error("Device tab is unavailable.");
        tab.click();
      });
      await browser.execute(() => {
        const toggle = document.querySelector("[data-testid='connection-settings-toggle']");
        if (!(toggle instanceof HTMLButtonElement)) throw new Error("Connection settings are unavailable.");
        if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      });
      console.log("Cross-app setting desktop direct endpoint.");
      await setDirectConnectionFields(browser, { remoteId: androidId, host: "127.0.0.1",
        remotePort: forwardedPort, listenPort });
      console.log("Cross-app desktop direct endpoint configured.");
      const androidConnection = spawn(process.execPath,
        ["scripts/test-android-e2e.mjs", "--connect-whole-folder"], {
          cwd: process.cwd(), stdio: "inherit", env: { ...process.env, ANDROID_SERIAL: serial,
            SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId, SYNCPEER_E2E_FOLDER_ID: folderId,
            SYNCPEER_E2E_FOLDER_PASSWORD: password, SYNCPEER_ANDROID_DISCOVERY_MODE: "direct",
            SYNCPEER_ANDROID_DIRECT_HOST: "10.0.2.2", SYNCPEER_ANDROID_DIRECT_PORT: String(listenPort) },
        });
      try {
        await new Promise<void>((resolve, reject) => {
          androidConnection.once("error", reject);
          androidConnection.once("exit", code => code === 0 ? resolve() : reject(new Error(`Android connection failed: ${code}`)));
        });
        console.log("Cross-app Android background session connected; checking desktop status.");
        try {
          await browser.waitUntil(async () =>
            (await $("[data-testid='connection-status']").getText()).includes("Connected"),
          { timeout: 120_000, timeoutMsg: "The packaged desktop did not connect to Android." });
        } catch (cause) {
          const state = await browser.execute(() => ({
            status: document.querySelector("[data-testid='connection-status']")?.textContent?.trim() ?? "missing",
            error: [...document.querySelectorAll("p.error, p[role='alert']")]
              .map(element => element.textContent?.trim() ?? "")
              .filter(Boolean)
              .at(0) ?? "",
          })).catch(() => ({ status: "unavailable", error: "" }));
          const error = safeNativeFailureText(state.error)
            ?.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[address]")
            .replace(/:\d{2,5}\b/g, ":[port]")
            .replaceAll(folderId, "[folder]") ?? "none";
          const diagnostics = await browser.execute(() =>
            [...document.querySelectorAll(".list li")].flatMap(row => {
              const header = row.querySelector(".item-meta")?.textContent?.trim() ?? "";
              const event = header.split(" | ").at(-1) ?? "";
              if (!/session|incoming|connect|handshake|closed|failed|recovery|tauri\.invoke\.error/i.test(event)) return [];
              const rawDetails = row.querySelector(".log-details")?.textContent ?? "";
              try {
                const details = JSON.parse(rawDetails) as { command?: unknown; message?: unknown; error?: unknown };
                const command = typeof details.command === "string" ? details.command : "";
                const messageEvents = ["core.incoming.failed", "core.background.prepare.failed",
                  "core.incoming.prepare.failed", "core.incoming.refresh.failed", "core.session.refresh.failed",
                  "core.socket.closed", "session.lifecycle_recovery.failed"];
                const detail = details.message ?? details.error;
                const message = messageEvents.includes(event) && typeof detail === "string" ? detail : "";
                return [{ event, command, message }];
              } catch { return [{ event, command: "", message: "" }]; }
            }).slice(0, 40),
          ).catch(() => readSessionEventNames(browser).catch(() => []));
          const events = diagnostics.map(entry => {
            if (typeof entry === "string") return entry;
            const message = safeNativeFailureText(entry.message)
              ?.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[address]")
              .replace(/:\d{2,5}\b/g, ":[port]")
              .replaceAll(folderId, "[folder]");
            if (message) return `${entry.event}:${message}`;
            return entry.command ? `${entry.event}:${entry.command}` : entry.event;
          });
          throw new Error(`Packaged desktop connection state: ${state.status}; error=${error}; ` +
            `recent events=${events.join(",") || "unavailable"}`, { cause });
        }
        console.log("Cross-app desktop connected; checking shared folder credential.");
        await attachSharedFolder();
        console.log("Cross-app shared folder attached on desktop.");
        await browser.execute(() => {
          const tab = document.querySelector("[data-testid='tab-folders']");
          if (!(tab instanceof HTMLButtonElement)) throw new Error("Folder tab is unavailable.");
          tab.click();
        });
        // Attaching the folder invalidates and reopens the live session, which can
        // rebuild the root list under us. Re-click the root while the same bounded
        // window elapses; opening the folder must still succeed.
        const navigationDeadline = Date.now() + 90_000;
        for (;;) {
          const folderRoot = $(`[data-testid='folder-root-${folderId}']`);
          if (await folderRoot.isExisting()) {
            await browser.execute((id: string) => {
              const row = document.querySelector(`[data-testid='folder-root-${id}']`);
              if (row instanceof HTMLElement) row.click();
            }, folderId);
            try {
              await $("#folder-upload-input").waitForExist({ timeout: 15_000 });
              break;
            } catch { /* Retry while the refresh finishes. */ }
          } else {
            await browser.pause(1_000);
          }
          if (Date.now() > navigationDeadline) {
            throw new Error("Desktop could not open the attached folder root.");
          }
        }
        android(serial, ["--edit-whole-folder"], { SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
          SYNCPEER_E2E_FILE_NAME: "from-android.txt", SYNCPEER_E2E_FILE_CONTENT: "android-one" });
        await waitForDesktopFile("from-android.txt", "android-one");
        await uploadDesktopFile("from-desktop.txt", "desktop-one");
        android(serial, ["--verify-whole-folder"], { SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
          SYNCPEER_E2E_FILE_NAME: "from-desktop.txt", SYNCPEER_E2E_FILE_CONTENT: "desktop-one" });
      } finally { if (androidConnection.exitCode === null) androidConnection.kill("SIGTERM"); }
    } finally {
      // The emulator may already be gone; never mask the real failure here.
      try {
        execFileSync("adb", ["-s", serial, "forward", "--remove", `tcp:${forwardedPort}`],
          { stdio: "ignore" });
      } catch { /* Forward cleanup is best-effort. */ }
      await rm(root, { recursive: true, force: true });
    }
  });
});
