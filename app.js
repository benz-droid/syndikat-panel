/* ---------------------------------------------------------------
   Operations-Netzwerk — vanilla JS + Firestore
----------------------------------------------------------------*/
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

const CATEGORIES = [
  { key: "arbeiter", label: "Arbeiter", icon: "👥" },
  { key: "fraktionlager", label: "Fraktion & Lager", icon: "🏛️" },
  { key: "routenorte", label: "Routen & Orte", icon: "📍" },
  { key: "routenrechner", label: "Routen-Rechner", icon: "🧭" },
  { key: "waffenshop", label: "Waffen-Shop", icon: "🛡️" },
];

let usersMap = {};      // icName -> user data
let requestsList = [];  // [{icName, password, rang, ts}]
let funkState = { value: "" };
let activityLog = [];
let currentUser = null; // icName of logged in user
let adminUnlocked = false;
let activeCategory = CATEGORIES[0].key;
let entriesUnsub = null;
let foldersUnsub = null;
let folderTrail = []; // beliebig tiefer Ordnerpfad innerhalb einer Kategorie
let entryImages = []; // staged base64 images for "add entry" modal
let currentMaxImages = 3;
let funkMasked = false; // local-only: hides the funk value from view
let rememberedUser = localStorage.getItem("syndikat_remembered_user");
let editingFolder = null;
let editingEntry = null;
let toastTimer = null;

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
  if (!currentUser && rememberedUser && usersMap[rememberedUser]) {
    currentUser = rememberedUser;
    rememberedUser = null;
    enterDashboard();
  }
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
db.collection("activity_log").orderBy("ts", "desc").limit(80).onSnapshot((snap) => {
  activityLog = [];
  snap.forEach((doc) => activityLog.push({ id: doc.id, ...doc.data() }));
  if (adminUnlocked) renderAdminPanel();
}, () => {
  activityLog = [{ action: "⚠️ Protokoll nicht verfügbar", detail: "Firebase erlaubt das Lesen der Logs noch nicht.", actor: "System", ts: Date.now() }];
  if (adminUnlocked) renderAdminPanel();
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
  if (currentUser) { renderDashboardHeader(); renderAdminBell(); }
  if (adminUnlocked) renderAdminPanel();
}

let pendingWatchName = null;

/* ---------------- screen switching ---------------- */
function showScreen(name) {
  document.body.classList.remove("dashboard-active");
  ["login", "waiting", "rejected"].forEach((s) => hide("screen-" + s));
  hide("screen-dashboard");
  if (name) show("screen-" + name);
}

/* ---------------- LOGIN / REGISTER ---------------- */
$("go-register").onclick = () => {
  hide("form-login"); show("form-register");
  $("login-subtitle").textContent = "📝 Zugang zur Prüfung einreichen";
};
$("go-login").onclick = () => {
  hide("form-register"); show("form-login");
  $("login-subtitle").textContent = "🔒 Geschützter Zugang für Mitglieder";
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
  if ($("remember-login").checked) {
    localStorage.setItem("syndikat_remembered_user", icName);
  } else {
    localStorage.removeItem("syndikat_remembered_user");
  }
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
  void logActivity("📨 Anmeldung beantragt", `Name: ${icName} · Rang: ${rang}`, icName);
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
    ["requests", "users", "funk", "logs"].forEach((t) => {
      $("admin-tab-" + t).classList.toggle("hidden", t !== btn.dataset.tab);
    });
  };
});

function renderAdminPanel() {
  $("tab-requests-btn").textContent = `📋 Anfragen (${requestsList.length})`;
  const userEntries = Object.entries(usersMap);
  $("tab-users-btn").textContent = `👥 Nutzer & Rechte (${userEntries.length})`;
  $("tab-logs-btn").textContent = `📜 Protokoll (${activityLog.length})`;
  const adminCount = userEntries.filter(([, user]) => user.rights?.admin).length;
  $("admin-summary").innerHTML = `
    <div class="admin-stat"><div class="admin-stat-number">${requestsList.length}</div><div class="admin-stat-label">OFFENE ANFRAGEN</div></div>
    <div class="admin-stat"><div class="admin-stat-number">${userEntries.length}</div><div class="admin-stat-label">AKTIVE MITGLIEDER</div></div>
    <div class="admin-stat"><div class="admin-stat-number">${adminCount}</div><div class="admin-stat-label">ADMIN-RECHTE</div></div>`;

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
  const logBox = $("admin-tab-logs");
  if (!activityLog.length) {
    logBox.innerHTML = '<div class="empty-note">Noch keine Aktivitäten protokolliert.</div>';
  } else {
    logBox.innerHTML = `<div class="log-list">${activityLog.map((entry) => `
      <div class="log-item"><div class="log-icon">${escapeHtml(entry.icon || "•")}</div><div><div class="log-action">${escapeHtml(entry.action)}</div><div class="log-detail">${escapeHtml(entry.actor || "System")}${entry.detail ? " · " + escapeHtml(entry.detail) : ""}</div></div><div class="log-time">${new Date(entry.ts).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</div></div>`).join("")}</div>`;
  }
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
  void logActivity("✅ Anmeldung angenommen", `Mitglied: ${icName}`);
}
async function rejectRequest(icName) {
  await db.collection("requests").doc(icName).delete();
  void logActivity("❌ Anmeldung abgelehnt", `Anfrage: ${icName}`);
}
async function toggleRight(icName, right) {
  const u = usersMap[icName];
  if (!u) return;
  const rights = { ...(u.rights || {}) };
  rights[right] = !rights[right];
  await db.collection("users").doc(icName).update({ rights });
  void logActivity("🔐 Berechtigung geändert", `${icName}: ${right} ${rights[right] ? "aktiviert" : "deaktiviert"}`);
}
async function removeUser(icName) {
  await db.collection("users").doc(icName).delete();
  void logActivity("🗑️ Mitglied entfernt", icName);
}
$("admin-funk-save").onclick = async () => {
  await db.collection("meta").doc("funk").set({ value: $("admin-funk-input").value, updatedBy: "Admin", ts: Date.now() });
  void logActivity("📡 Funk geändert", $("admin-funk-input").value || "Funk gelöscht");
};

/* ---------------- DASHBOARD ---------------- */
function enterDashboard() {
  showScreen(null);
  hide("admin-panel");
  show("screen-dashboard");
  document.body.classList.add("dashboard-active");
  renderDashboardHeader();
  renderAdminBell();
  buildCategoryTabs();
  switchCategory(activeCategory);
}

$("logout-btn").onclick = () => {
  currentUser = null;
  document.body.classList.remove("dashboard-active");
  localStorage.removeItem("syndikat_remembered_user");
  hide("admin-notify-btn");
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

  if ($("bio-edit").classList.contains("hidden")) {
    $("bio-display").innerHTML = (u.bio ? escapeHtml(u.bio) : "Status hinzufügen...") + " &#9998;";
  }

  renderFunk();
}

function renderAdminBell() {
  const isAdmin = !!me().rights?.admin;
  $("admin-notify-btn").classList.toggle("hidden", !isAdmin);
  const count = requestsList.length;
  $("admin-notify-count").textContent = count > 99 ? "99+" : count;
  $("admin-notify-count").classList.toggle("hidden", count === 0);
  $("admin-notify-btn").title = count ? `${count} neue Anmeldung${count === 1 ? "" : "en"} ansehen` : "Keine neuen Anmeldungen";
}

$("admin-notify-btn").onclick = () => {
  if (!currentUser || !me().rights?.admin) return;
  adminUnlocked = true;
  showScreen(null); hide("screen-dashboard"); show("admin-panel"); renderAdminPanel();
  const firstTab = document.querySelector('.admin-tab[data-tab="requests"]');
  if (firstTab) firstTab.click();
};

$("my-avatar").onclick = () => $("avatar-input").click();
$("avatar-input").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file || !currentUser) return;
  const dataUrl = await compressImage(file, 200, 0.6);
  await db.collection("users").doc(currentUser).update({ avatar: dataUrl });
  void logActivity("🖼️ Profilbild geändert", "Profil aktualisiert");
};

$("bio-display").onclick = () => {
  $("bio-input").value = me().bio || "";
  hide("bio-display"); show("bio-edit");
  $("bio-input").focus();
};
$("bio-cancel").onclick = () => { hide("bio-edit"); show("bio-display"); };
$("bio-save").onclick = async () => {
  await db.collection("users").doc(currentUser).update({ bio: $("bio-input").value });
  void logActivity("✏️ Status geändert", $("bio-input").value || "Status entfernt");
  hide("bio-edit"); show("bio-display");
};

function renderFunk() {
  $("funk-display").textContent = funkMasked ? "•••" : (funkState.value || "—");
  const canFunk = !!me().rights?.funk || !!me().rights?.admin;
  $("funk-edit-btn").classList.toggle("hidden", !(currentUser && canFunk));
  $("tarnen-btn").textContent = funkMasked ? "SICHTBAR" : "TARNEN";
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
  void logActivity("📡 Funk geändert", $("funk-input").value || "Funk gelöscht");
  hide("funk-input"); hide("funk-save-btn"); hide("funk-cancel-btn");
  show("funk-display"); show("funk-edit-btn");
};

$("tarnen-btn").onclick = () => {
  funkMasked = !funkMasked;
  renderFunk();
};

/* ---------------- CATEGORY TABS + BOARD ---------------- */
function buildCategoryTabs() {
  const wrap = $("cat-tabs");
  wrap.innerHTML = "";
  CATEGORIES.forEach((c) => {
    const btn = document.createElement("button");
    btn.className = "cat-tab" + (c.key === activeCategory ? " active" : "");
    btn.textContent = `${c.icon}  ${c.label}`;
    btn.onclick = () => switchCategory(c.key);
    wrap.appendChild(btn);
  });
}

function switchCategory(key) {
  activeCategory = key;
  folderTrail = [];
  document.querySelectorAll(".cat-tab").forEach((b, i) => b.classList.toggle("active", CATEGORIES[i].key === key));
  if (entriesUnsub) { entriesUnsub(); entriesUnsub = null; }
  if (foldersUnsub) { foldersUnsub(); foldersUnsub = null; }
  showDirectory();
}

function folderCollection() { return activeCategory + "_folders"; }
function currentFolder() { return folderTrail[folderTrail.length - 1] || null; }
function entryCollection() {
  const folder = currentFolder();
  return folder ? activeCategory + "_entries_" + folder.id : "entries_" + activeCategory;
}

function showDirectory() {
  const folder = currentFolder();
  $("board-title-text").textContent = folder ? folder.name : CATEGORIES.find((c) => c.key === activeCategory).label;
  $("folder-back-btn").classList.toggle("hidden", folderTrail.length === 0);
  show("folders-grid"); show("entries-grid");
  currentMaxImages = folder ? 5 : 3;
  $("folders-grid").innerHTML = '<div class="empty-note">Lade Ordner...</div>';
  $("entries-grid").innerHTML = '<div class="empty-note">Lade Einträge...</div>';
  if (foldersUnsub) foldersUnsub();
  if (entriesUnsub) entriesUnsub();
  foldersUnsub = db.collection(folderCollection()).onSnapshot((snap) => {
    const parentId = folder ? folder.id : null;
    const folders = [];
    snap.forEach((doc) => { const data = doc.data(); if ((data.parentId || null) === parentId) folders.push({ id: doc.id, ...data }); });
    folders.sort((a, b) => b.ts - a.ts);
    renderFolders(folders);
  });
  const collection = entryCollection();
  entriesUnsub = db.collection(collection).orderBy("ts", "desc").onSnapshot((snap) => {
    const entries = []; snap.forEach((doc) => entries.push({ id: doc.id, ...doc.data() }));
    renderEntries(entries, collection);
  });
}

function renderFolders(folders) {
  const grid = $("folders-grid");
  grid.innerHTML = "";
  if (folders.length === 0) {
    grid.innerHTML = '<div class="empty-note">Noch keine Ordner. Leg mit "+ Neuer Ordner" den ersten an.</div>';
    return;
  }
  const isAdmin = !!me().rights?.admin;
  folders.forEach((f) => {
    const card = document.createElement("div");
    card.className = "folder-card";
    const canDelete = f.author === currentUser || isAdmin;
    card.innerHTML = `
      <div class="folder-title">&#128193; ${escapeHtml(f.name)}</div>
      <div class="entry-actions">${canDelete ? `<button class="icon-btn edit-icon" title="Ordner bearbeiten" data-editfolder="${f.id}">&#9998;</button><button class="icon-btn" style="color:var(--red-bright);" data-delfolder="${f.id}">&#128465;</button>` : ""}</div>
    `;
    card.onclick = (e) => {
      if (e.target.closest("[data-delfolder], [data-editfolder]")) return;
      openFolder(f);
    };
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-delfolder]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await deleteFolderTree(btn.dataset.delfolder);
      void logActivity("🗑️ Ordner gelöscht", "Ordner inklusive Inhalt entfernt");
    };
  });
  grid.querySelectorAll("[data-editfolder]").forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); const folder = folders.find((item) => item.id === btn.dataset.editfolder); if (!folder) return; editingFolder = folder; $("edit-folder-title").value = folder.name; show("edit-folder-modal"); };
  });
}

async function deleteFolderTree(folderId) {
  const allFolders = await db.collection(folderCollection()).get();
  const descendants = [folderId];
  for (let cursor = 0; cursor < descendants.length; cursor++) {
    const parentId = descendants[cursor];
    allFolders.forEach((doc) => { if (doc.data().parentId === parentId) descendants.push(doc.id); });
  }
  const refs = [db.collection(folderCollection()).doc(folderId)];
  for (const id of descendants) {
    const items = await db.collection(activeCategory + "_entries_" + id).get();
    items.forEach((doc) => refs.push(doc.ref));
    if (id !== folderId) refs.push(db.collection(folderCollection()).doc(id));
  }
  while (refs.length) {
    const batch = db.batch(); refs.splice(0, 450).forEach((ref) => batch.delete(ref)); await batch.commit();
  }
}

function openFolder(folder) {
  folderTrail.push(folder);
  if (entriesUnsub) { entriesUnsub(); entriesUnsub = null; }
  if (foldersUnsub) { foldersUnsub(); foldersUnsub = null; }
  showDirectory();
}
$("folder-back-btn").onclick = () => { folderTrail.pop(); if (entriesUnsub) entriesUnsub(); if (foldersUnsub) foldersUnsub(); showDirectory(); };

function renderEntries(entries, collectionName) {
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
          <span class="entry-actions">${canDelete ? `<button class="icon-btn edit-icon" title="Eintrag bearbeiten" data-editentry="${e.id}">&#9998;</button><button class="icon-btn" style="color:var(--red-bright);" data-del="${e.id}">&#128465;</button>` : ""}</span>
        </div>
      </div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll("[data-lightbox]").forEach((img) => {
    img.onclick = () => { $("lightbox-img").src = img.dataset.lightbox; show("lightbox"); };
  });
  grid.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => { await db.collection(collectionName).doc(btn.dataset.del).delete(); void logActivity("🗑️ Eintrag gelöscht", `Kategorie: ${CATEGORIES.find((c) => c.key === activeCategory).label}`); };
  });
  grid.querySelectorAll("[data-editentry]").forEach((btn) => {
    btn.onclick = () => { const entry = entries.find((item) => item.id === btn.dataset.editentry); if (!entry) return; editingEntry = { id: entry.id, collectionName }; $("edit-entry-text").value = entry.text || ""; show("edit-entry-modal"); };
  });
}
$("lightbox").onclick = () => hide("lightbox");

/* ---------------- ADD ENTRY / ADD FOLDER MODALS ---------------- */
$("add-entry-btn").onclick = () => {
  entryImages = [];
  $("entry-text").value = "";
  $("entry-images-label").textContent = `SCREENSHOTS (max. ${currentMaxImages})`;
  renderEntryImages();
  show("add-entry-modal");
};
$("add-folder-btn").onclick = () => { $("folder-title").value = ""; show("add-folder-modal"); };
$("add-entry-close").onclick = () => hide("add-entry-modal");
$("add-folder-close").onclick = () => hide("add-folder-modal");
$("edit-folder-close").onclick = () => hide("edit-folder-modal");
$("edit-entry-close").onclick = () => hide("edit-entry-modal");
$("form-add-folder").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("folder-title").value.trim();
  if (!name) return;
  const folder = currentFolder();
  try {
    await db.collection(folderCollection()).add({ name, parentId: folder ? folder.id : null, author: currentUser, ts: Date.now() });
    void logActivity("📁 Ordner hinzugefügt", name); hide("add-folder-modal"); notice("📁 Ordner wurde erstellt.");
  } catch (error) { notice(`Ordner konnte nicht gespeichert werden: ${error.message}`, true); }
};
$("form-edit-folder").onsubmit = async (e) => {
  e.preventDefault(); const name = $("edit-folder-title").value.trim(); if (!name || !editingFolder) return;
  try { await db.collection(folderCollection()).doc(editingFolder.id).update({ name, editedAt: Date.now(), editedBy: currentUser }); void logActivity("✏️ Ordner bearbeitet", `${editingFolder.name} → ${name}`); hide("edit-folder-modal"); editingFolder = null; notice("✏️ Ordner wurde bearbeitet."); } catch (error) { notice(`Ordner konnte nicht bearbeitet werden: ${error.message}`, true); }
};

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
  if (entryImages.length < currentMaxImages) {
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "img-pick";
    pick.textContent = "+";
    pick.onclick = () => $("entry-file-input").click();
    wrap.appendChild(pick);
  }
}
$("entry-file-input").onchange = async (e) => {
  const files = Array.from(e.target.files || []).slice(0, currentMaxImages - entryImages.length);
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
  const targetCollection = entryCollection();
  try {
    await db.collection(targetCollection).add({ text, images: entryImages, author: currentUser, ts: Date.now() });
    void logActivity("📝 Eintrag hinzugefügt", `${CATEGORIES.find((c) => c.key === activeCategory).label}${text ? ": " + text.slice(0, 60) : " · Bilder"}`);
    hide("add-entry-modal"); notice("📝 Eintrag wurde gespeichert.");
  } catch (error) { notice(`Eintrag konnte nicht gespeichert werden: ${error.message}`, true); }
};
$("form-edit-entry").onsubmit = async (e) => {
  e.preventDefault(); if (!editingEntry) return; const text = $("edit-entry-text").value.trim();
  try { await db.collection(editingEntry.collectionName).doc(editingEntry.id).update({ text, editedAt: Date.now(), editedBy: currentUser }); void logActivity("✏️ Eintrag bearbeitet", text ? text.slice(0, 60) : "Text entfernt"); hide("edit-entry-modal"); editingEntry = null; notice("✏️ Eintrag wurde bearbeitet."); } catch (error) { notice(`Eintrag konnte nicht bearbeitet werden: ${error.message}`, true); }
};

/* ---------------- helpers ---------------- */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function escapeAttr(str) { return escapeHtml(str); }

function logActivity(action, detail = "", actor = currentUser || "Führung") {
  return db.collection("activity_log").add({ action, detail, actor, ts: Date.now() }).catch(() => {});
}
function notice(message, isError = false) {
  const toast = $("app-toast"); toast.textContent = message; toast.classList.toggle("error", isError); toast.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove("show"), 5000);
}

/* ---------------- boot ---------------- */
showScreen("login");
