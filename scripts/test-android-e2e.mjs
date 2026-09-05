import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";

const config = JSON.parse(
  fs.readFileSync("packages/tauri-shell/src-tauri/tauri.conf.json", "utf8"),
);
const packageName = process.env.SYNCPEER_ANDROID_PACKAGE?.trim() || config.identifier;
const transferServiceClass = process.env.SYNCPEER_ANDROID_TRANSFER_SERVICE?.trim()
  || "dev.syncpeer.plugin.android.SyncpeerTransferService";
const transferServiceComponent = `${packageName}/${transferServiceClass}`;
const transferJobServiceClass = process.env.SYNCPEER_ANDROID_TRANSFER_JOB_SERVICE?.trim()
  || "dev.syncpeer.plugin.android.SyncpeerTransferJobService";
const transferJobServiceComponent = `${packageName}/${transferJobServiceClass}`;
const transferJobId = Number(process.env.SYNCPEER_ANDROID_TRANSFER_JOB_ID || 22067);
const serverDeviceId = process.env.SYNCPEER_DEV_SERVER_DEVICE_ID?.trim()
  || (fs.existsSync(".tmp/syncpeer-dev-client/server-device-id")
    ? fs.readFileSync(".tmp/syncpeer-dev-client/server-device-id", "utf8").trim()
    : "");
const discoveryServer = process.env.SYNCPEER_LAN_DISCOVERY_SERVER?.trim() || "";
const connectionTimeoutMs = Number(process.env.SYNCPEER_LAN_TIMEOUT_MS || 120_000);
const downloadTimeoutMs = Number(process.env.SYNCPEER_ANDROID_DOWNLOAD_TIMEOUT_MS || 240_000);
const targetFolderId = process.env.SYNCPEER_E2E_FOLDER_ID?.trim() || "syncpeer-lan";
const targetFolderTitle = process.env.SYNCPEER_E2E_FOLDER_TITLE?.trim() || targetFolderId;
const targetFolderPassword = process.env.SYNCPEER_E2E_FOLDER_PASSWORD?.trim() || "";
const targetFileName = process.env.SYNCPEER_E2E_FILE_NAME?.trim() || "hello.txt";
const targetLargeFileName = process.env.SYNCPEER_E2E_LARGE_FILE_NAME?.trim() || "blob.bin";
const targetLargeFileSize = Number(
  process.env.SYNCPEER_E2E_LARGE_FILE_SIZE || 30 * 1024 * 1024,
);
const targetLargeFileSha256 = process.env.SYNCPEER_E2E_LARGE_FILE_SHA256?.trim() || "";

const runAdb = (args, timeout = 30_000) => {
  try {
    return execFileSync("adb", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`adb ${args.join(" ")} failed: ${message}`, { cause: error });
  }
};

const listDevices = () => runAdb(["devices"]).split("\n")
  .slice(1)
  .filter((line) => /^\S+\s+device(?:\s|$)/.test(line));

const androidSdkVersion = () => Number(
  runAdb(["shell", "getprop", "ro.build.version.sdk"]).trim(),
);

const wait = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const assertForeground = async () => {
  const deadline = Date.now() + 30_000;
  let lastFocus = "no focus record";
  while (Date.now() < deadline) {
    const activities = runAdb(["shell", "dumpsys", "activity", "activities"]);
    const focusLine = activities.split("\n").find((line) =>
      /mResumedActivity|mCurrentFocus|mFocusedApp/.test(line),
    );
    const appFocusLine = activities.split("\n").find((line) =>
      /mResumedActivity|mFocusedApp/.test(line),
    );
    lastFocus = focusLine ?? appFocusLine ?? lastFocus;
    if (focusLine?.includes(packageName) || appFocusLine?.includes(packageName)) return;
    await wait(250);
  }
  throw new Error(`Android app is not foregrounded: ${lastFocus}`);
};

const transferServiceDump = () => runAdb([
  "shell",
  "dumpsys",
  "activity",
  "services",
  packageName,
]);

const transferJobServiceRunning = () =>
  transferServiceDump().includes(transferJobServiceClass);

const transferJobState = () => {
  try {
    return runAdb([
      "shell",
      "cmd",
      "jobscheduler",
      "get-job-state",
      packageName,
      String(transferJobId),
    ]).trim();
  } catch {
    return "";
  }
};

const transferJobRunning = () =>
  ["pending", "active", "ready", "waiting"].some((state) => transferJobState().includes(state));

const waitForTransferJob = async (expected, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  let lastState = "unknown";
  while (Date.now() < deadline) {
    lastState = transferJobState() || "unknown";
    if (transferJobRunning() === expected) return lastState;
    await wait(250);
  }
  throw new Error(
    `UIDT job did not become ${expected ? "active or pending" : "stopped"}: ` +
    `job=${transferJobId}, state=${lastState}`,
  );
};

const stopTransferService = () => {
  try {
    runAdb([
      "shell",
      "run-as",
      packageName,
      "/system/bin/am",
      "stopservice",
      "--user",
      "0",
      "-n",
      transferServiceComponent,
    ]);
  } catch {
    // Cleanup is best-effort after a failed assertion.
  }
  try {
    runAdb([
      "shell",
      "cmd",
      "jobscheduler",
      "cancel",
      packageName,
      String(transferJobId),
    ]);
  } catch {
    // Cleanup is best-effort after a failed assertion.
  }
};

const waitForCdpPage = async (port = 9222) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((candidate) => candidate.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      // The WebView debug socket appears shortly after the process starts.
    }
    await wait(250);
  }
  throw new Error("Timed out waiting for the Android WebView debug page.");
};

const connectCdp = async () => {
  const port = Number(process.env.SYNCPEER_ANDROID_CDP_PORT || 9222);
  const pid = runAdb(["shell", "pidof", packageName]).trim().split(/\s+/)[0];
  if (!pid) throw new Error(`Could not find the Android process for ${packageName}.`);
  runAdb(["forward", `tcp:${port}`, `localabstract:webview_devtools_remote_${pid}`]);
  const page = await waitForCdpPage(port);
  const socket = new globalThis.WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  const rejectPending = (error) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const onMessage = (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", () => {
    rejectPending(new Error("Android WebView CDP connection failed."));
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not open Android WebView CDP.")), { once: true });
  });
  const command = (method, params = {}, timeout = 30_000) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Android WebView CDP command timed out: ${method}`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const client = {
    evaluate: async (expression, timeout = 30_000) => {
      let result;
      try {
        result = await command("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        }, timeout);
      } catch (error) {
        const preview = expression.replaceAll(/\s+/g, " ").slice(0, 160);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; expression=${preview}`,
          { cause: error },
        );
      }
      if (result?.exceptionDetails) {
        const exception = result.exceptionDetails.exception;
        throw new Error(
          exception?.description ||
          exception?.value ||
          result.exceptionDetails.text ||
          JSON.stringify(result.exceptionDetails),
        );
      }
      return result?.result?.value;
    },
    close: () => {
      rejectPending(new Error("Android WebView CDP client closed."));
      socket.close();
    },
  };
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const available = await client.evaluate(
        'typeof globalThis.__TAURI_INTERNALS__?.invoke === "function" || ' +
        'typeof globalThis.__TAURI__?.core?.invoke === "function"',
        5_000,
      );
      if (available) return client;
    } catch {
      // Tauri injects the bridge shortly after the WebView page appears.
    }
    await wait(250);
  }
  client.close();
  throw new Error("Timed out waiting for the Tauri invoke bridge in the Android WebView.");
};

const waitForUiCondition = async (cdp, expression, label, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(expression)) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for Android UI condition: ${label}`);
};

const waitForUiText = (cdp, text, timeout = 60_000) => waitForUiCondition(
  cdp,
  `document.body?.innerText?.includes(${JSON.stringify(text)}) === true`,
  `text ${JSON.stringify(text)}`,
  timeout,
);

const readUiDownloadState = async (cdp, name) => cdp.evaluate(`(() => {
  const text = document.body?.innerText || "";
  if (text.includes(${JSON.stringify(`Download cancelled: ${name}`)})) return "cancelled";
  if (text.includes(${JSON.stringify(`Download failed: ${name}`)})) return "failed";
  if (text.includes(${JSON.stringify(`Downloading ${name}`)})) return "active";
  if (text.includes(${JSON.stringify(`Downloaded ${name}`)})) return "done";
  return "pending";
})()`);

const waitForUiDownloadState = async (cdp, name, timeout = 60_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await readUiDownloadState(cdp, name);
    if (state === "failed") throw new Error(`Android UI download failed: ${name}`);
    if (state === "done" || state === "active") return state;
    await wait(250);
  }
  throw new Error(`Timed out waiting for Android UI download state: ${name}`);
};

const waitForUiDownloadDone = async (cdp, name, timeout = 90_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await readUiDownloadState(cdp, name);
    if (state === "failed") throw new Error(`Android UI download failed: ${name}`);
    if (state === "done") return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for Android UI download completion: ${name}`);
};

const clickUiTestId = async (cdp, testId) => {
  const clicked = await cdp.evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
  if (!(element instanceof HTMLElement)) return false;
  element.click();
  return true;
})()`);
  if (!clicked) throw new Error(`Android UI control not found: ${testId}`);
};

const setUiValue = async (cdp, testId, value) => {
  const updated = await cdp.evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(`[data-testid="${testId}"]`)});
  if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement)) return false;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
  setter?.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return element.value === ${JSON.stringify(value)};
})()`);
  if (!updated) throw new Error(`Android UI value could not be set: ${testId}`);
};

const clickUiItem = (cdp, title) => cdp.evaluate(`(() => {
  const item = [...document.querySelectorAll(".item-title")]
    .find((element) => element.textContent?.trim() === ${JSON.stringify(title)});
  const target = item?.closest(".item-main-hit-clickable");
  if (!(target instanceof HTMLElement)) return false;
  target.dispatchEvent(
    new MouseEvent("click", { bubbles: true, cancelable: true, view: window }),
  );
  return true;
})()`);

const clickUiDownload = (cdp, title) => cdp.evaluate(`(() => {
  const item = [...document.querySelectorAll(".item-title")]
    .find((element) => element.textContent?.trim() === ${JSON.stringify(title)});
  const button = item?.closest("li")?.querySelector("button[aria-label^='Download']");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);

const clickUiCancelDownload = (cdp, title) => cdp.evaluate(`(() => {
  const item = [...document.querySelectorAll(".item-title")]
    .find((element) => element.textContent?.trim() === ${JSON.stringify(title)});
  const button = item?.closest("li")?.querySelector("button[aria-label='Cancel download']");
  if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
  button.click();
  return true;
})()`);

const waitForUiDownloadButton = async (cdp, title, timeout = 30_000) => {
  await waitForUiCondition(
    cdp,
    `(() => {
      const item = [...document.querySelectorAll(".item-title")]
        .find((element) => element.textContent?.trim() === ${JSON.stringify(title)});
      const button = item?.closest("li")?.querySelector("button[aria-label^='Download']");
      return button instanceof HTMLButtonElement && !button.disabled;
    })()`,
    `enabled download button for ${title}`,
    timeout,
  );
};

const tauriInvoke = (cdp, command, args = undefined, timeout = 30_000) => cdp.evaluate(`(async () => {
  const tauri = globalThis.__TAURI__;
  const internals = globalThis.__TAURI_INTERNALS__;
  try {
    if (typeof tauri?.core?.invoke === "function") {
      return await tauri.core.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
    }
    if (typeof internals?.invoke === "function") {
      return await internals.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
    }
    throw new Error("Tauri invoke is unavailable in the Android WebView.");
  } catch (error) {
    const message = typeof error === "string"
      ? error
      : error?.message || JSON.stringify(error);
    throw new Error(message);
  }
})()`, timeout);

const notificationUiXml = () => {
  runAdb(["shell", "uiautomator", "dump", "/sdcard/syncpeer-notifications.xml"]);
  return runAdb(["shell", "cat", "/sdcard/syncpeer-notifications.xml"]);
};

const notificationBounds = (xml, text) => {
  const nodes = xml.match(/<node\b[^>]*>/g) ?? [];
  for (const node of nodes) {
    const textValue = node.match(/\btext="([^"]*)"/)?.[1];
    if (textValue !== text) continue;
    const bounds = node.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!bounds) continue;
    return {
      x: Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2),
      y: Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2),
    };
  }
  return null;
};

const notificationRowBounds = (xml, titles) => {
  const titleIndex = titles
    .map((title) => xml.indexOf(`text="${title}"`))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (titleIndex === undefined) return null;
  const rowPattern = /<node\b[^>]*resource-id="com\.android\.systemui:id\/expandableNotificationRow"[^>]*>/g;
  let row = null;
  for (const match of xml.matchAll(rowPattern)) {
    if ((match.index ?? 0) < titleIndex) row = match[0];
  }
  if (!row) return null;
  const bounds = row.match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) return null;
  const rowBounds = {
    left: Number(bounds[1]),
    top: Number(bounds[2]),
    right: Number(bounds[3]),
    bottom: Number(bounds[4]),
  };
  const expandPattern = /<node\b[^>]*resource-id="android:id\/expand_button"[^>]*>/g;
  for (const match of xml.matchAll(expandPattern)) {
    const expandBounds = match[0].match(/\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!expandBounds) continue;
    const x = Math.floor((Number(expandBounds[1]) + Number(expandBounds[3])) / 2);
    const y = Math.floor((Number(expandBounds[2]) + Number(expandBounds[4])) / 2);
    if (
      x >= rowBounds.left && x <= rowBounds.right &&
      y >= rowBounds.top && y <= rowBounds.bottom
    ) {
      return { x, y };
    }
  }
  return {
    x: Math.floor((rowBounds.left + rowBounds.right) / 2),
    y: Math.floor((rowBounds.top + rowBounds.bottom) / 2),
  };
};

const waitForNotificationBounds = async (text, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  runAdb(["shell", "cmd", "statusbar", "expand-notifications"]);
  let expanded = false;
  while (Date.now() < deadline) {
    const xml = notificationUiXml();
    const bounds = notificationBounds(xml, text);
    if (bounds) return bounds;
    if (!expanded) {
      const notificationRow = notificationRowBounds(xml, [
        "Syncpeer download",
        "Syncpeer transfer",
        "Syncpeer transfers",
      ]);
      if (notificationRow) {
        runAdb(["shell", "input", "tap", String(notificationRow.x), String(notificationRow.y)]);
        expanded = true;
      }
    }
    await wait(250);
  }
  throw new Error(`Android notification was not visible: ${text}`);
};

const tapNotification = async (text) => {
  try {
    const bounds = await waitForNotificationBounds(text);
    runAdb(["shell", "input", "tap", String(bounds.x), String(bounds.y)]);
    await wait(1_000);
    await assertForeground();
  } finally {
    runAdb(["shell", "cmd", "statusbar", "collapse"]);
  }
};

const appNotificationRecords = () => {
  const dump = runAdb(["shell", "dumpsys", "notification", "--noredact"]);
  const records = dump.split(/\n(?=\s{4}NotificationRecord\()/)
    .filter((record) => record.includes(`pkg=${packageName}`));
  return {
    dump,
    records,
    transferRecords: records.filter((record) =>
      /\bid=(11001|11002|22067)\b/.test(record) || record.includes("channel=syncpeer-transfers"),
    ),
  };
};

const clearTransferNotifications = async (cdp) => {
  stopTransferService();
  try {
    await tauriInvoke(cdp, "plugin:notification|remove_active", {
      notifications: [{ id: 11001 }, { id: 11002 }, { id: 22067 }],
    });
  } catch {
    // Older builds may not expose the notification plugin command to CDP.
  }
  await wait(500);
};

const waitForActiveTransferNotification = async (timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  let latest = { dump: "", records: [], transferRecords: [] };
  while (Date.now() < deadline) {
    latest = appNotificationRecords();
    if (
      latest.transferRecords.length === 1 &&
      /\b\d{1,3}%/.test(latest.transferRecords[0])
    ) {
      return latest;
    }
    await wait(250);
  }
  const summary = latest.transferRecords
    .map((record) => record.split("\n")[0])
    .join(" | ");
  throw new Error(
    `Expected one active Android transfer notification with a percentage, found ` +
    `${latest.transferRecords.length}: ${summary}`,
  );
};

const waitForTransferNotificationText = async (texts, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  let latest = { transferRecords: [] };
  while (Date.now() < deadline) {
    latest = appNotificationRecords();
    if (
      latest.transferRecords.length === 1 &&
      texts.every((text) => latest.transferRecords[0].includes(text))
    ) {
      return latest.transferRecords[0];
    }
    await wait(250);
  }
  throw new Error(
    `Expected one transfer notification containing ${texts.join(", ")}; ` +
    `found ${latest.transferRecords.length}.`,
  );
};

const waitForNoTransferNotification = async (timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (appNotificationRecords().transferRecords.length === 0) return;
    await wait(250);
  }
  throw new Error("Android transfer notification remained visible after cancellation.");
};

const runAndroidDownloadNotificationRegression = async () => {
  let cdp = await launchAndroidApp(true);
  try {
    if (!await openAndroidConnection(cdp)) {
      throw new Error("Download notification test could not connect to the remote test server.");
    }
    await clearTransferNotifications(cdp);
    await startAndroidBlobDownload(cdp, false);
    await waitForTransferJob(true, 15_000);
    const notificationState = await waitForActiveTransferNotification(
      Math.min(downloadTimeoutMs, 60_000),
    );
    const channelStart = notificationState.dump.indexOf("NotificationChannel{mId='syncpeer-transfers");
    const channelEnd = notificationState.dump.indexOf("}", channelStart);
    const channel = notificationState.dump.slice(channelStart, channelEnd + 1);
    if (!channel.includes("mVibrationEnabled=false")) {
      throw new Error("Android transfer notification channel still enables vibration.");
    }

    runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await wait(500);
    const cancelBounds = await waitForNotificationBounds("Cancel");
    runAdb(["shell", "input", "tap", String(cancelBounds.x), String(cancelBounds.y)]);
    await assertForeground();
    await waitForTransferRuntime(false, downloadTimeoutMs);
    await waitForNoTransferNotification();
    const cancelledSummary = await cachedFileSummary(cdp, targetLargeFileName);
    if (cancelledSummary.found) {
      throw new Error(`Notification cancellation left a cached blob: ${JSON.stringify(cancelledSummary)}`);
    }
  } finally {
    cdp.close();
    stopTransferService();
  }

  // Keep notification cancellation and in-app cancellation independent. The
  // notification action can resume an existing WebView whose rejected
  // download promise is still unwinding after the native transfer has stopped.
  cdp = await launchAndroidApp(true);
  try {
    if (!await openAndroidConnection(cdp)) {
      throw new Error("In-app download cancellation test could not connect to the remote test server.");
    }
    await clearTransferNotifications(cdp);
    await startAndroidBlobDownload(cdp, false);
    if (!await clickUiCancelDownload(cdp, targetLargeFileName)) {
      throw new Error("Android UI did not expose a cancel control for the active download.");
    }
    await waitForUiCondition(
      cdp,
      `(() => {
        const text = document.body?.innerText || "";
        return text.includes(${JSON.stringify(`Download cancelled: ${targetLargeFileName}`)});
      })()`,
      "cancelled Android UI download",
      30_000,
    );
    await waitForTransferRuntime(false, downloadTimeoutMs);
    await waitForNoTransferNotification();
    const cancelledSummary = await cachedFileSummary(cdp, targetLargeFileName);
    if (cancelledSummary.found) {
      throw new Error(`In-app cancellation left a cached blob: ${JSON.stringify(cancelledSummary)}`);
    }
    console.log("Android download notification and cancellation regression passed.");
  } finally {
    cdp.close();
    stopTransferService();
  }
};

const runUserInitiatedTransferLifecycle = async (cdp) => {
  await tauriInvoke(cdp, "syncpeer_android_start_transfer_service", {
    request: { label: "Android UIDT E2E transfer" },
  });
  const scheduledState = await waitForTransferJob(true, 15_000);
  await tauriInvoke(cdp, "syncpeer_android_update_transfer_notification", {
    request: {
      title: "Syncpeer download",
      body: "fixture.bin: 37%",
      progress: 37,
      ongoing: true,
      cancellable: true,
    },
  });
  await waitForTransferNotificationText(["Syncpeer download", "fixture.bin: 37%"]);
  await tauriInvoke(cdp, "syncpeer_android_update_transfer_notification", {
    request: {
      title: "Syncpeer transfers",
      body: "2 active · 1 download · 1 upload",
      progress: 25,
      ongoing: true,
      cancellable: true,
    },
  });
  await waitForTransferNotificationText(["Syncpeer transfers", "2 active"]);
  runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await wait(1_000);
  const backgroundState = await waitForTransferJob(true, 15_000);
  if (!transferJobServiceRunning()) {
    throw new Error(`UIDT JobService is not running: ${transferJobServiceComponent}`);
  }
  const notificationDump = runAdb(["shell", "dumpsys", "notification", "--noredact"]);
  if (!notificationDump.includes("syncpeer-transfers")) {
    throw new Error("UIDT transfer notification channel was not created.");
  }
  console.log(
    `Android UIDT job stayed active in background; ` +
    `service=${transferJobServiceComponent}, ` +
    `states=${scheduledState}/${backgroundState}, notification channel present: true`,
  );

  await tapNotification("Syncpeer transfers");
  console.log("Android UIDT notification tap returned to the app.");

  await tauriInvoke(cdp, "syncpeer_android_stop_transfer_service");
  await waitForTransferJob(false);
  await tauriInvoke(cdp, "syncpeer_android_update_transfer_notification", {
    request: {
      title: "Syncpeer transfers complete",
      body: "2 transfers completed",
      progress: 100,
      ongoing: false,
      cancellable: false,
    },
  });
  await waitForTransferNotificationText(["Syncpeer transfers complete", "2 transfers completed"]);
  await clearTransferNotifications(cdp);
};

const packagePid = () => {
  try {
    return runAdb(["shell", "pidof", packageName]).trim();
  } catch {
    return "";
  }
};

const waitForPackageStopped = async (timeout = 10_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!packagePid()) return;
    await wait(250);
  }
  throw new Error(`Android package did not stop after force-stop: ${packageName}`);
};

const launchAndroidApp = async (forceStop = false) => {
  if (forceStop) runAdb(["shell", "am", "force-stop", packageName]);
  runAdb(["shell", "monkey", "-p", packageName, "1"]);
  await wait(1_000);
  await assertForeground();
  return connectCdp();
};

const grantNotificationPermission = () => {
  if (androidSdkVersion() < 33) return;
  runAdb(["shell", "pm", "grant", packageName, "android.permission.POST_NOTIFICATIONS"]);
};

const setAirplaneMode = (enabled) => {
  runAdb(["shell", "cmd", "connectivity", "airplane-mode", enabled ? "enable" : "disable"]);
};

const setDeviceIdle = (enabled) => {
  runAdb(["shell", "cmd", "deviceidle", enabled ? "force-idle" : "unforce", ...(enabled ? ["deep"] : [])]);
};

const supportsDeviceIdleControl = () => {
  try {
    setDeviceIdle(true);
    setDeviceIdle(false);
    return true;
  } catch {
    try {
      setDeviceIdle(false);
    } catch {
      // Cleanup is best-effort after an unsupported capability probe.
    }
    return false;
  }
};

const cachedFileSummary = async (cdp, relativePath) => {
  const records = await tauriInvoke(cdp, "syncpeer_list_cached_files", undefined, 60_000);
  const record = records.find((candidate) => candidate.path === relativePath);
  if (!record) return { found: false };
  if (!record.localPath) return { found: true, size: record.sizeBytes, sha256: null };
  const values = await tauriInvoke(cdp, "syncpeer_read_binary_file", {
    request: { path: record.localPath },
  }, 60_000);
  const bytes = Buffer.from(values);
  return {
    found: true,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

const fixtureBlobHash = () => {
  const hash = createHash("sha256");
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < targetLargeFileSize; offset += chunkSize) {
    const chunk = Buffer.alloc(Math.min(chunkSize, targetLargeFileSize - offset));
    for (let index = 0; index < chunk.length; index += 1) chunk[index] = (offset + index) % 251;
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const setAndroidAutomaticConnectionPaused = async (cdp, paused) => {
  await clickUiTestId(cdp, "tab-devices");
  const settingsExpanded = await cdp.evaluate(
    'document.querySelector("[data-testid=connection-settings-toggle]")?.getAttribute("aria-expanded") === "true"',
  );
  if (!settingsExpanded) await clickUiTestId(cdp, "connection-settings-toggle");
  const expertEnabled = await cdp.evaluate(
    'document.querySelector("[data-testid=expert-view]")?.checked === true',
  );
  if (!expertEnabled) await clickUiTestId(cdp, "expert-view");
  const detailsExpanded = await cdp.evaluate(
    'document.querySelector("[data-testid=connection-status-toggle]")?.getAttribute("aria-expanded") === "true"',
  );
  if (!detailsExpanded) await clickUiTestId(cdp, "connection-status-toggle");
  const label = await cdp.evaluate(
    'document.querySelector("[data-testid=expert-connection-control]")?.textContent?.trim() || ""',
  );
  if (paused && label === "Pause automatic connection") {
    await clickUiTestId(cdp, "expert-connection-control");
  }
  if (!paused && label === "Resume automatic connection") {
    await clickUiTestId(cdp, "expert-connection-control");
  }
};

const openAndroidConnection = async (cdp) => {
  if (!serverDeviceId) {
    console.log("Android network UI workflow skipped: no server device ID configured.");
    return false;
  }
  const localDeviceId = await tauriInvoke(cdp, "syncpeer_get_default_device_id");
  console.log(`Android E2E client device ID: ${localDeviceId}`);
  await waitForUiCondition(
    cdp,
    'document.querySelector("[data-testid=tab-devices]") !== null',
    "device tab",
    30_000,
  );
  await clickUiTestId(cdp, "tab-devices");
  const settingsVisible = await cdp.evaluate(
    "document.querySelector('[data-testid=\"connection-discovery-mode\"]') !== null",
  );
  if (!settingsVisible) {
    await clickUiTestId(cdp, "connection-settings-toggle");
    await waitForUiText(cdp, "Remote Device ID", 10_000);
  }
  const initiallyConnected = await cdp.evaluate(
    'document.querySelector("[data-testid=connection-status]")?.textContent?.trim() === "Connected"',
  );
  if (initiallyConnected) {
    await setAndroidAutomaticConnectionPaused(cdp, true);
    await waitForUiCondition(
      cdp,
      'document.querySelector("[data-testid=connection-status]")?.textContent?.trim() !== "Connected"',
      "disconnecting stale Android session",
      30_000,
    );
  }
  await setUiValue(cdp, "connection-saved-device", "");
  await setUiValue(cdp, "connection-discovery-mode", "global");
  await setUiValue(cdp, "connection-remote-id", serverDeviceId);
  await setUiValue(cdp, "connection-timeout", String(connectionTimeoutMs));
  if (discoveryServer) {
    await setUiValue(cdp, "connection-discovery-server", discoveryServer);
  }
  await waitForUiCondition(
    cdp,
    `document.querySelector("[data-testid=connection-remote-id]")?.value === ${JSON.stringify(serverDeviceId)}`,
    "persisting Android server device ID",
    5_000,
  );
  await setAndroidAutomaticConnectionPaused(cdp, false);
  const deadline = Date.now() + 10 * 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`(() => {
      return {
        label: document.querySelector("[data-testid=connection-status]")?.textContent?.trim() || "",
        error: document.querySelector("p.error")?.textContent?.trim() || "",
      };
    })()`);
    if (state?.label === "Connected") return true;
    if (state?.error) lastError = state.error;
    await wait(10_000);
  }
  throw new Error(
    `Timed out waiting for Android UI connection approval.${lastError ? ` Last error: ${lastError}` : ""}`,
  );
};

const openAndroidFolder = async (cdp, clearCache = false) => {
  if (clearCache) {
    await clickUiTestId(cdp, "tab-devices");
    const settingsExpanded = await cdp.evaluate(
      'document.querySelector("[data-testid=connection-settings-toggle]")?.getAttribute("aria-expanded") === "true"',
    );
    if (!settingsExpanded) await clickUiTestId(cdp, "connection-settings-toggle");
    await clickUiTestId(cdp, "clear-cache-button");
    await waitForUiCondition(
      cdp,
      'document.querySelector("[data-testid=clear-cache-button]")?.textContent?.includes("Clear Cache") === true',
      "cleared Android cache",
      30_000,
    );
  }
  await clickUiTestId(cdp, "tab-folders");
  const returnedToRoot = await cdp.evaluate(`(() => {
    const root = [...document.querySelectorAll(".crumb-button")]
      .find((element) => element.textContent?.trim() === "All Syncthing Folders");
    if (!(root instanceof HTMLElement)) return false;
    root.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: window,
    }));
    return true;
  })()`);
  if (returnedToRoot) {
    await waitForUiCondition(
      cdp,
      `(() => {
        if (document.querySelector(".crumb-current")?.textContent?.trim() === "All Syncthing Folders") {
          return true;
        }
        const root = [...document.querySelectorAll(".crumb-button")]
          .find((element) => element.textContent?.trim() === "All Syncthing Folders");
        root?.dispatchEvent(new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
        return false;
      })()`,
      "folder root view",
      30_000,
    );
  }
  await waitForUiText(cdp, targetFolderTitle, 90_000);
  if (targetFolderPassword) {
    const passwordInput = `folder-password-${targetFolderId}`;
    const editButton = `edit-folder-password-${targetFolderId}`;
    const inputVisible = await cdp.evaluate(
      `document.querySelector(${JSON.stringify(`[data-testid="${passwordInput}"]`)}) !== null`,
    );
    const editVisible = await cdp.evaluate(
      `document.querySelector(${JSON.stringify(`[data-testid="${editButton}"]`)}) !== null`,
    );
    if (!inputVisible && editVisible) {
      await clickUiTestId(cdp, editButton);
      await waitForUiCondition(
        cdp,
        `document.querySelector(${JSON.stringify(`[data-testid="${passwordInput}"]`)}) !== null`,
        "encrypted folder password input",
        5_000,
      );
    }
    if (inputVisible || editVisible) {
      await setUiValue(cdp, passwordInput, targetFolderPassword);
      await clickUiTestId(cdp, `unlock-folder-${targetFolderId}`);
    }
  }
  if (!await clickUiItem(cdp, targetFolderTitle)) {
    throw new Error(`Android UI could not open the ${targetFolderTitle} folder.`);
  }
};

const startAndroidFileDownload = async (cdp, name) => {
  await waitForUiText(cdp, name, 90_000);
  await waitForUiDownloadButton(cdp, name);
  if (!await clickUiDownload(cdp, name)) {
    throw new Error(`Android UI could not start the ${name} download.`);
  }
  const state = await waitForUiDownloadState(
    cdp,
    name,
    name === targetLargeFileName ? 30_000 : 90_000,
  );
  if (name !== targetLargeFileName) {
    await waitForUiDownloadDone(cdp, name);
    return "done";
  }
  return state;
};

const startAndroidBlobDownload = async (cdp, verifyHello = true) => {
  await openAndroidFolder(cdp, true);
  if (verifyHello) {
    const helloState = await startAndroidFileDownload(cdp, targetFileName);
    if (helloState !== "done") {
      throw new Error(`Android UI ${targetFileName} download did not finish: ${helloState}`);
    }
  }
  const blobState = await startAndroidFileDownload(cdp, targetLargeFileName);
  console.log(`Android UI started ${targetLargeFileName} download (${blobState}).`);
  return blobState;
};

const assertCompleteBlob = async (cdp, context) => {
  const summary = await cachedFileSummary(cdp, targetLargeFileName);
  if (!summary?.found || summary.size !== targetLargeFileSize) {
    throw new Error(`${context} did not produce the full blob: ${JSON.stringify(summary)}`);
  }
  const expectedHash = targetLargeFileSha256 || fixtureBlobHash();
  if (summary.sha256 && summary.sha256 !== expectedHash) {
    throw new Error(`${context} blob hash mismatch: expected ${expectedHash}, got ${summary.sha256}`);
  }
  return summary;
};

const disconnectAndroidSession = async (cdp) => {
  const connected = await cdp.evaluate(
    'document.querySelector("[data-testid=connection-status]")?.textContent?.trim() === "Connected"',
  );
  if (!connected) return;
  await setAndroidAutomaticConnectionPaused(cdp, true);
  await waitForUiCondition(
    cdp,
    'document.querySelector("[data-testid=connection-status]")?.textContent?.trim() !== "Connected"',
    "graceful Android test disconnect",
    30_000,
  );
};

const readBlobAfterRelaunch = async (cdp, context) => {
  runAdb(["shell", "monkey", "-p", packageName, "1"]);
  await assertForeground();
  cdp.close();
  const foregroundCdp = await connectCdp();
  try {
    return await assertCompleteBlob(foregroundCdp, context);
  } finally {
    await disconnectAndroidSession(foregroundCdp);
    foregroundCdp.close();
  }
};

const runAndroidBackgroundDownload = async (cdp) => {
  const blobState = await startAndroidBlobDownload(cdp);
  if (blobState !== "active") {
    throw new Error(`Android background download was not active before backgrounding: ${blobState}`);
  }
  const startedAtMs = Date.now();
  runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await wait(2_000);
  await waitForTransferRuntime(true, 15_000);
  await waitForTransferRuntime(false, downloadTimeoutMs);
  const summary = await readBlobAfterRelaunch(cdp, "Android background download");
  const elapsedMs = Math.max(1, Date.now() - startedAtMs);
  const mibPerSecond = summary.size / 1024 / 1024 / (elapsedMs / 1000);
  console.log(
    `Android background download passed: ${summary.size} bytes in ${elapsedMs} ms ` +
    `(${mibPerSecond.toFixed(2)} MiB/s)` +
    `${summary.sha256 ? `, sha256=${summary.sha256}` : ""}`,
  );
};

const transferRuntimeRunning = () => transferJobRunning();

const waitForTransferRuntime = async (expected, timeout = 5_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (transferRuntimeRunning() === expected) return;
    await wait(250);
  }
  throw new Error(
    `Android transfer runtime did not become ${expected ? "active" : "stopped"}.`,
  );
};

const completeFreshBlobDownload = async (context) => {
  let cdp = await launchAndroidApp(true);
  try {
    if (!await openAndroidConnection(cdp)) {
      throw new Error(`${context} could not connect to the remote test server.`);
    }
    const state = await startAndroidBlobDownload(cdp, false);
    if (state === "active") {
      runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
      await waitForTransferRuntime(false, downloadTimeoutMs);
    }
    const summary = await readBlobAfterRelaunch(cdp, context);
    console.log(
      `${context} passed: ${summary.size} bytes${summary.sha256 ? `, sha256=${summary.sha256}` : ""}`,
    );
  } finally {
    cdp.close();
    stopTransferService();
  }
};

const runAndroidForceStopScenario = async () => {
  let cdp = await launchAndroidApp();
  try {
    if (!await openAndroidConnection(cdp)) return;
    const state = await startAndroidBlobDownload(cdp, false);
    if (state !== "active") {
      throw new Error(`Force-stop test download was not active: ${state}`);
    }
    await waitForTransferJob(true, 15_000);
    runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await wait(500);
    runAdb(["shell", "am", "force-stop", packageName]);
    await waitForPackageStopped();
    await waitForTransferJob(false, 10_000);
  } finally {
    cdp.close();
    stopTransferService();
  }

  cdp = await launchAndroidApp();
  try {
    const summary = await cachedFileSummary(cdp, targetLargeFileName);
    if (summary.found) {
      throw new Error(`Force-stop left a committed partial blob: ${JSON.stringify(summary)}`);
    }
    if (!await openAndroidConnection(cdp)) {
      throw new Error("Force-stop recovery could not reconnect to the remote test server.");
    }
    await openAndroidFolder(cdp, true);
    const retryState = await startAndroidFileDownload(cdp, targetFileName);
    if (retryState !== "done") {
      throw new Error(`Force-stop recovery download did not finish: ${retryState}`);
    }
    console.log("Android force-stop interrupted the transfer without committing it; retry passed.");
  } finally {
    cdp.close();
    stopTransferService();
  }
};

const runAndroidNetworkLossScenario = async () => {
  let cdp = await launchAndroidApp();
  let airplaneMode = false;
  let completed = false;
  try {
    if (!await openAndroidConnection(cdp)) return;
    const state = await startAndroidBlobDownload(cdp, false);
    if (state !== "active") {
      throw new Error(`Network-loss test download was not active: ${state}`);
    }
    await waitForTransferJob(true, 15_000);
    runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await wait(500);
    setAirplaneMode(true);
    airplaneMode = true;
    await wait(5_000);
    const interruptedSummary = await cachedFileSummary(cdp, targetLargeFileName);
    if (interruptedSummary.found && interruptedSummary.size === targetLargeFileSize) {
      throw new Error("Network-loss test completed before the network was disabled.");
    }
    setAirplaneMode(false);
    airplaneMode = false;
    await waitForTransferRuntime(false, downloadTimeoutMs);
    const summary = await cachedFileSummary(cdp, targetLargeFileName);
    if (summary.found && summary.size === targetLargeFileSize) {
      const verified = await assertCompleteBlob(cdp, "Android network-loss recovery");
      console.log(
        `Android network-loss recovery passed without retry: ${verified.size} bytes${verified.sha256 ? `, sha256=${verified.sha256}` : ""}`,
      );
      completed = true;
    } else {
      console.log("Android network loss stopped the in-flight transfer cleanly; validating a fresh retry.");
    }
  } finally {
    if (airplaneMode) {
      try {
        setAirplaneMode(false);
      } catch {
        // Cleanup is best-effort after a failed network assertion.
      }
    }
    cdp.close();
    stopTransferService();
  }
  if (!completed) await completeFreshBlobDownload("Android network-loss retry");
};

const runAndroidDozeScenario = async () => {
  let cdp = await launchAndroidApp();
  let deviceIdle = false;
  let completed = false;
  let processAliveDuringDoze;
  try {
    if (!supportsDeviceIdleControl()) {
      console.log("Android doze test skipped: emulator does not expose deviceidle force-idle.");
      return;
    }
    if (!await openAndroidConnection(cdp)) return;
    const state = await startAndroidBlobDownload(cdp, false);
    if (state !== "active") {
      throw new Error(`Doze test download was not active: ${state}`);
    }
    await waitForTransferJob(true, 15_000);
    runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
    await wait(500);
    setDeviceIdle(true);
    deviceIdle = true;
    await wait(5_000);
    processAliveDuringDoze = Boolean(packagePid());
    const idleState = transferJobState() || "unknown";
    setDeviceIdle(false);
    deviceIdle = false;
    cdp.close();
    await wait(1_000);
    cdp = await launchAndroidApp();
    const summary = await cachedFileSummary(cdp, targetLargeFileName);
    if (summary.found && summary.size !== targetLargeFileSize) {
      throw new Error(`Android doze produced an invalid committed blob: ${JSON.stringify(summary)}`);
    }
    await tauriInvoke(cdp, "syncpeer_android_stop_transfer_service");
    await waitForTransferRuntime(false, 10_000);
    await disconnectAndroidSession(cdp);
    if (summary.found && summary.size === targetLargeFileSize) {
      const verified = await assertCompleteBlob(cdp, "Android doze transfer");
      console.log(
        `Android doze transfer passed with job state ${idleState}; ` +
        `processAlive=${processAliveDuringDoze}: ${verified.size} bytes` +
        `${verified.sha256 ? `, sha256=${verified.sha256}` : ""}`,
      );
      completed = true;
    } else {
      console.log(
        `Android doze paused/stopped the in-flight transfer (job state ${idleState}, ` +
        `processAlive=${processAliveDuringDoze}); validating a fresh retry.`,
      );
    }
  } finally {
    if (deviceIdle) {
      try {
        setDeviceIdle(false);
      } catch {
        // Cleanup is best-effort after a failed doze assertion.
      }
    }
    cdp.close();
    stopTransferService();
  }
  if (!completed) await completeFreshBlobDownload("Android doze retry");
};

const runOptionalAndroidNetworkWorkflow = async () => {
  if (!serverDeviceId) {
    console.log("Android network UI workflow skipped: set SYNCPEER_DEV_SERVER_DEVICE_ID or save server-device-id.");
    return;
  }
  let cdp = await connectCdp();
  try {
    if (await openAndroidConnection(cdp)) await runAndroidBackgroundDownload(cdp);
  } finally {
    cdp.close();
    stopTransferService();
  }
  await runAndroidDownloadNotificationRegression();
  await runAndroidForceStopScenario();
  await runAndroidNetworkLossScenario();
  await runAndroidDozeScenario();
};

const main = async () => {
  runAdb(["wait-for-device"], 60_000);

  const devices = listDevices();
  if (devices.length !== 1) {
    throw new Error(`Expected exactly one adb device, found ${devices.length}`);
  }

  const installedPath = runAdb(["shell", "pm", "path", packageName]).trim();
  if (!installedPath) {
    throw new Error(
      `Android package ${packageName} is not installed; build and install the debug APK first.`,
    );
  }

  if (androidSdkVersion() < 34) {
    console.log("Android E2E skipped: Android 14 (API 34) or newer is required.");
    return;
  }
  grantNotificationPermission();

  if (process.env.SYNCPEER_ANDROID_NETWORK_ONLY === "1") {
    runAdb(["shell", "am", "force-stop", packageName]);
    runAdb(["shell", "monkey", "-p", packageName, "1"]);
    await wait(1_000);
    await assertForeground();
    await runOptionalAndroidNetworkWorkflow();
    console.log(`Android network E2E passed for ${packageName}.`);
    return;
  }

  runAdb(["shell", "am", "force-stop", packageName]);
  runAdb(["shell", "monkey", "-p", packageName, "1"]);
  await wait(1_000);
  await assertForeground();

  runAdb(["shell", "input", "keyevent", "KEYCODE_HOME"]);
  await wait(300);
  runAdb(["shell", "monkey", "-p", packageName, "1"]);
  await wait(1_000);
  await assertForeground();

  const lifecycleCdp = await connectCdp();
  try {
    await runUserInitiatedTransferLifecycle(lifecycleCdp);
  } finally {
    lifecycleCdp.close();
    stopTransferService();
  }

  if (process.env.SYNCPEER_ANDROID_NOTIFICATION_ONLY === "1") {
    await runAndroidDownloadNotificationRegression();
    console.log(`Android download notification regression passed for ${packageName}.`);
    return;
  }

  runAdb(["shell", "am", "force-stop", packageName]);
  runAdb(["shell", "monkey", "-p", packageName, "1"]);
  await wait(1_000);
  await assertForeground();
  await runOptionalAndroidNetworkWorkflow();

  console.log(`Android E2E smoke and background-transfer lifecycle passed for ${packageName}.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
