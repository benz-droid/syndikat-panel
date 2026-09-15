/* ---------------------------------------------------------------
   Operations-Netzwerk — vanilla JS + Firestore
----------------------------------------------------------------*/
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

const CATEGORIES = [
  { key: "arbeiter", label: "Arbeiter" },
  { key: "fraktionlager", label: "Fraktion & Lager" },
  { key: "routenorte", label: "Routen & Orte" },
  { key: "routenrechner", label: "Routen-Rechner" },
  { key: "waffenshop", label: "Waffen-Shop" },
];

let usersMap = {};      // icName -> user data
let requestsList = [];  // [{icName, password, rang, ts}]
let funkState = { value: "" };
let currentUser = null; // icName of logged in user
let adminUnlocked = false;
let activeCategory = CATEGORIES[0].key;
let entriesUnsub = null;
let entryImages = []; // staged base64 images for "add entry" modal

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

/* ---------------- image compression ---------------- */
function compressImage(file, maxW = 500, quality = 0.55) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("image failed"));
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------------- live listeners ---------------- */
db.collection("users").onSnapshot((snap) => {
  usersMap = {};
  snap.forEach((doc) => (usersMap[doc.id] = doc.data()));
  onUsersOrRequestsChanged();
});
db.collection("requests").onSnapshot((snap) => {
  requestsList = [];
  snap.forEach((doc) => requestsList.push({ icName: doc.id, ...doc.data() }));
  onUsersOrRequestsChanged();
});
db.collection("meta").doc("funk").onSnapshot((doc) => {
  funkState = doc.exists ? doc.data() : { value: "" };
  renderFunk();
});

function onUsersOrRequestsChanged() {
  // waiting screen: promote to dashboard if approved / show rejected if removed
  if (!currentUser && pendingWatchName) {
    if (usersMap[pendingWatchName]) {
      currentUser = pendingWatchName;
      pendingWatchName = null;
      enterDashboard();
    } else if (!requestsList.some((r) => r.icName === pendingWatchName)) {
      pendingWatchName = null;
      showScreen("rejected");
    }
  }
  if (currentUser) renderDashboardHeader();
  if (adminUnlocked) renderAdminPanel();
}

let pendingWatchName = null;

/* ---------------- screen switching ---------------- */
function showScreen(name) {
  ["login", "waiting", "rejected"].forEach((s) => hide("screen-" + s));
  hide("screen-dashboard");
  if (name) show("screen-" + name);
}

/* ---------------- LOGIN / REGISTER ---------------- */
$("go-register").onclick = () => {
  hide("form-login"); show("form-register");
  $("login-subtitle").textContent = "Neuen Zugang beantragen";
};
$("go-login").onclick = () => {
  hide("form-register"); show("form-login");
  $("login-subtitle").textContent = "Zugang mit bestehendem Konto";
};

$("form-login").onsubmit = async (e) => {
  e.preventDefault();
  $("login-error").innerHTML = "";
  const icName = $("login-icname").value.trim();
  const password = $("login-password").value;
  if (!icName || !password) {
    $("login-error").innerHTML = '<div class="error-line">Bitte IC-Name und Passwort eingeben.</div>';
    return;
  }
  const userDoc = await db.collection("users").doc(icName).get();
  if (!userDoc.exists) {
    const reqDoc = await db.collection("requests").doc(icName).get();
    if (reqDoc.exists) {
      pendingWatchName = icName;
      $("waiting-name").textContent = icName;
      showScreen("waiting");
    } else {
      $("login-error").innerHTML = '<div class="error-line">Kein Zugang mit diesem IC-Namen gefunden.</div>';
    }
    return;
  }
  const data = userDoc.data();
  if (data.password !== password) {
    $("login-error").innerHTML = '<div class="error-line">Falsches Passwort.</div>';
    return;
  }
  currentUser = icName;
  enterDashboard();
};

$("form-register").onsubmit = async (e) => {
  e.preventDefault();
  $("register-error").innerHTML = "";
  const icName = $("reg-icname").value.trim();
  const password = $("reg-password").value;
  const rang = $("reg-rang").value.trim();
  if (!icName || !password || !rang) {
    $("register-error").innerHTML = '<div class="error-line">Bitte alle drei Felder ausfüllen.</div>';
    return;
  }
  const userDoc = await db.collection("users").doc(icName).get();
  if (userDoc.exists) {
    $("register-error").innerHTML = '<div class="error-line">Dieser IC-Name ist bereits registriert.</div>';
    return;
  }
  await db.collection("requests").doc(icName).set({ password, rang, ts: Date.now() });
  pendingWatchName = icName;
  $("waiting-name").textContent = icName;
  showScreen("waiting");
};

$("rejected-back").onclick = () => showScreen("login");

/* ---------------- ADMIN GATE ---------------- */
$("crown-btn").onclick = () => { $("admin-pw").value = ""; $("admin-gate-error").innerHTML = ""; show("admin-gate"); };
$("admin-gate-close").onclick = () => hide("admin-gate");
$("form-admin-gate").onsubmit = (e) => {
  e.preventDefault();
  if ($("admin-pw").value === ADMIN_PASSWORD) {
    hide("admin-gate");
    adminUnlocked = true;
    showScreen(null);
    hide("screen-dashboard");
    show("admin-panel");
    renderAdminPanel();
  } else {
    $("admin-gate-error").innerHTML = '<div class="error-line">Falsches Passwort.</div>';
  }
};
$("admin-back").onclick = () => {
  adminUnlocked = false;
  hide("admin-panel");
  if (currentUser) { show("screen-dashboard"); } else { showScreen("login"); }
};

/* ---------------- ADMIN PANEL ---------------- */
document.querySelectorAll(".admin-tab").forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll(".admin-tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    ["requests", "users", "funk"].forEach((t) => {
      $("admin-tab-" + t).classList.toggle("hidden", t !== btn.dataset.tab);
    });
  };
});

function renderAdminPanel() {
  $("tab-requests-btn").textContent = `Anfragen (${requestsList.length})`;
  const userEntries = Object.entries(usersMap);
  $("tab-users-btn").textContent = `Nutzer & Rechte (${userEntries.length})`;

  const reqBox = $("admin-tab-requests");
  reqBox.innerHTML = "";
  if (requestsList.length === 0) {
    reqBox.innerHTML = '<div class="empty-note">Keine offenen Anfragen.</div>';
  }
  requestsList.forEach((r) => {
    const row = document.createElement("div");
    row.className = "row-card";
    row.innerHTML = `
      <div>
        <div style="color:var(--ink);font-weight:600;font-size:14.5px;">${escapeHtml(r.icName)}</div>
        <div style="color:var(--ink-faint);font-size:12px;">Rang-Wunsch: ${escapeHtml(r.rang)} · ${new Date(r.ts).toLocaleString("de-DE")}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-solid" data-approve="${escapeAttr(r.icName)}">&#10003; Annehmen</button>
        <button class="btn btn-danger" data-reject="${escapeAttr(r.icName)}">&#10005; Ablehnen</button>
      </div>`;
    reqBox.appendChild(row);
  });
  reqBox.querySelectorAll("[data-approve]").forEach((b) => (b.onclick = () => approveRequest(b.dataset.approve)));
  reqBox.querySelectorAll("[data-reject]").forEach((b) => (b.onclick = () => rejectRequest(b.dataset.reject)));

  const userBox = $("admin-tab-users");
  userBox.innerHTML = "";
  if (userEntries.length === 0) {
    userBox.innerHTML = '<div class="empty-note">Noch keine freigeschalteten Nutzer.</div>';
  }
  userEntries.forEach(([name, u]) => {
    const row = document.createElement("div");
    row.className = "row-card";
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;">
        <div class="avatar" style="width:34px;height:34px;">${u.avatar ? `<img src="${u.avatar}"/>` : ""}</div>
        <div>
          <div style="color:var(--ink);font-weight:600;font-size:14.5px;">${escapeHtml(name)}</div>
          <div style="color:var(--ink-faint);font-size:12px;">${escapeHtml(u.rang || "")}</div>
        </div>
      </div>
      <div style="display:flex;gap:14px;align-items:center;">
        <span class="toggle-wrap">Funk <span class="toggle ${u.rights?.funk ? "on" : ""}" data-right="funk" data-user="${escapeAttr(name)}"><span class="toggle-dot"></span></span></span>
        <span class="toggle-wrap">Admin <span class="toggle ${u.rights?.admin ? "on" : ""}" data-right="admin" data-user="${escapeAttr(name)}"><span class="toggle-dot"></span></span></span>
        <button class="icon-btn" style="color:var(--red-bright);" data-remove="${escapeAttr(name)}">&#128465;</button>
      </div>`;
    userBox.appendChild(row);
  });
  userBox.querySelectorAll("[data-right]").forEach((t) => (t.onclick = () => toggleRight(t.dataset.user, t.dataset.right)));
  userBox.querySelectorAll("[data-remove]").forEach((b) => (b.onclick = () => removeUser(b.dataset.remove)));

  $("admin-funk-input").value = funkState.value || "";
}

async function approveRequest(icName) {
  const req = requestsList.find((r) => r.icName === icName);
  if (!req) return;
  await db.collection("users").doc(icName).set({
    password: req.password,
    rang: req.rang,
    rights: { funk: false, admin: false },
    avatar: null,
    bio: "",
    tarnen: false,
    joined: Date.now(),
  });
  await db.collection("requests").doc(icName).delete();
}
async function rejectRequest(icName) {
  await db.collection("requests").doc(icName).delete();
}
async function toggleRight(icName, right) {
  const u = usersMap[icName];
  if (!u) return;
  const rights = { ...(u.rights || {}) };
  rights[right] = !rights[right];
  await db.collection("users").doc(icName).update({ rights });
}
async function removeUser(icName) {
  await db.collection("users").doc(icName).delete();
}
$("admin-funk-save").onclick = async () => {
  await db.collection("meta").doc("funk").set({ value: $("admin-funk-input").value, updatedBy: "Admin", ts: Date.now() });
};

/* ---------------- DASHBOARD ---------------- */
function enterDashboard() {
  showScreen(null);
  hide("admin-panel");
  show("screen-dashboard");
  renderDashboardHeader();
  buildCategoryTabs();
  switchCategory(activeCategory);
}

$("logout-btn").onclick = () => {
  currentUser = null;
  if (entriesUnsub) entriesUnsub();
  hide("screen-dashboard");
  showScreen("login");
};

function me() { return usersMap[currentUser] || {}; }

function renderDashboardHeader() {
  if (!currentUser) return;
  const u = me();
  $("my-name").textContent = currentUser;
  $("my-rang").textContent = u.rang || "";
  $("my-admin-badge").classList.toggle("hidden", !u.rights?.admin);

  const avatarEl = $("my-avatar");
  avatarEl.innerHTML = u.avatar
    ? `<img src="${u.avatar}"/><div class="avatar-hover">&#128247;</div>`
    : `<div class="avatar-hover">&#128247;</div>`;

  if (!$("bio-input-focused")) {
    $("bio-display").innerHTML = (u.bio ? escapeHtml(u.bio) : "Status hinzufügen...") + " &#9998;";
  }

  renderFunk();
}

$("my-avatar").onclick = () => $("avatar-input").click();
$("avatar-input").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  const dataUrl = await compressImage(file, 200, 0.6);
  await db.collection("users").doc(currentUser).update({ avatar: dataUrl });
};

$("bio-display").onclick = () => {
  $("bio-input").value = me().bio || "";
  hide("bio-display"); show("bio-edit");
  $("bio-input").focus();
};
$("bio-cancel").onclick = () => { hide("bio-edit"); show("bio-display"); };
$("bio-save").onclick = async () => {
  await db.collection("users").doc(currentUser).update({ bio: $("bio-input").value });
  hide("bio-edit"); show("bio-display");
};

function renderFunk() {
  $("funk-display").textContent = funkState.value || "—";
  const canFunk = !!me().rights?.funk || !!me().rights?.admin;
  $("funk-edit-btn").classList.toggle("hidden", !(currentUser && canFunk));
}
$("funk-edit-btn").onclick = () => {
  $("funk-input").value = funkState.value || "";
  hide("funk-display"); hide("funk-edit-btn");
  show("funk-input"); show("funk-save-btn"); show("funk-cancel-btn");
  $("funk-input").focus();
};
$("funk-cancel-btn").onclick = () => {
  hide("funk-input"); hide("funk-save-btn"); hide("funk-cancel-btn");
  show("funk-display"); show("funk-edit-btn");
};
$("funk-save-btn").onclick = async () => {
  await db.collection("meta").doc("funk").set({ value: $("funk-input").value, updatedBy: currentUser, ts: Date.now() });
  hide("funk-input"); hide("funk-save-btn"); hide("funk-cancel-btn");
  show("funk-display"); show("funk-edit-btn");
};

$("tarnen-btn").onclick = async () => {
  const u = me();
  await db.collection("users").doc(currentUser).update({ tarnen: !u.tarnen });
  $("tarnen-btn").textContent = !u.tarnen ? "SICHTBAR" : "TARNEN";
};

/* ---------------- CATEGORY TABS + BOARD ---------------- */
function buildCategoryTabs() {
  const wrap = $("cat-tabs");
  wrap.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "cat-tab" + (c.key === activeCategory ? " active" : "");
    btn.textContent = c.label;
    btn.onclick = () => switchCategory(c.key);
    wrap.appendChild(btn);
  });
}

function switchCategory(key) {
  activeCategory = key;
  document.querySelectorAll(".cat-tab").forEach((b, i) => b.classList.toggle("active", CATEGORIES[i].key === key));
  $("board-title").textContent = CATEGORIES.find((c) => c.key === key).label;
  $("entries-grid").innerHTML = '<div class="empty-note">Lade Einträge...</div>';
  if (entriesUnsub) entriesUnsub();
  entriesUnsub = db.collection("entries_" + key).orderBy("ts", "desc").onSnapshot((snap) => {
    const entries = [];
    snap.forEach((doc) => entries.push({ id: doc.id, ...doc.data() }));
    renderEntries(entries);
  });
}

function renderEntries(entries) {
  const grid = $("entries-grid");
  grid.innerHTML = "";
  if (entries.length === 0) {
    grid.innerHTML = '<div class="empty-note">Noch keine Einträge in dieser Kategorie.</div>';
    return;
  }
  const isAdmin = !!me().rights?.admin;
  entries.forEach((e) => {
    const card = document.createElement("div");
    card.className = "entry-card";
    let imgsHtml = "";
    if (e.images && e.images.length) {
      imgsHtml = `<div class="entry-imgs">${e.images
        .map((img) => `<img src="${img}" style="width:${e.images.length === 1 ? "100%" : "150px"};flex:${e.images.length === 1 ? "1 1 100%" : "0 0 auto"};" data-lightbox="${escapeAttr(img)}"/>`)
        .join("")}</div>`;
    }
    const canDelete = e.author === currentUser || isAdmin;
    card.innerHTML = `
      ${imgsHtml}
      <div class="entry-body">
        ${e.text ? `<div class="entry-text">${escapeHtml(e.text)}</div>` : ""}
        <div class="entry-meta">
          <span>${escapeHtml(e.author)} · ${new Date(e.ts).toLocaleDateString("de-DE")}</span>
          ${canDelete ? `<button class="icon-btn" style="color:var(--red-bright);" data-del="${e.id}">&#128465;</button>` : ""}
        </div>
      </div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-lightbox]").forEach((img) => {
    img.onclick = () => { $("lightbox-img").src = img.dataset.lightbox; show("lightbox"); };
  });
  grid.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = () => db.collection("entries_" + activeCategory).doc(btn.dataset.del).delete();
  });
}
$("lightbox").onclick = () => hide("lightbox");

/* ---------------- ADD ENTRY MODAL ---------------- */
$("add-entry-btn").onclick = () => {
  entryImages = [];
  $("entry-text").value = "";
  renderEntryImages();
  show("add-entry-modal");
};
$("add-entry-close").onclick = () => hide("add-entry-modal");

function renderEntryImages() {
  const wrap = $("entry-images");
  wrap.innerHTML = "";
  entryImages.forEach((img, i) => {
    const div = document.createElement("div");
    div.className = "img-thumb";
    div.innerHTML = `<img src="${img}"/><button type="button" data-rm="${i}">&#10005;</button>`;
    wrap.appendChild(div);
  });
  wrap.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = () => { entryImages.splice(Number(b.dataset.rm), 1); renderEntryImages(); };
  });
  if (entryImages.length < 3) {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "img-pick";
    pick.textContent = "+";
    pick.onclick = () => $("entry-file-input").click();
    wrap.appendChild(pick);
  }
}
$("entry-file-input").onchange = async (e) => {
  const files = Array.from(e.target.files || []).slice(0, 3 - entryImages.length);
  for (const f of files) {
    const compressed = await compressImage(f);
    entryImages.push(compressed);
  }
  e.target.value = "";
  renderEntryImages();
};
$("form-add-entry").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("entry-text").value.trim();
  if (!text && entryImages.length === 0) return;
  await db.collection("entries_" + activeCategory).add({
    text, images: entryImages, author: currentUser, ts: Date.now(),
  });
  hide("add-entry-modal");
};

/* ---------------- helpers ---------------- */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function escapeAttr(str) { return escapeHtml(str); }

/* ---------------- boot ---------------- */
showScreen("login");
