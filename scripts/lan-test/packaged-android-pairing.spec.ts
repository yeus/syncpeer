import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { $, browser } from "@wdio/globals";
import { createFreshEncryptedProfile } from "./profile-setup.js";

const folderId = "syncpeer-crossapp-folder";
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

async function waitForDesktopFile(name: string, expected: string | null) {
  await browser.waitUntil(async () => {
    const entry = $(`//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(name)}]`);
    if (!await entry.isExisting()) return expected === null;
    if (expected === null) return false;
    const bytes = await browser.execute(async request => {
      const internals = (window as typeof window & { __TAURI_INTERNALS__?: {
        invoke: (name: string, args: unknown) => Promise<number[]> } }).__TAURI_INTERNALS__;
      if (!internals) throw new Error("The packaged native bridge is unavailable.");
      return internals.invoke("syncpeer_read_cached_file", { request });
    }, { folderId, path: name }).catch(() => null);
    return bytes !== null && new TextDecoder().decode(new Uint8Array(bytes)) === expected;
  }, { timeout: 120_000, interval: 500,
    timeoutMsg: `Desktop did not converge ${name} to the expected synthetic state.` });
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await $("[data-testid='tab-folders']").click();
    await $("button=Folder settings · New folder").click();
    const row = $(`//li[./span[normalize-space()=${JSON.stringify(folderId)}]]`);
    if (await row.isExisting()) {
      const attach = row.$("button=Reattach encrypted local storage");
      if (await attach.isExisting()) {
        await attach.click();
        await attach.waitForExist({ reverse: true, timeout: 30_000 });
      }
      await $("button=Back").click();
      const root = $(`//li[.//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(folderId)}]]`);
      await root.waitForExist({ timeout: 30_000 });
      const favorite = root.$("button[aria-label='Toggle favorite']");
      if (await favorite.getAttribute("aria-pressed") !== "true") await favorite.click();
      return;
    }
    await $("button=Back").click();
    await browser.pause(2_000);
  }
  throw new Error("The approved Android folder credential did not reach the packaged desktop.");
}

describe("Packaged desktop to Android pairing", () => {
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
    await create.click();
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
    await $("button=Back").click();
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
      execFileSync("adb", ["-s", serial, "forward", `tcp:${forwardedPort}`, "tcp:22000"]);
      await browser.execute(() => { window.prompt = () => "synthetic-desktop-crossapp"; });
      await $("[data-testid='tab-devices']").click();
      const toggle = $("[data-testid='connection-settings-toggle']");
      if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
      await $("[data-testid='connection-discovery-mode']").selectByAttribute("value", "direct");
      await $("[data-testid='connection-host']").setValue("127.0.0.1");
      await $("[data-testid='connection-port']").setValue(String(forwardedPort));
      await $("[data-testid='connection-listen-port']").setValue(String(listenPort));
      await $("[data-testid='connection-remote-id']").setValue(androidId);
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
        await browser.waitUntil(async () =>
          (await $("[data-testid='connection-status']").getText()).includes("Connected"),
        { timeout: 120_000, timeoutMsg: "The packaged desktop did not connect to Android." });
        await attachSharedFolder();
        await $("[data-testid='tab-folders']").click();
        const folder = $(`//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(folderId)}]`);
        await folder.waitForExist({ timeout: 30_000 });
        await folder.click();
        await $("#folder-upload-input").waitForExist({ timeout: 30_000 });
        android(serial, ["--edit-whole-folder"], { SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
          SYNCPEER_E2E_FILE_NAME: "from-android.txt", SYNCPEER_E2E_FILE_CONTENT: "android-one" });
        await waitForDesktopFile("from-android.txt", "android-one");
        await uploadDesktopFile("from-desktop.txt", "desktop-one");
        android(serial, ["--verify-whole-folder"], { SYNCPEER_DEV_SERVER_DEVICE_ID: ownerId,
          SYNCPEER_E2E_FILE_NAME: "from-desktop.txt", SYNCPEER_E2E_FILE_CONTENT: "desktop-one" });
      } finally { if (androidConnection.exitCode === null) androidConnection.kill("SIGTERM"); }
    } finally {
      execFileSync("adb", ["-s", serial, "forward", "--remove", `tcp:${forwardedPort}`],
        { stdio: "ignore" });
      await rm(root, { recursive: true, force: true });
    }
  });
});
