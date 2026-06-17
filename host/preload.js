const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  /* -------- pairing -------- */
  pairDevice: () => ipcRenderer.invoke("pair-device"),

  onPairingUpdate: (cb) =>
    ipcRenderer.on("pairing-update", (_, data) => cb(data)),

  onPairingTimer: (cb) => ipcRenderer.on("pairing-timer", (_, t) => cb(t)),

  /* -------- status -------- */
  onStatusUpdate: (cb) => ipcRenderer.on("status-update", (_, s) => cb(s)),

  /* -------- clipboard -------- */
  onClipboardUpdate: (cb) =>
    ipcRenderer.on("clipboard-update", (_, d) => cb(d)),

  onClipboardHistory: (cb) =>
    ipcRenderer.on("clipboard-history", (_, h) => cb(h)),

  /* 🔥 FIX: expose restoreHistoryItem */
  restoreHistoryItem: (item) =>
    ipcRenderer.invoke("restore-history-item", item),

  saveHistoryItem: (item) => ipcRenderer.invoke("save-history-item", item),

  /* -------- devices -------- */
  onDevicesUpdate: (cb) => ipcRenderer.on("devices-update", (_, d) => cb(d)),

  updateDeviceRules: (deviceId, rules) =>
    ipcRenderer.invoke("update-device-rules", deviceId, rules),

  revokeDevice: (deviceId) => ipcRenderer.invoke("revoke-device", deviceId),

  /* -------- chat -------- */
  sendChat: (text) => ipcRenderer.invoke("chat-send", text),
  onChatMessage: (cb) => ipcRenderer.on("chat-msg", (_, msg) => cb(msg)),
});

