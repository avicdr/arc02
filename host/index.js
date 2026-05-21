/**
 * Universal Clipboard – Electron Host (AUTO-REFRESH + SECURE)
 */

const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  dialog,
  Notification,
  nativeImage,
} = require("electron");

const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
const QRCode = require("qrcode");
const crypto = require("crypto");

/* ================= CONFIG ================= */

const WS_SERVER = "wss://backend-unv.onrender.com";
const HTTP_SERVER = "https://backend-unv.onrender.com";

// Unique per machine — devices on different machines will have different IDs
const USER_ID = `user-${os.hostname().replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
const DEVICE_ID = crypto.randomUUID();
const PLATFORM = process.platform;

const DEVICE_NAME =
  PLATFORM === "darwin" ? "Mac" : PLATFORM === "win32" ? "Windows" : PLATFORM;

/* ================= CRYPTO ================= */

const MASTER_KEY = crypto.createHash("sha256").update(USER_ID).digest();

function encrypt(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    data: enc.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decrypt(enc) {
  if (!enc || !enc.iv || !enc.data || !enc.tag) return null;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      MASTER_KEY,
      Buffer.from(enc.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(enc.data, "base64")),
      decipher.final(),
    ]);
  } catch {
    return null;
  }
}

/* ================= STATE ================= */

let mainWindow;
let ws;

let rendererReady = false;
let pendingStatus = null;

let lastHash = "";
let lastTimestamp = 0;
let isRemoteWrite = false;

let history = [];
let devices = [];

/* 🔒 PAIRING STATE */
let pairingSession = null;
let pairingInterval = null;
let pairingInProgress = false;

/* ================= HELPERS ================= */

function hash(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function send(channel, payload) {
  if (rendererReady && mainWindow) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendStatus(text) {
  if (rendererReady) send("status-update", text);
  else pendingStatus = text;
}

function schedulePairingRegeneration(delay = 1000) {
  if (pairingInProgress) return;

  setTimeout(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (pairingInProgress) return;

    generatePairing();
  }, delay);
}

function pushHistory(entry) {
  history.unshift(entry);
  history = history.slice(0, 10);
  send("clipboard-history", history);
}

function isSelfAuth(data) {
  return data.deviceId === DEVICE_ID;
}

function shouldSendPlaintext() {
  return devices.some((d) => d.platform === "android");
}

/* ================= WINDOW ================= */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("index.html");

  mainWindow.webContents.on("did-finish-load", () => {
    rendererReady = true;
    if (pendingStatus) send("status-update", pendingStatus);
    send("clipboard-history", history);
    send("devices-update", devices);
  });
}

/* ================= PAIRING ================= */

async function generatePairing() {
  if (pairingInterval) clearInterval(pairingInterval);

  const res = await fetch(`${HTTP_SERVER}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: USER_ID }),
  });

  if (!res.ok) return;
  const data = await res.json();

  pairingSession = {
    token: data.pairingToken,
    expiresAt: Date.now() + data.expiresIn * 1000,
  };
  pairingInProgress = true;

  const qrPayload = JSON.stringify({
    pairingToken: data.pairingToken,
    server: WS_SERVER,
  });

  send("pairing-update", {
    code: data.pairingToken,
    qr: await QRCode.toDataURL(qrPayload),
  });

  send("pairing-timer", data.expiresIn);

  pairingInterval = setInterval(() => {
    if (!pairingSession) return;

    const remaining = Math.max(
      0,
      Math.ceil((pairingSession.expiresAt - Date.now()) / 1000),
    );

    send("pairing-timer", remaining);

    if (remaining <= 0) {
      pairingSession = null;
      pairingInProgress = false;

      clearInterval(pairingInterval);
      pairingInterval = null;

      send("pairing-update", { code: null, qr: null });

      // 🔁 AUTO-REGENERATE
      schedulePairingRegeneration(500);
    }
  }, 1000);
}

ipcMain.handle("restore-history-item", (_, item) => {
  if (!item || !item.contentType) return;
  isRemoteWrite = true;
  if (item.contentType === "text" && item.text) {
    clipboard.writeText(item.text);
  }
  if (item.contentType === "image" && item.image) {
    const img = nativeImage.createFromBuffer(Buffer.from(item.image, "base64"));
    clipboard.writeImage(img);
  }
  setTimeout(() => {
    isRemoteWrite = false;
  }, 300);
});

ipcMain.handle("pair-device", generatePairing);
ipcMain.handle("request-pairing", generatePairing);
ipcMain.handle("get-clipboard-history", () => history);
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

/* ================= WEBSOCKET ================= */

let _wsRetryDelay = 3000; // starts at 3s, doubles up to 30s

function connectWebSocket() {
  sendStatus("Connecting…");
  ws = new WebSocket(WS_SERVER);

  ws.on("open", () => {
    _wsRetryDelay = 3000; // reset backoff on successful connection
    sendStatus("Connected");

    ws.send(
      JSON.stringify({
        type: "AUTH",
        userId: USER_ID,
        deviceId: DEVICE_ID,
        platform: PLATFORM,
        name: DEVICE_NAME,
      }),
    );

    // AUTO-GENERATE PAIRING AFTER WS CONNECT
    generatePairing();
  });

  ws.on("message", (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (data.type === "AUTH_OK") {
      sendStatus("Paired & Syncing");

      // Ignore host self-auth
      if (isSelfAuth(data)) return;

      // A remote device paired — keep the pairing code active for more devices
      send("status-update", "Device connected — pairing code still active");

      return;
    }

    if (data.type === "DEVICE_LIST") {
      devices = data.devices;
      send("devices-update", devices);
      return;
    }

    /* ---------- TEXT / IMAGE ---------- */
    if (data.type === "CLIP_SYNC") {
      if (data.timestamp <= lastTimestamp) return;
      lastTimestamp = data.timestamp;

      const buffer = decrypt(data.payload);
      if (!buffer) return;

      isRemoteWrite = true;

      if (data.contentType === "image") {
        clipboard.writeImage(nativeImage.createFromBuffer(buffer));
        pushHistory({
          contentType: "image",
          image: buffer.toString("base64"),
          source: "Remote",
          time: Date.now(),
        });
      } else {
        const text = buffer.toString("utf8");
        clipboard.writeText(text);
        pushHistory({
          contentType: "text",
          text,
          source: "Remote",
          time: Date.now(),
        });
      }

      setTimeout(() => (isRemoteWrite = false), 300);
    }
  });

  ws.on("unexpected-response", (_req, res) => {
    // Server is up but returned a non-101 HTTP response — still retry
    console.error(`[WS] unexpected HTTP ${res.statusCode} — will retry`);
    ws.terminate();
  });

  ws.on("error", (err) => {
    // Suppress unhandled error — close event drives the retry loop
    console.error("[WS error]", err.message);
  });

  ws.on("close", () => {
    pairingSession = null;
    pairingInProgress = false;
    if (pairingInterval) clearInterval(pairingInterval);
    pairingInterval = null;

    sendStatus(`Disconnected — retrying in ${Math.round(_wsRetryDelay / 1000)}s…`);
    setTimeout(connectWebSocket, _wsRetryDelay);
    _wsRetryDelay = Math.min(_wsRetryDelay * 2, 30_000); // cap at 30s
  });
}

/* ================= CLIPBOARD WATCHER ================= */

function watchClipboard() {
  setInterval(() => {
    if (isRemoteWrite || !ws || ws.readyState !== WebSocket.OPEN) return;

    /* ---------- IMAGE ---------- */
    const img = clipboard.readImage();
    if (!img.isEmpty()) {
      const buffer = img.toPNG();
      const h = hash(buffer);
      if (h === lastHash) return;
      lastHash = h;

      const base64 = buffer.toString("base64");

      const entry = {
        contentType: "image",
        image: base64,
        source: "Local",
        time: Date.now(),
      };

      pushHistory(entry);
      send("clipboard-update", entry);

      ws.send(
        JSON.stringify({
          type: "CLIP_UPDATE",
          contentType: "image",
          payload: shouldSendPlaintext()
            ? { data: buffer.toString("base64") }
            : encrypt(buffer),
          timestamp: Date.now(),
        }),
      );
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

    pushHistory(entry);
    send("clipboard-update", entry);

    ws.send(
      JSON.stringify({
        type: "CLIP_UPDATE",
        contentType: "text",
        payload: shouldSendPlaintext()
          ? { data: text }
          : encrypt(Buffer.from(text)),
        timestamp: Date.now(),
      }),
    );
  }, 500);
}

/* ================= APP ================= */

app.whenReady().then(() => {
  createWindow();
  connectWebSocket();
  watchClipboard();
});
