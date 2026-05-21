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

/* ================= CONFIG ================= */

const WS_SERVER = "wss://backend-unv.onrender.com";
const HISTORY_LIMIT = 20;

const DEVICE_ID = crypto.randomUUID();
const PLATFORM = process.platform;
const DEVICE_NAME =
  PLATFORM === "darwin" ? "Mac" : PLATFORM === "win32" ? "Windows" : PLATFORM;

/* ================= STATE ================= */

let mainWindow;
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 560,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile("index.html");
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

app.whenReady().then(() => {
  createWindow();
  connectWebSocket();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
