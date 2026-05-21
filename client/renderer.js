/* =====================================================
   DOM REFERENCES
===================================================== */

const statusEl = document.getElementById("status");
const clipboardEl = document.getElementById("clipboard");
const historyEl = document.getElementById("history");
const searchInput = document.getElementById("searchInput");
const codeInput = document.getElementById("codeInput");
const pairBtn = document.getElementById("pairBtn");
const darkToggle = document.getElementById("darkToggle");
const toastEl = document.getElementById("toast");

/* =====================================================
   STATE
===================================================== */

let fullHistory = [];
let query = "";
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
   TOAST
===================================================== */

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2500);
}

/* =====================================================
   LAST CLIPBOARD
===================================================== */

window.api.onClipboardUpdate((item) => {
  renderLastClipboard(item);
});

/* =====================================================
   HISTORY
===================================================== */

window.api.onClipboardHistory((history) => {
  fullHistory = history || [];
  renderHistory();
});

if (searchInput) {
  searchInput.oninput = (e) => {
    query = e.target.value.toLowerCase();
    renderHistory();
  };
}

/* =====================================================
   RENDER HELPERS
===================================================== */

function renderLastClipboard(item) {
  clipboardEl.innerHTML = "";

  /* ---------- IMAGE ---------- */
  if (item.contentType === "image") {
    const img = document.createElement("img");
    img.src = `data:image/png;base64,${item.image}`;
    img.className = "preview";
    clipboardEl.appendChild(img);
  } else {
    /* ---------- TEXT ---------- */
    clipboardEl.textContent = item.text || "—";
  }
}

function renderHistory() {
  historyEl.innerHTML = "";

  const items = query
    ? fullHistory.filter((h) => (h.text || "").toLowerCase().includes(query))
    : fullHistory;

  if (!items.length) {
    historyEl.innerHTML = "<li style='opacity:.6'>No history</li>";
    return;
  }

  items.forEach((item) => {
    const li = document.createElement("li");

    const title = document.createElement("div");
    title.className = "history-title";
    title.textContent =
      item.contentType === "image"
        ? "🖼 Image"
        : item.source || "Text";

    const content = document.createElement("div");
    content.className = "history-content";

    if (item.contentType === "image") {
      const img = document.createElement("img");
      img.src = `data:image/png;base64,${item.image}`;
      img.className = "history-image";
      content.appendChild(img);
    } else if (item.contentType === "text") {
      content.textContent = item.text;
    }

    li.onclick = () => {
      window.api.restoreHistoryItem(item);
      renderLastClipboard(item);
      showToast("Restored to clipboard");
    };

    li.appendChild(title);
    li.appendChild(content);
    historyEl.appendChild(li);
  });
}

/* =====================================================
   PAIRING
===================================================== */

pairBtn.onclick = () => {
  const code = codeInput.value.trim().toUpperCase();
  if (code) window.api.pairWithCode(code);
};
