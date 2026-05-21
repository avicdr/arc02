/* =====================================================
   DOM REFERENCES
===================================================== */

const statusEl = document.getElementById("status");
const clipboardEl = document.getElementById("clipboard");
const metaEl = document.getElementById("meta");
const historyEl = document.getElementById("history");
const devicesEl = document.getElementById("devices");
const qrDiv = document.getElementById("qr");
const timerEl = document.getElementById("timer");
const pairBtn = document.getElementById("pairBtn");
const darkToggle = document.getElementById("darkToggle");
const pairCodeEl = document.getElementById("pairCode");
const searchInput = document.getElementById("searchInput");
const toastEl = document.getElementById("toast");

let toastTimer = null;

/* =====================================================
   DARK MODE
===================================================== */

const savedTheme = localStorage.getItem("theme");
if (savedTheme === "dark") document.body.classList.add("dark");

darkToggle.onclick = () => {
  document.body.classList.toggle("dark");
  localStorage.setItem(
    "theme",
    document.body.classList.contains("dark") ? "dark" : "light",
  );
};

/* =====================================================
   STATUS
===================================================== */

window.api.onStatusUpdate((status) => {
  if (statusEl) statusEl.textContent = status;
});

/* =====================================================
   HELPERS
===================================================== */


/* =====================================================
   CLIPBOARD (LIVE)
===================================================== */

window.api.onClipboardUpdate((data) => {
  if (!clipboardEl) return;

  clipboardEl.innerHTML = "";

  /* ---------- IMAGE ---------- */
  if (data.contentType === "image") {
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${data.image}`;
    img.style.maxWidth = "100%";
    clipboardEl.appendChild(img);

    metaEl.innerHTML = `<div>🖼 Image • ${new Date(
      data.time,
    ).toLocaleTimeString()}</div>`;
    return;
  }

  /* ---------- TEXT ---------- */
  clipboardEl.textContent = data.text || "—";

  metaEl.innerHTML = `
    <div>Source: <strong>${data.source}</strong></div>
    <div>Time: <strong>${new Date(
      data.time,
    ).toLocaleTimeString()}</strong></div>
  `;
});

/* =====================================================
   TOAST
===================================================== */

function showToast(message = "Copied to Clipboard") {
  if (!toastEl) return;

  toastEl.textContent = message;
  toastEl.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 3000);
}

/* =====================================================
   CLIPBOARD HISTORY + SEARCH
===================================================== */

let fullHistory = [];
let query = "";

window.api.onClipboardHistory((history) => {
  fullHistory = history || [];
  renderHistory();
});

if (searchInput) {
  searchInput.oninput = (e) => {
    query = e.target.value.toLowerCase().trim();
    renderHistory();
  };
}

function renderHistory() {
  historyEl.innerHTML = "";

  const items = query
    ? fullHistory.filter((h) => h.text?.toLowerCase().includes(query))
    : fullHistory;

  if (!items.length) {
    historyEl.innerHTML = "<li style='opacity:.6'>No results</li>";
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");

    const title = document.createElement("div");
    title.className = "history-title";

    if (item.contentType === "image") title.textContent = "🖼 Image";
    else title.textContent = item.source || "Text";

    const content = document.createElement("div");
    content.className = "history-content";

    if (item.contentType === "image" && item.image) {
      const img = document.createElement("img");
      img.src = `data:image/png;base64,${item.image}`;
      img.className = "history-image";

      const meta = document.createElement("div");
      meta.style.fontSize = "11px";
      meta.style.opacity = "0.6";
      meta.style.marginTop = "4px";
      meta.textContent = new Date(item.time).toLocaleTimeString();

      content.appendChild(img);
      content.appendChild(meta);
    } else if (item.text) {
      content.innerHTML = highlight(item.text, query);
    } else {
      content.textContent = new Date(item.time).toLocaleTimeString();
    }

    li.appendChild(title);
    li.appendChild(content);

    /* ---------- RESTORE ---------- */
    li.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.api.restoreHistoryItem(item);
      showToast("Copied to Clipboard");
    };

    historyEl.appendChild(li);
  });
}

/* =====================================================
   HIGHLIGHT HELPERS
===================================================== */

function highlight(text, q) {
  if (!q) return escapeHTML(text);
  return escapeHTML(text).replace(
    new RegExp(`(${escapeRegex(q)})`, "gi"),
    "<mark>$1</mark>",
  );
}

function escapeHTML(str) {
  return str.replace(
    /[&<>"']/g,
    (m) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        m
      ],
  );
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* =====================================================
   DEVICES
===================================================== */

window.api.onDevicesUpdate((devices) => {
  if (!devicesEl) return;

  devicesEl.innerHTML = "";

  devices.forEach((d) => {
    const li = document.createElement("li");

    const row = document.createElement("div");
    row.className = "row";

    const name = document.createElement("strong");
    name.textContent = d.platform;

    const revoke = document.createElement("button");
    revoke.textContent = d.revoked ? "Revoked" : "Revoke";
    revoke.className = "revoke";
    revoke.disabled = d.revoked;
    revoke.onclick = () => window.api.revokeDevice(d.deviceId);

    row.appendChild(name);
    row.appendChild(revoke);
    li.appendChild(row);
    devicesEl.appendChild(li);
  });
});

/* =====================================================
   PAIRING
===================================================== */

pairBtn.onclick = () => window.api.pairDevice();

window.api.onPairingUpdate(({ qr, code }) => {
  if (qrDiv) qrDiv.innerHTML = qr ? `<img src="${qr}" />` : "";
  if (pairCodeEl) pairCodeEl.textContent = code || "—";
});

window.api.onPairingTimer((seconds) => {
  if (!timerEl) return;
  timerEl.textContent = seconds > 0 ? `Expires in ${seconds}s` : "";
});
