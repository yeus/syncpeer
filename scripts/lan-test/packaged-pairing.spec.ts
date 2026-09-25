import assert from "node:assert/strict";
import net from "node:net";
import { browser } from "@wdio/globals";
import { preferredPeerDirection } from "../../packages/core/src/sync/peerSessionManager.js";
import { createFreshEncryptedProfile } from "./profile-setup.js";

const peers = () => browser as typeof browser & { owner: WebdriverIO.Browser; joiner: WebdriverIO.Browser };
const folderName = "Synthetic desktop folder";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function isListening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function configureConnection(peer: WebdriverIO.Browser, remoteId: string,
  remotePort: number, localPort: number) {
  await peer.$("[data-testid='tab-devices']").click();
  const toggle = peer.$("[data-testid='connection-settings-toggle']");
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  const expert = peer.$("[data-testid='expert-view']");
  if (!await expert.isSelected()) await expert.click();
  const status = peer.$("[data-testid='connection-status-toggle']");
  if (await status.getAttribute("aria-expanded") !== "true") await status.click();
  const control = peer.$("[data-testid='expert-connection-control']");
  if ((await control.getText()).includes("Pause automatic connection")) await control.click();
  await peer.$("[data-testid='connection-discovery-mode']").selectByAttribute("value", "direct");
  await peer.$("[data-testid='connection-direct-quic']").waitForExist({ timeout: 5_000 });
  await peer.execute(({ remoteId, remotePort, localPort }) => {
    for (const [testId, value] of [
      ["connection-remote-id", remoteId],
      ["connection-host", "127.0.0.1"],
      ["connection-port", String(remotePort)],
      ["connection-listen-port", String(localPort)],
    ]) {
      const field = document.querySelector(`[data-testid='${testId}']`) as HTMLInputElement | null;
      if (!field) throw new Error(`Connection field ${testId} is unavailable.`);
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, { remoteId, remotePort, localPort });
  assert.equal(await peer.$("[data-testid='connection-remote-id']").getValue(), remoteId);
  assert.equal(await peer.$("[data-testid='connection-host']").getValue(), "127.0.0.1");
  assert.equal(await peer.$("[data-testid='connection-discovery-mode']").getValue(), "direct");
  assert.equal(await peer.$("[data-testid='connection-port']").getValue(), String(remotePort));
  assert.equal(await peer.$("[data-testid='connection-listen-port']").getValue(), String(localPort));
  await peer.pause(750);
  assert.equal(await peer.$("[data-testid='connection-port']").getValue(), String(remotePort));
  assert.equal(await peer.$("[data-testid='connection-listen-port']").getValue(), String(localPort));
}

async function openFolder(peer: WebdriverIO.Browser, name: string) {
  await peer.$("[data-testid='tab-folders']").click();
  const row = peer.$(`//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(name)}]`);
  await row.waitForExist({ timeout: 30_000 });
  await row.click();
  await peer.$("#folder-upload-input").waitForExist({ timeout: 30_000 });
}

async function uploadFile(peer: WebdriverIO.Browser, name: string, content: string) {
  await peer.execute(({ name, content }) => {
    const input = document.getElementById("folder-upload-input") as HTMLInputElement | null;
    if (!input) throw new Error("The folder upload input is unavailable.");
    const transfer = new DataTransfer();
    transfer.items.add(new File([content], name));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, { name, content });
  try {
    await peer.$(`//*[contains(@class,'hint') and normalize-space()=${JSON.stringify(`Uploaded ${name}.`)}]`)
      .waitForExist({ timeout: 30_000 });
  } catch (error) {
    const hints = await peer.execute(() => [...document.querySelectorAll(".hint, p.error")]
      .map(element => element.textContent?.trim()).filter(Boolean).slice(-5));
    throw new Error(`Packaged upload did not complete: ${JSON.stringify(hints)}`, { cause: error });
  }
}

async function waitForFile(peer: WebdriverIO.Browser, name: string) {
  await peer.$(`//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(name)}]`)
    .waitForExist({ timeout: 120_000 });
}

async function acceptPendingApproval(peer: WebdriverIO.Browser) {
  const message = await peer.getAlertText().catch(() => "");
  if (!message) return;
  assert.match(message, /Confirm that both devices display pairing code/);
  await peer.acceptAlert();
}

async function captureSelectedFolderCounts(peer: WebdriverIO.Browser) {
  await peer.execute(() => {
    const observed = window as typeof window & { __syntheticFolderCounts?: number[];
      __syntheticEvents?: string[]; __syntheticFailures?: string[]; __syntheticIndexes?: string[];
      __syntheticSelectionEvents?: number; __syntheticNativeCalls?: Record<string, number> };
    observed.__syntheticFolderCounts = [];
    observed.__syntheticEvents = [];
    observed.__syntheticFailures = [];
    observed.__syntheticIndexes = [];
    observed.__syntheticSelectionEvents = 0;
    observed.__syntheticNativeCalls = {};
    const summary = [...document.querySelectorAll("summary")]
      .find(value => value.textContent?.includes("View logs"));
    const list = summary?.parentElement?.querySelector("ul.list");
    if (!list) throw new Error("The session log list is unavailable.");
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (!(node instanceof Element) || !node.matches("li")) continue;
        for (const entry of node.querySelectorAll(".item-meta")) {
        const event = entry.textContent?.split(" | ").at(-1)?.trim();
        if (event?.startsWith("tauri.invoke.")) {
          const details = node.querySelector("pre.log-details")?.textContent;
          const command = details ? (JSON.parse(details) as { command?: string }).command : undefined;
          if (command === "syncpeer_tls_accept" || command === "syncpeer_tls_listen") {
            const key = `${event}:${command}`;
            observed.__syntheticNativeCalls![key] = (observed.__syntheticNativeCalls![key] ?? 0) + 1;
          }
        }
        if (event && /^(client\.|core\.)/.test(event) &&
          !observed.__syntheticEvents?.includes(event)) observed.__syntheticEvents?.push(event);
        if (event === "core.upload.request.failed" || event === "core.replica.receive.failed") {
          const details = entry.closest("li")?.querySelector("pre.log-details")?.textContent;
          if (details) {
            const message = (JSON.parse(details) as { message?: string }).message;
            if (message && !observed.__syntheticFailures?.includes(message)) observed.__syntheticFailures?.push(message);
          }
        }
        if (event === "core.index.received" || event === "core.index.applied") {
          const details = entry.closest("li")?.querySelector("pre.log-details")?.textContent;
          if (details) {
            const info = JSON.parse(details) as { fileCount?: number; storedFiles?: number;
              processedFiles?: number; decryptedStored?: number; decryptFailed?: number;
              needsPassword?: boolean; passwordError?: string | null };
            const summary = JSON.stringify({ event, fileCount: info.fileCount,
              storedFiles: info.storedFiles, processedFiles: info.processedFiles,
              decryptedStored: info.decryptedStored, decryptFailed: info.decryptFailed,
              needsPassword: info.needsPassword, passwordError: info.passwordError });
            if (!observed.__syntheticIndexes?.includes(summary)) observed.__syntheticIndexes?.push(summary);
          }
        }
        if (event !== "client.shared_folders.selected") continue;
        observed.__syntheticSelectionEvents = (observed.__syntheticSelectionEvents ?? 0) + 1;
        const details = node.querySelector("pre.log-details")?.textContent;
        if (!details) continue;
        const count = (JSON.parse(details) as { internalCount?: number }).internalCount;
        if (typeof count === "number" && !observed.__syntheticFolderCounts?.includes(count)) {
          observed.__syntheticFolderCounts?.push(count);
        }
        }
      }
    });
    observer.observe(list, { childList: true });
  });
}

async function attachAndFavoriteSharedFolder(peer: WebdriverIO.Browser) {
  let lastAlert = "";
  let sawFolderElsewhere = false;
  let vaultLocked = false;
  let hasSharedConflict = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await peer.$("[data-testid='tab-folders']").click();
    await peer.$("button=Folder settings · New folder").click();
    const row = peer.$(`//li[./span[normalize-space()=${JSON.stringify(folderName)}]]`);
    if (await row.isExisting()) {
      const attach = row.$("button=Reattach encrypted local storage");
      if (await attach.isExisting()) {
        await attach.click();
        await attach.waitForExist({ reverse: true, timeout: 30_000 });
      }
      await peer.$("button=Back").click();
      const root = peer.$(`//li[.//*[contains(@class,'item-title') and normalize-space()=${JSON.stringify(folderName)}]]`);
      await root.waitForExist({ timeout: 30_000 });
      const favorite = root.$("button[aria-label='Toggle favorite']");
      if (await favorite.getAttribute("aria-pressed") !== "true") await favorite.click();
      return;
    }
    lastAlert = await peer.$("p[role='alert']").getText().catch(() => "");
    sawFolderElsewhere = await peer.execute(name => document.body.innerText.includes(name), folderName);
    vaultLocked = await peer.$("//label[contains(.,'Unlock existing storage')]").isExisting();
    hasSharedConflict = await peer.$("//h2[normalize-space()='Shared settings need a choice']").isExisting();
    await peer.$("button=Back").click();
    await peer.pause(2_000);
  }
  await peer.$("[data-testid='tab-devices']").click();
  const events = await peer.execute(() => (window as typeof window & {
    __syntheticEvents?: string[] }).__syntheticEvents ?? []);
  const indexes = await peer.execute(() => (window as typeof window & {
    __syntheticIndexes?: string[] }).__syntheticIndexes ?? []);
  const failures = await peer.execute(() => (window as typeof window & {
    __syntheticFailures?: string[] }).__syntheticFailures ?? []);
  const logSummary = await peer.execute(() => [...document.querySelectorAll("summary")]
    .find(element => element.textContent?.includes("View logs"))?.textContent?.trim() ?? "missing");
  throw new Error(`The approved folder credential did not reach the joined desktop. ` +
    `Visible elsewhere: ${sawFolderElsewhere}; vault locked: ${vaultLocked}; ` +
    `settings conflict: ${hasSharedConflict}; settings alert: ${lastAlert || "none"}; ` +
    `${logSummary}; recent events: ${events.join(",")}; index summaries: ${indexes.join(",")}; ` +
    `receive failures: ${failures.join(",")}.`);
}

describe("Two isolated packaged desktop apps", () => {
  it("start with distinct protected device identities", async () => {
    const { owner, joiner } = peers();
    await Promise.all([owner, joiner].map(async peer => {
      await peer.$("[data-testid='tab-devices']").click();
      await peer.$("[data-testid='current-device-id']").waitForExist({ timeout: 60_000 });
    }));
    const ownerId = await owner.$("[data-testid='current-device-id']").getText();
    const joinerId = await joiner.$("[data-testid='current-device-id']").getText();
    assert.match(ownerId, /^[A-Z2-7-]{40,}$/);
    assert.match(joinerId, /^[A-Z2-7-]{40,}$/);
    assert.notEqual(ownerId, joinerId);
  });

  it("pairs with one matching confirmation code", async () => {
    const { owner, joiner } = peers();
    await createFreshEncryptedProfile(owner);
    await joiner.$("[data-testid='tab-folders']").click();
    await joiner.$("button=Folder settings · New folder").click();
    await owner.$("//label[contains(., 'LAN host/IP or relay:// URL')]/input")
      .setValue("127.0.0.1");
    const createInvitation = owner.$("button=Create pairing invitation");
    await createInvitation.waitForEnabled({ timeout: 30_000 });
    await createInvitation.click();
    const invitationInput = owner.$("//label[contains(., 'Invitation')]/textarea[@readonly]");
    try { await invitationInput.waitForExist({ timeout: 30_000 }); }
    catch (error) {
      const issue = await owner.$("p[role='alert']").getText().catch(() => "No pairing error was shown.");
      throw new Error(`Packaged pairing invitation failed: ${issue}`, { cause: error });
    }
    const invitation = await invitationInput.getValue();
    assert.ok(invitation.includes("endpoint"));
    await joiner.$("//label[contains(., 'Pairing invitation')]/textarea").setValue(invitation);
    await joiner.$("//label[contains(., 'New local master password')]/input")
      .setValue("synthetic-joining-master-password");
    await joiner.$("button=Join personal space").click();
    const codes = await Promise.all([owner, joiner].map(async peer => {
      await peer.waitUntil(async () => Boolean(await peer.getAlertText().catch(() => "")),
        { timeout: 30_000, timeoutMsg: "Pairing confirmation was not displayed." });
      const message = await peer.getAlertText();
      const code = message.match(/\b\d{6}\b/)?.[0];
      assert.ok(code, "Pairing confirmation must include a six-digit code.");
      return code;
    }));
    assert.equal(codes[0], codes[1]);
    await Promise.all([owner.acceptAlert(), joiner.acceptAlert()]);
    await owner.$("//*[contains(text(),'Device paired and approved.')]")
      .waitForExist({ timeout: 120_000 });
    await joiner.$("//*[contains(text(),'Personal space joined and device approved.')]")
      .waitForExist({ timeout: 120_000 });
    await Promise.all([owner, joiner].map(async peer => {
      await peer.$("button=Create folder").waitForExist({ timeout: 30_000 });
      await peer.$("//h2[normalize-space()='Devices with access to this space']").waitForExist({ timeout: 30_000 });
    }));
    const memberships: string[][] = [];
    for (const peer of [owner, joiner]) {
      const listed = await peer.execute(() => {
        const heading = [...document.querySelectorAll("h2")]
          .find(value => value.textContent?.trim() === "Devices with access to this space");
        return [...(heading?.parentElement?.querySelectorAll("code") ?? [])]
          .map(code => code.textContent?.trim() ?? "");
      });
      assert.ok(listed.length >= 2, "The trusted-device list must contain both packaged peers.");
      memberships.push(listed.map(value => value.replaceAll("-", "")).sort());
    }
    assert.deepEqual(memberships[0], memberships[1], "Both packaged devices must agree on the signed membership.");
  });

  it("replicates a whole favorite folder in both directions", async () => {
    const { owner, joiner } = peers();
    console.log("Packaged folder test: leaving pairing screens.");
    for (const peer of [owner, joiner]) {
      await acceptPendingApproval(peer);
      const back = peer.$("button=Back");
      await back.waitForExist({ timeout: 30_000 });
      await back.click();
      await peer.$("[data-testid='tab-devices']").click();
    }
    const [ownerId, joinerId] = await Promise.all([owner, joiner]
      .map(peer => peer.$("[data-testid='current-device-id']").getText()));
    await owner.$("[data-testid='tab-folders']").click();
    await owner.$("button=Folder settings · New folder").click();
    console.log("Packaged folder test: creating owner folder.");
    await owner.$("//label[contains(., 'New folder name')]/input").setValue(folderName);
    assert.equal(await owner.$("//label[contains(., 'New folder name')]/input").getValue(), folderName);
    const createFolder = owner.$("button=Create folder");
    await createFolder.waitForEnabled({ timeout: 10_000 });
    await createFolder.click();
    try {
      const folderExists = async () => (await owner.$("li > span").getText().catch(() => ""))
        .includes(folderName);
      for (let attempt = 0; attempt < 30 && !await folderExists(); attempt += 1) {
        if (!await owner.$("//label[contains(., 'New folder name')]/input").isExisting()) {
          await owner.$("[data-testid='tab-folders']").click();
          await owner.$("button=Folder settings · New folder").click();
        }
        await owner.pause(1_000);
      }
      assert.ok(await folderExists(), "The newly created folder is absent from Folder settings.");
    } catch (error) {
      const issue = await owner.$("p[role='alert']").getText().catch(() => "none");
      const state = await owner.execute(() => ({
        heading: [...document.querySelectorAll("h1, h2")].map(value => value.textContent?.trim()).slice(0, 8),
        folderNameInput: [...document.querySelectorAll("label")]
          .find(value => value.textContent?.includes("New folder name"))?.querySelector("input")?.value ?? "missing",
        folders: [...document.querySelectorAll("li > span")].map(value => value.textContent?.trim()).filter(Boolean),
        status: [...document.querySelectorAll("p[role='status'], p.error")].map(value => value.textContent?.trim()),
      }));
      throw new Error(`Packaged owner folder creation failed: ${issue}; ${JSON.stringify(state)}`, { cause: error });
    }
    await owner.$("button=Back").click();
    await owner.$("[data-testid='tab-devices']").click();
    console.log("Packaged folder test: preparing peer connection.");
    await joiner.$("//label[contains(., 'Device ID')]/input").setValue(ownerId);
    await joiner.$("button=Add Device").click();
    const ownerPort = await freePort();
    let joinerPort = await freePort();
    while (joinerPort === ownerPort) joinerPort = await freePort();
    // Signed enrollment was confirmed in the preceding case. The first live
    // connection also asks for a separate device/folder approval.
    await Promise.all([owner, joiner].map((peer, index) => peer.execute((name: string) => {
      window.confirm = () => true;
      window.prompt = () => name;
    }, `synthetic-desktop-${index + 1}`)));
    await configureConnection(owner, joinerId, joinerPort, ownerPort);
    await configureConnection(joiner, ownerId, ownerPort, joinerPort);
    await Promise.all([owner, joiner].map(captureSelectedFolderCounts));
    console.log("Packaged folder test: resuming direct connections.");
    // The higher device ID accepts the retained socket. Resume it first;
    // each app's connection loop then keeps trying until the listener is ready.
    const ownerAccepts = preferredPeerDirection(ownerId, joinerId) === "incoming";
    const acceptor = ownerAccepts ? owner : joiner;
    const dialer = ownerAccepts ? joiner : owner;
    await acceptor.$("[data-testid='expert-connection-control']").click();
    await dialer.$("[data-testid='expert-connection-control']").click();
    try { await Promise.all([owner, joiner].map(peer => peer.waitUntil(async () => {
      try {
        return (await peer.$("[data-testid='connection-status']").getText()).includes("Connected");
      } catch (error) {
        if (String(error).includes("unexpected alert open")) {
          await acceptPendingApproval(peer);
          return false;
        }
        throw error;
      }
    }, { timeout: 120_000, timeoutMsg: "Packaged desktop peers did not connect." }))); }
    catch (error) {
      const phases = await Promise.all([owner, joiner].map(async peer => ({
        phase: await peer.$("[data-testid='connection-status']").getText().catch(() => "unavailable"),
        error: await peer.$("p.error").getText().catch(() => "none"),
        events: await peer.execute(() => (window as typeof window & {
          __syntheticEvents?: string[] }).__syntheticEvents ?? []),
        selections: await peer.execute(() => (window as typeof window & {
          __syntheticFolderCounts?: number[] }).__syntheticFolderCounts ?? []),
        selectionEvents: await peer.execute(() => (window as typeof window & {
          __syntheticSelectionEvents?: number }).__syntheticSelectionEvents ?? 0),
        nativeCalls: await peer.execute(() => (window as typeof window & {
          __syntheticNativeCalls?: Record<string, number> }).__syntheticNativeCalls ?? {}),
      })));
      const listeners = await Promise.all([ownerPort, joinerPort, 22000].map(isListening));
      throw new Error(`Packaged desktop connection failed: ${JSON.stringify(phases)}; ` +
        `expected listeners: ${JSON.stringify(listeners)}.`, { cause: error });
    }
    for (const peer of [owner, joiner]) {
      const selections = await peer.execute(() => (window as typeof window & {
        __syntheticFolderCounts?: number[] }).__syntheticFolderCounts ?? []);
      assert.ok(selections.includes(1),
        `The packaged peer did not select its encrypted settings replica: ${JSON.stringify(selections)}.`);
    }
    try { await attachAndFavoriteSharedFolder(joiner); }
    catch (error) {
      const ownerEvents = await owner.execute(() => {
        const observed = window as typeof window & {
          __syntheticEvents?: string[]; __syntheticFailures?: string[]; __syntheticIndexes?: string[] };
        return { __syntheticEvents: observed.__syntheticEvents,
          __syntheticFailures: observed.__syntheticFailures,
          __syntheticIndexes: observed.__syntheticIndexes };
      });
      throw new Error(`${String(error)}; owner events: ${ownerEvents.__syntheticEvents?.join(",")}; ` +
        `upload failures: ${ownerEvents.__syntheticFailures?.join(",")}; ` +
        `owner indexes: ${ownerEvents.__syntheticIndexes?.join(",")}.`, { cause: error });
    }
    for (const peer of [owner, joiner]) {
      await peer.$("[data-testid='expert-connection-control']").click();
    }
    for (const peer of [owner, joiner]) {
      await peer.$("[data-testid='expert-connection-control']").click();
    }
    await Promise.all([owner, joiner].map(peer => peer.waitUntil(async () =>
      (await peer.$("[data-testid='connection-status']").getText()).includes("Connected"),
    { timeout: 120_000, timeoutMsg: "Paired desktops did not reconnect after enabling the shared folder." })));
    await openFolder(owner, folderName);
    await uploadFile(owner, "from-owner.txt", "owner-one");
    await openFolder(joiner, folderName);
    await waitForFile(joiner, "from-owner.txt");
    await uploadFile(joiner, "from-joiner.txt", "joiner-one");
    await waitForFile(owner, "from-joiner.txt");
  });
});
