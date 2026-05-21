# Universal Clipboard Sync

Universal Clipboard Sync is a **secure, real-time, cross-platform clipboard synchronization system** that enables seamless copy–paste across **Windows, macOS, and Android** devices.

The project is designed with **privacy-first architecture**, **explicit device trust**, and **robust loop-prevention**, making it suitable for daily personal use as well as professional workflows.

---

## ✨ Key Highlights

- Real-time clipboard sync using WebSockets
- Desktop ↔ Desktop sync (text + images)
- Desktop ↔ Android sync (text)
- Secure pairing using short-lived codes or QR
- Multi-device per user
- Persistent clipboard history
- Smart clipboard rules (OTP / password filtering)
- Loop-free, echo-safe synchronization
- Portable Windows builds (no installer required)

---

## 🧩 Platform Support

| Platform           | Role          | Text | Image |
| ------------------ | ------------- | ---- | ----- |
| Windows (Electron) | Host / Client | ✅   | ✅    |
| macOS (Electron)   | Client        | ✅   | ✅    |
| Android (Expo)     | Client        | ✅   | ❌    |

⚠️ Image clipboard on Android is limited by OS + Expo constraints.  
Images can be received, viewed, saved to gallery, and restored within the app, but **system-wide paste is not guaranteed**.

---

## 🧠 Architecture Overview

Universal Clipboard Sync follows a **hub-and-spoke architecture**:

- A **stateless relay server**
- Multiple trusted clients (desktop & mobile)

### Server Responsibilities

- Authentication & pairing validation
- Secure message relay
- Device session management
- Offline message queue

The server **never reads or interprets clipboard content**.

### Client Responsibilities

- Clipboard access
- Encryption / decryption (E2EE-compatible)
- Conflict resolution
- History management
- UI & UX

---

## 🔄 How Synchronization Works

1. A host device generates a pairing code / QR
2. A new device pairs using the code
3. Clipboard changes are detected locally
4. Updates are sent to the relay server
5. Server broadcasts updates to paired devices
6. Devices apply updates if they pass safety rules
7. Offline devices receive queued updates on reconnect

Conflict resolution uses **Last-Write-Wins**, enforced client-side.

---

## 🔐 Security Model

- Short-lived pairing tokens
- Explicit per-device trust
- Device revocation support
- WebSocket Secure (WSS)
- Payloads opaque to the server
- Loop & echo prevention at client layer

The server acts purely as a **blind relay**.

---

## 🖥 Desktop Application (Electron)

### Features

- Text & image clipboard sync
- Multi-device broadcasting
- Clipboard history with restore
- Pin important items
- Search & filter history
- Dark / light theme
- Tray support
- Portable Windows `.exe` build

### Build (Windows Portable)

```bash
npm install
npm run build:portable
```

---

## 📱 Android Application (React Native / Expo)

### Features

- Desktop ↔ Android text sync
- Smart clipboard rules:
  - Ignore OTPs (4–8 digits)
  - Ignore passwords
  - Ignore text > 250 characters
  - Ignore rapid duplicates (<3s)
- Persistent clipboard history
- Pin / unpin items
- Restore clipboard items
- Save received images to Gallery
- Connection heartbeat indicator
- Manual reconnect
- Dark / light mode

---

## 🧪 Reliability & Loop Prevention

The system prevents clipboard loops using:

- Source tagging (local vs remote)
- Timestamp ordering
- Duplicate suppression window
- Explicit remote-write guards

This guarantees:

- No echo loops
- No duplicate clipboard entries
- Stable multi-device sync

---

## 🛠 Tech Stack

### Backend

- Node.js
- WebSocket (`ws`)
- Express

### Desktop

- Electron
- Native clipboard APIs
- Electron Builder

### Mobile

- React Native
- Expo (managed workflow)
- AsyncStorage
- Media Library

---

## 📄 License

MIT License

---

## 🚀 Status

**Stable & production-ready**  
Actively evolving with additional platform support and security hardening.
