import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { sameDeviceId } from "@syncpeer/core/browser";
import { addKeepassEntry, keepassEntries, keepassFilename, keepassPackage, keepassPassword,
  keepassAttachment, importKeepassAttachment, verifyKeepassAttachment } from "./keepass-fixture.mjs";

// All UI actions go through the actual installed KeePass2Android app and OS picker.
// The synthetic editor is only an independent read-only probe of the provider.
export const runKeepassAcceptance = async ({
  runAdb, wait, captureUiHierarchy, recoverEmulatorAnr, nodeBounds,
  tapDocumentUiText, tapDocumentUiContentDescription, editorCommand,
  scanPeerFolder, peerHostFolder, peerGuiUrl, peerApiKey, targetFolderId, targetFolderTitle,
  rebootAndReconnect, listCachedFiles,
}) => {
  if (!peerHostFolder || !peerGuiUrl || !peerApiKey ||
      runAdb(["shell", "getprop", "ro.kernel.qemu"]).trim() !== "1") {
    throw new Error("KeePass acceptance requires a disposable emulator and real test peer.");
  }
  const database = path.join(peerHostFolder, keepassFilename);
  const resource = (id) => (node) => node.includes(`resource-id="${keepassPackage}:id/${id}"`);
  const title = (value) => (node) => node.includes(`text="${value}"`);
  const description = (value) => (node) => node.includes(`content-desc="${value}"`);
  const hierarchy = () => captureUiHierarchy("/sdcard/syncpeer-keepass-test.xml");
  const find = async (predicates, label, click = true, timeout = 60_000, reveal) => {
    const deadline = Date.now() + timeout;
    let last = "";
    while (Date.now() < deadline) {
      last = await hierarchy();
      if (recoverEmulatorAnr(last)) { await wait(1_000); continue; }
      const nodes = last.match(/<node\b[^>]*>/g) ?? [];
      const dialogTitle = nodes.find(candidate => resource("alertTitle")(candidate));
      const templates = dialogTitle && title("Add templates?")(dialogTitle);
      if (templates || (dialogTitle && title("Change log")(dialogTitle))) {
        const buttonId = templates ? "button2" : "button1";
        const confirm = nodes.find(candidate => candidate.includes('enabled="true"') &&
          (candidate.includes(`resource-id="android:id/${buttonId}"`) || resource(buttonId)(candidate)) &&
          nodeBounds(candidate));
        if (confirm) {
          const { x, y } = nodeBounds(confirm);
          runAdb(["shell", "input", "tap", String(x), String(y)]);
        } else {
          runAdb(["shell", "input", "keyevent", "4"]);
        }
        await wait(500);
        continue;
      }
      const node = predicates.map(predicate => nodes.find(candidate => predicate(candidate) &&
        candidate.includes('enabled="true"') && nodeBounds(candidate))).find(Boolean);
      if (node) {
        if (click) {
          const { x, y } = nodeBounds(node);
          runAdb(["shell", "input", "tap", String(x), String(y)]);
        }
        return node;
      }
      reveal?.(nodes);
      await wait(400);
    }
    throw new Error(`KeePass UI missing ${label}; visible=${JSON.stringify(
      [...last.matchAll(/(?:text|resource-id|content-desc)="([^"]+)"/g)].map(m => m[1]).slice(0, 70))}`);
  };
  const enter = async (id, value) => {
    await find([resource(id)], id);
    runAdb(["shell", "input", "text", value]);
  };
  const launch = () => runAdb(["shell", "monkey", "-p", keepassPackage, "-c", "android.intent.category.LAUNCHER", "1"]);
  const unlock = async () => {
    // After a cold launch KP2A opens the keyboard and its collapsing toolbar
    // can clip the password input below the scroll viewport. Scroll only the
    // actual KP2A password form, never bypass the persisted SAF database.
    await find([resource("password_edit"), node =>
      node.includes(`package="${keepassPackage}"`) && node.includes('class="android.widget.EditText"') &&
      node.includes('password="true"')], "database password", true, 60_000, nodes => {
      const scroll = nodes.find(resource("scrollview"));
      const bounds = scroll?.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!bounds || !nodes.some(title("Password"))) return;
      const [left, top, right, bottom] = bounds.slice(1).map(Number);
      if (bottom - top < 50) return;
      const x = Math.round((left + right) / 2), margin = Math.round((bottom - top) / 8);
      runAdb(["shell", "input", "swipe", String(x), String(bottom - margin),
        String(x), String(top + margin), "400"]);
    });
    runAdb(["shell", "input", "text", keepassPassword]);
    // Hide the keyboard without navigating away from the unlocked database.
    await find([resource("pass_ok")], "unlock database");
    await find([resource("fabAddNew"), resource("fabAddNewEntry"), title("initial-fixture")], "database unlocked", false);
  };
  const add = async (name) => {
    const node = await find([resource("fabAddNew"), resource("fabAddNewEntry")], "add entry");
    if (!resource("fabAddNewEntry")(node)) await find([resource("fabAddNewEntry"), title("Add entry")], "add entry action");
    await enter("entry_title", name);
    await enter("entry_user_name", "synthetic-user");
    await find([resource("menu_save"), description("Save"), title("Save")], "save database");
    await find([title(name)], "saved entry " + name, false, 90_000);
  };
  const assertEntry = (name) => find([title(name)], "entry " + name, false, 90_000);
  const eventually = async (label, check, timeout = 150_000) => {
    const deadline = Date.now() + timeout;
    let error;
    while (Date.now() < deadline) {
      try { if (await check()) return; }
      catch (cause) { error = cause; }
      await wait(500);
    }
    throw new Error("KeePass acceptance timed out: " + label, { cause: error });
  };
  const hasHostEntries = (...entries) => {
    const names = keepassEntries(database);
    return entries.every(name => names.includes(name));
  };
  const expectHost = (...entries) => eventually(
    "host decrypts entries " + entries.join(", "), () => hasHostEntries(...entries));
  const hostDigest = (file = database) => {
    const bytes = fs.readFileSync(file);
    return `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
  };
  const providerDigest = (name = keepassFilename) => editorCommand("digest", name);
  const expectProvider = () => eventually("SAF published the exact host KDBX bytes",
    () => editorCommand("stat", keepassFilename) === "true" && providerDigest() === hostDigest());
  const restartAndUnlock = async () => {
    runAdb(["shell", "am", "force-stop", keepassPackage]);
    launch();
    const recent = await find([resource("pass_ok"),
      node => node.includes(`package="${keepassPackage}"`) && /text="[^"]*syncpeer-acceptance\.kdbx[^"]*"/.test(node)],
    "previously opened database (no picker)", false);
    if (!resource("pass_ok")(recent)) {
      await find([node => node === recent || (node.includes(`package="${keepassPackage}"`) &&
        /text="[^"]*syncpeer-acceptance\.kdbx[^"]*"/.test(node))], "recent database");
    }
    await unlock();
  };
  const peerDevice = process.env.SYNCPEER_KEEPASS_DEVICE_ID;
  if (!peerDevice) throw new Error("Missing disposable Android peer ID.");
  const rest = async (endpoint, options = {}) => {
    const response = await fetch(peerGuiUrl + endpoint, {
      ...options, headers: { "X-API-Key": peerApiKey, "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error("Syncthing test API: " + response.status + " " + endpoint);
    return response;
  };
  const pausePeer = async (paused) => {
    const { connections } = await (await rest("/rest/system/connections")).json();
    const device = Object.keys(connections ?? {}).find(id => sameDeviceId(id, peerDevice));
    if (!device) throw new Error("Expected synthetic peer missing from Syncthing connections.");
    await rest("/rest/system/" + (paused ? "pause" : "resume") + "?device=" + encodeURIComponent(device), {
      method: "POST",
    });
    await eventually(paused ? "peer disconnected" : "peer reconnected", async () => {
      const { connections } = await (await rest("/rest/system/connections")).json();
      return connections?.[device]?.connected === !paused;
    });
  };
  const hostIndexedVersion = async () => {
    const query = new URLSearchParams({ folder: targetFolderId, file: keepassFilename });
    const { local } = await (await rest("/rest/db/file?" + query)).json();
    if (!local || local.deleted || !local.version) throw new Error("Synthetic host has no indexed database version.");
    return JSON.stringify(local.version);
  };

  await expectProvider();
  launch();
  await find([resource("start_open_file"), title("Open database")], "open database");
  await find([title("System file picker")], "SAF system file picker");
  // DocumentsUI may briefly return to its default Downloads root while
  // restoring the activity. Retry navigation, but never bypass the picker.
  let folderOpened = false;
  for (let attempt = 0; attempt < 3 && !folderOpened; attempt++) {
    try {
      await tapDocumentUiContentDescription("Show roots", 20_000);
      await wait(500);
      await tapDocumentUiText("Syncpeer", 20_000);
      await tapDocumentUiText(targetFolderTitle, 20_000);
      folderOpened = true;
    } catch (error) {
      console.warn("KeePass SAF root selection attempt " + (attempt + 1) + ": " + error.message);
      if (attempt === 2) throw error;
    }
  }
  await tapDocumentUiText(keepassFilename, 60_000);
  await unlock();
  await assertEntry("initial-fixture");
  await add("android-online");
  await expectHost("initial-fixture", "android-online");
  console.log("KeePass: Android save reached Syncthing and decrypted successfully in KeePassXC.");

  // Host update, observed independently in SAF, then a cold app restart without
  // choosing a file again. A stale private KP2A cache cannot satisfy this assertion.
  addKeepassEntry(database, "linux-online");
  await scanPeerFolder();
  await expectProvider();
  await restartAndUnlock();
  await assertEntry("android-online");
  await assertEntry("linux-online");
  console.log("KeePass: Linux update opened via persisted SAF access after app restart.");

  await expectProvider();
  const beforeOffline = hostDigest();
  try {
    await pausePeer(true);
    await add("android-offline");
    await eventually("offline save published through SAF", () => providerDigest() !== beforeOffline);
    if (hostDigest() !== beforeOffline || hasHostEntries("android-offline")) {
      throw new Error("Offline edit reached a paused peer.");
    }
    await pausePeer(false);
    await expectHost("initial-fixture", "android-online", "linux-online", "android-offline");
  } finally {
    await rest("/rest/config/devices/" + encodeURIComponent(peerDevice), {
      method: "PATCH", body: JSON.stringify({ paused: false }),
    });
  }
  console.log("KeePass: offline Android edit synchronized on reconnection.");

  // A new Linux edit after a real reboot makes a stale KP2A cache insufficient.
  await rebootAndReconnect();
  addKeepassEntry(database, "linux-after-reboot");
  await scanPeerFolder();
  await expectProvider();
  await restartAndUnlock();
  await assertEntry("android-offline");
  await assertEntry("linux-after-reboot");
  console.log("KeePass: persisted SAF access survived Android reboot and remote replacement.");

  // Round-trip a multi-block database with a real binary attachment. Its
  // contents are checked independently after a real Android editor save.
  const attachmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "syncpeer-keepass-attachment-"));
  try {
    const source = path.join(attachmentRoot, "input.bin");
    fs.writeFileSync(source, keepassAttachment());
    importKeepassAttachment(database, source);
    addKeepassEntry(database, "linux-large");
    await scanPeerFolder();
    await expectProvider();
    await restartAndUnlock();
    await assertEntry("linux-large");
    await add("android-large");
    await expectHost("linux-large", "android-large", "android-offline");
    verifyKeepassAttachment(database, path.join(attachmentRoot, "output.bin"));
    await expectProvider();
    console.log("KeePass: multi-block database round-trip and 4 MiB attachment verified.");
  } finally { fs.rmSync(attachmentRoot, { recursive: true, force: true }); }

  // Syncpeer is format-agnostic. Concurrent changes must be preserved rather
  // than silently overwritten; this is not a claim of an automatic KDBX merge.
  const commonDigest = hostDigest();
  const commonVersion = await hostIndexedVersion();
  try {
    await pausePeer(true);
    await add("android-conflict");
    await eventually("Android conflict branch published", () => providerDigest() !== commonDigest);
    const androidBranch = providerDigest();
    if (hostDigest() !== commonDigest) throw new Error("Peer changed before concurrent host edit.");
    addKeepassEntry(database, "linux-conflict");
    const linuxBranch = hostDigest();
    await scanPeerFolder();
    await eventually("host indexed its concurrent database edit", async () =>
      await hostIndexedVersion() !== commonVersion);
    await pausePeer(false);
    // A whole-folder favorite uses the version-vector replica, not the
    // single-file favorite state machine. Its conflict is a separate file.
    // Require the exact two independently saved byte streams on BOTH peers.
    const isDatabaseVersion = name => name === keepassFilename ||
      name.startsWith(keepassFilename + ".sync-conflict-") ||
      (name.startsWith(keepassFilename.replace(/\.kdbx$/, ".sync-conflict-")) && name.endsWith(".kdbx"));
    let observed = { host: [], android: [] };
    const inspect = async () => {
      const host = fs.readdirSync(peerHostFolder).filter(isDatabaseVersion)
        .map(name => ({ name, digest: hostDigest(path.join(peerHostFolder, name)) }));
      const android = (await listCachedFiles()).map(file => file.path).filter(isDatabaseVersion)
        .map(name => ({ name, digest: providerDigest(name) }));
      observed = { host, android };
      const both = entries => entries.some(file => file.digest === androidBranch) &&
        entries.some(file => file.digest === linuxBranch);
      return both(host) && both(android) && hostDigest() === providerDigest();
    };
    try {
      await eventually("both KDBX conflict versions converge byte-for-byte on both peers", inspect);
    } catch (error) {
      console.error("KeePass conflict diagnostic:", JSON.stringify({
        host: observed.host.map(file => ({ name: file.name, android: file.digest === androidBranch, linux: file.digest === linuxBranch })),
        android: observed.android.map(file => ({ name: file.name, android: file.digest === androidBranch, linux: file.digest === linuxBranch })),
      }));
      throw error;
    }
    for (const [digest, entry] of [[androidBranch, "android-conflict"], [linuxBranch, "linux-conflict"]]) {
      const copy = observed.host.find(file => file.digest === digest);
      const names = keepassEntries(path.join(peerHostFolder, copy.name));
      if (!names.includes(entry) || !names.includes("android-large") || !names.includes("linux-large")) {
        throw new Error("A preserved conflict database did not decrypt with the expected entries.");
      }
    }
    await restartAndUnlock();
    await assertEntry(hostDigest() === androidBranch ? "android-conflict" : "linux-conflict");
    console.log("KeePass: concurrent edits converged as separate valid KDBX copies on both peers.");
  } finally {
    await rest("/rest/config/devices/" + encodeURIComponent(peerDevice), {
      method: "PATCH", body: JSON.stringify({ paused: false }),
    });
  }
};
