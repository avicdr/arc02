/**
 * Universal Clipboard – Electron Client
 * FINAL + IMAGE PARITY WITH HOST
 */

const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Notification,
  nativeImage,
  dialog,
} = require("electron");

const path = require("path");
const fs = require("fs");
const WebSocket = require("ws");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

/* ================= ELEVATION (Windows only) ================= */
// If we're not already running as Administrator, relaunch via UAC.
// Admin privilege lets us sit above Medium-integrity lockdown browsers.
if (process.platform === "win32") {
  const { execSync } = require("child_process");
  let isAdmin = false;
  try {
    execSync("net session", { stdio: "ignore" });
    isAdmin = true;
  } catch (_) {
    isAdmin = false;
  }

  if (!isAdmin) {
    // Relaunch self with UAC elevation prompt
    const exePath = process.execPath;
    const args = process.argv.slice(1);
    const psCmd = `Start-Process -FilePath '${exePath.replace(/'/g, "''")}' -ArgumentList '${args.map(a => a.replace(/'/g, "''")).join("','")}'  -Verb RunAs`;
    try {
      execFile("powershell.exe", ["-NoProfile", "-Command", psCmd]);
    } catch (_) {
      // User denied UAC — continue without elevation
    }
    app.quit();
  }
}

/* ================= CONFIG ================= */

const WS_SERVER = "wss://backend-unv.onrender.com";
const HISTORY_LIMIT = 20;

const DEVICE_ID = crypto.randomUUID();
const PLATFORM = process.platform;
const DEVICE_NAME =
  PLATFORM === "darwin" ? "Mac" : PLATFORM === "win32" ? "Windows" : PLATFORM;

/* ================= STATE ================= */

let mainWindow;
let notifWindow;
let ws;

let paired = false;
let userId = null;
let awaitingPairing = false;

let isRemoteWrite = false;
let lastHash = "";
let lastTimestamp = 0;

let offlineQueue = [];
let history = [];

/* ================= CRYPTO ================= */

let MASTER_KEY = null;

function deriveKey(uid) {
  return crypto.createHash("sha256").update(uid).digest();
}

function encrypt(buffer) {
  if (!MASTER_KEY || !buffer) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);

  return {
    iv: iv.toString("base64"),
    data: enc.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(payload) {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      MASTER_KEY,
      Buffer.from(payload.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

/* ================= HELPERS ================= */

function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function addToHistory(entry) {
  history.unshift(entry);
  history = history.slice(0, HISTORY_LIMIT);
  send("clipboard-history", history);
}

/* ================= WINDOW ================= */

function assertOnTop() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    mainWindow.moveTop();
  }
}

// Spawn a PowerShell loop that calls Win32 SetWindowPos(HWND_TOPMOST) directly
// on our native HWND. This operates below Electron's JS layer and survives
// most kiosk software window-order resets.
let _nativeTopInterval = null;
function startNativeTopmost(hwnd) {
  if (process.platform !== "win32" || !hwnd) return;

  // HWND_TOPMOST = -1, SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE = 0x13
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
$hwnd = [IntPtr]${hwnd}
$HWND_TOPMOST = [IntPtr](-1)
$SWP_FLAGS = 0x0013
while ($true) {
  [WinAPI]::SetWindowPos($hwnd, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_FLAGS) | Out-Null
  Start-Sleep -Milliseconds 250
}
`;

  const child = spawn("powershell.exe", [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-Command", ps,
  ], { detached: false, stdio: "ignore" });

  child.unref();

  // Kill the PS loop when the app exits
  app.on("before-quit", () => { try { child.kill(); } catch (_) { } });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    alwaysOnTop: true,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Highest Electron-level z-order
  mainWindow.setAlwaysOnTop(true, "screen-saver", 1);

  // Re-assert on every blur/hide
  mainWindow.on("blur", assertOnTop);
  mainWindow.on("hide", assertOnTop);
  mainWindow.on("focus", assertOnTop);

  // JS-level safety net every 500 ms
  setInterval(assertOnTop, 500);

  // Start native Win32 SetWindowPos loop once we have the real HWND.
  // HWNDs are 32-bit values even on 64-bit Windows, so readUInt32LE is always correct.
  let _nativeStarted = false;
  function kickNativeTopmost() {
    if (_nativeStarted || mainWindow.isDestroyed()) return;
    _nativeStarted = true;
    const hwndBuf = mainWindow.getNativeWindowHandle();
    const hwnd = hwndBuf.readUInt32LE(0).toString();
    startNativeTopmost(hwnd);
  }
  mainWindow.once("show", kickNativeTopmost);
  mainWindow.webContents.once("did-finish-load", kickNativeTopmost); // fallback

  // Hide main window from screen capture (WDA_EXCLUDEFROMCAPTURE)
  mainWindow.setContentProtection(true);

  mainWindow.loadFile("index.html");
}

/* ================= NOTIFICATION WINDOW ================= */

function createNotifWindow() {
  const { screen } = require("electron");
  const { width: sw } = screen.getPrimaryDisplay().workAreaSize;

  const WIN_W = 420;
  const WIN_H = 80;

  notifWindow = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.round((sw - WIN_W) / 2),
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "notification-preload.js"),
      contextIsolation: true,
    },
  });

  // Highest z-order layer — screen-saver level
  notifWindow.setAlwaysOnTop(true, "screen-saver", 2);

  // Hide from screen recording (SecureView / WDA_EXCLUDEFROMCAPTURE)
  notifWindow.setContentProtection(true);

  notifWindow.loadFile("notification.html");

  // Show (but not focused) and start native topmost loop after load
  notifWindow.webContents.once("did-finish-load", () => {
    notifWindow.showInactive();
    // Make the window fully click-through so it never blocks mouse input
    notifWindow.setIgnoreMouseEvents(true, { forward: true });

    if (process.platform === "win32") {
      const hwndBuf = notifWindow.getNativeWindowHandle();
      const hwnd = hwndBuf.readUInt32LE(0).toString();
      startNativeTopmost(hwnd);
    }
  });
}

function showNotification(data) {
  if (!notifWindow || notifWindow.isDestroyed()) return;
  notifWindow.webContents.send("notif-show", data);
}

/* ================= WEBSOCKET ================= */

let _wsRetryDelay = 3000; // starts at 3s, doubles up to 30s

function connectWebSocket() {
  send("status-update", "Connecting…");
  ws = new WebSocket(WS_SERVER);

  ws.on("open", () => {
    _wsRetryDelay = 3000; // reset backoff on successful connection
    paired = false;
    awaitingPairing = false;
    MASTER_KEY = null;

    send("status-update", "Connected — enter pairing code");

    ws.send(
      JSON.stringify({
        type: "AUTH",
        deviceId: DEVICE_ID,
        platform: PLATFORM,
        name: DEVICE_NAME,
      }),
    );

    offlineQueue.forEach((m) => ws.send(JSON.stringify(m)));
    offlineQueue = [];
  });

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    /* ---------- AUTH ---------- */

    if (data.type === "AUTH_OK") {
      if (!awaitingPairing) return;

      awaitingPairing = false;
      paired = true;
      userId = data.userId;
      MASTER_KEY = deriveKey(userId);

      send("status-update", "Paired & syncing");

      new Notification({
        title: "Universal Clipboard",
        body: "Device paired",
      }).show();
      return;
    }

    if (data.type === "AUTH_FAIL") {
      awaitingPairing = false;
      paired = false;
      send("status-update", "Invalid pairing code");
      return;
    }

    if (paired && data.type === "CHAT_MSG") {
      send("chat-msg", data);
      return;
    }

    /* ---------- IMAGE RECEIVE ---------- */

    if (paired && data.type === "CLIP_SYNC" && data.contentType === "image") {
      if (data.timestamp <= lastTimestamp) return;
      lastTimestamp = data.timestamp;

      const buffer = decrypt(data.payload);
      if (!buffer) return;

      isRemoteWrite = true;

      clipboard.writeImage(nativeImage.createFromBuffer(buffer));

      const entry = {
        contentType: "image",
        image: buffer.toString("base64"),
        source: "Remote",
        time: Date.now(),
      };

      addToHistory(entry);
      send("clipboard-update", entry);
      showNotification({ contentType: "image" });

      setTimeout(() => (isRemoteWrite = false), 300);
      return;
    }

    /* ---------- TEXT RECEIVE ---------- */

    if (paired && data.type === "CLIP_SYNC" && data.contentType === "text") {
      if (data.timestamp <= lastTimestamp) return;
      lastTimestamp = data.timestamp;

      let buffer = decrypt(data.payload);
      if (!buffer && data.payload?.data)
        buffer = Buffer.from(data.payload.data, "utf8");
      if (!buffer) return;

      const text = buffer.toString("utf8");
      if (hash(text) === lastHash) return;

      isRemoteWrite = true;
      clipboard.writeText(text);
      lastHash = hash(text);

      const entry = {
        contentType: "text",
        text,
        source: "Remote",
        time: Date.now(),
      };

      addToHistory(entry);
      send("clipboard-update", entry);
      showNotification({ contentType: "text", text });

      setTimeout(() => (isRemoteWrite = false), 300);
    }
  });

  ws.on("unexpected-response", (_req, res) => {
    // Server is up but returned a non-101 response — still retry
    console.error(`[WS] unexpected HTTP ${res.statusCode} — will retry`);
    ws.terminate();
  });

  ws.on("error", (err) => {
    console.error("[WS error]", err.message);
  });

  ws.on("close", () => {
    paired = false;
    MASTER_KEY = null;

    send("status-update", `Disconnected — retrying in ${Math.round(_wsRetryDelay / 1000)}s…`);
    setTimeout(connectWebSocket, _wsRetryDelay);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, 30_000); // cap at 30s
  });
}

/* ================= CLIPBOARD WATCH ================= */

setInterval(() => {
  if (!paired || isRemoteWrite) return;

  /* ---------- IMAGE FIRST ---------- */
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const buffer = img.toPNG();
    const h = hash(buffer);
    if (h === lastHash) return;

    lastHash = h;

    const entry = {
      contentType: "image",
      image: buffer.toString("base64"),
      source: "Local",
      time: Date.now(),
    };

    addToHistory(entry);
    send("clipboard-update", entry);

    const msg = {
      type: "CLIP_UPDATE",
      contentType: "image",
      payload: encrypt(buffer),
      timestamp: Date.now(),
    };

    ws?.readyState === WebSocket.OPEN
      ? ws.send(JSON.stringify(msg))
      : offlineQueue.push(msg);

    return;
  }

  /* ---------- TEXT ---------- */
  const text = clipboard.readText();
  if (!text) return;

  const h = hash(text);
  if (h === lastHash) return;

  lastHash = h;

  const entry = {
    contentType: "text",
    text,
    source: "Local",
    time: Date.now(),
  };

  addToHistory(entry);
  send("clipboard-update", entry);

  ws.send(
    JSON.stringify({
      type: "CLIP_UPDATE",
      contentType: "text",
      payload: MASTER_KEY ? encrypt(Buffer.from(text)) : { data: text },
      timestamp: Date.now(),
    }),
  );
}, 500);

/* ================= IPC ================= */

ipcMain.handle("pair-with-code", (_, code) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  awaitingPairing = true;

  ws.send(
    JSON.stringify({
      type: "AUTH_PAIR",
      pairingToken: code.trim().toUpperCase(),
      deviceId: DEVICE_ID,
      platform: PLATFORM,
      name: DEVICE_NAME,
    }),
  );
});

ipcMain.handle("chat-send", (_, text) => {
  if (!ws || ws.readyState !== WebSocket.OPEN || !paired || !text?.trim()) return;
  ws.send(JSON.stringify({ type: "CHAT_MSG", text: text.trim() }));
});

ipcMain.handle("restore-history-item", (_, item) => {
  isRemoteWrite = true;

  if (item.contentType === "text") {
    clipboard.writeText(item.text);
  }

  if (item.contentType === "image") {
    clipboard.writeImage(
      nativeImage.createFromBuffer(Buffer.from(item.image, "base64")),
    );
  }

  setTimeout(() => (isRemoteWrite = false), 300);
});

ipcMain.handle("save-history-item", async (_, item) => {
  if (!item?.data && !item?.image) return;

  const defaultName =
    item.contentType === "image"
      ? `image-${Date.now()}.png`
      : item.name || `file-${Date.now()}`;

  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
  });

  if (canceled || !filePath) return;

  const buffer = Buffer.from(item.image || item.data, "base64");
  fs.writeFileSync(filePath, buffer);
});

/* ================= APP ================= */
