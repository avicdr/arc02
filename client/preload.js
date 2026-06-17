const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pairWithCode: (code) => ipcRenderer.invoke("pair-with-code", code),
  requestPairing: () => ipcRenderer.invoke("request-pairing"),

  restoreHistoryItem: (item) =>
    ipcRenderer.invoke("restore-history-item", item),

  saveHistoryItem: (item) => ipcRenderer.invoke("save-history-item", item),

  onStatusUpdate: (cb) =>
    ipcRenderer.on("status-update", (_, data) => cb(data)),

  onClipboardUpdate: (cb) =>
    ipcRenderer.on("clipboard-update", (_, data) => cb(data)),

  onClipboardHistory: (cb) =>
    ipcRenderer.on("clipboard-history", (_, data) => cb(data)),

  /* -------- chat -------- */
  sendChat: (text) => ipcRenderer.invoke("chat-send", text),
  onChatMessage: (cb) => ipcRenderer.on("chat-msg", (_, msg) => cb(msg)),
});

