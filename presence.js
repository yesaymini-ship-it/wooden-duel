// WOODEN DUEL — 線上玩家列表＋邀請對戰
// 經典 script（index.html 裡 <script src="presence.js">，載在 online.js 之後），
// 在線與邀請走 window.WD（firebase.js 模組），房間流程走 online.js 的全域函式。
// 設計：登入後寫入 presence 文件（20 秒心跳一次）；列表只顯示 lastSeen 在 60 秒內的人。
// 邀請：邀請人先建房間（自己是 p1），再寫一筆 pending 邀請；對方接受就加入那間房。
// 注意：本檔不用 IIFE（與 game.js／online.js 同風格），所有識別字都加 presence 前綴。

const PRESENCE_STALE_MS = 60000; // lastSeen 超過 60 秒視為離線
const PRESENCE_HEARTBEAT_MS = 20000; // 每 20 秒更新一次 lastSeen
const PRESENCE_ROOM_WATCH_MS = 2000; // 每 2 秒檢查一次是否進出房間（同步 inGame）
const INVITE_TIMEOUT_MS = 60000; // 邀請 60 秒沒回應就過期

function presenceEl(id) { return document.getElementById(id); }
function presenceShowEl(el, show) { if (el) el.style.display = show ? "" : "none"; }
function presenceGetWD() {
  return (typeof window !== "undefined" && window.WD) ? window.WD : null;
}

// ---------- 狀態 ----------
let presenceUnsubscribe = null; // presence 監聽取消函式
let presenceHeartbeatTimer = null;
let presenceRoomWatchTimer = null;
let presencePlayers = []; // 快取的在線玩家（已過濾離線、已排序、不含自己）
let presenceMyUid = null;
let presenceInGame = false; // 目前是否在房間裡（由線上房間狀態推導）
let presenceInvitesUnsubscribe = null; // 收到的邀請監聽取消函式
let presenceIncoming = {}; // inviteId -> 邀請資料（收到的待回覆邀請）
let presenceIncomingTimers = {}; // inviteId -> 逾時 timer
let presenceOutgoing = null; // { inviteId, toUid, toName, roomCode, timer, unsubscribe }
let presenceInviteInFlight = false; // 正在發邀請（防連點）

// 目前是否在房間裡（讀 online.js 的全域狀態；online.js 沒載入就當作不在）
function presenceIsInRoom() {
  try {
    return !!(typeof onlineRoomCode !== "undefined" && onlineRoomCode &&
      typeof onlineMySlot !== "undefined" && onlineMySlot);
  } catch (e) {
    return false;
  }
}

// inGame 改變時立刻寫回 presence（順便刷新 lastSeen）
function presenceMarkInGame(inGame) {
  presenceInGame = !!inGame;
  const WD = presenceGetWD();
  if (WD && presenceMyUid && typeof WD.setPresenceInGame === "function") {
    WD.setPresenceInGame(presenceInGame);
  }
}

// ---------- 心跳 ----------
function presenceHeartbeatTick() {
  const WD = presenceGetWD();
  if (!WD || !presenceMyUid) return;
  const inRoom = presenceIsInRoom();
  if (inRoom !== presenceInGame) {
    presenceMarkInGame(inRoom); // 裡面也會刷新 lastSeen
  } else if (typeof WD.updatePresenceHeartbeat === "function") {
    WD.updatePresenceHeartbeat();
  }
}

function presenceRoomWatchTick() {
  if (!presenceMyUid) return;
  const inRoom = presenceIsInRoom();
  if (inRoom !== presenceInGame) presenceMarkInGame(inRoom);
}

// ---------- 在線玩家列表 ----------
function presenceOnPresenceSnapshot(list) {
  const now = Date.now();
  presencePlayers = (list || []).filter(function (p) {
    if (!p || !p.uid || p.uid === presenceMyUid) return false; // 不顯示自己
    if (!p.lastSeen || typeof p.lastSeen.toMillis !== "function") return false;
    return (now - p.lastSeen.toMillis()) <= PRESENCE_STALE_MS; // 60 秒內才算在線
  }).sort(function (a, b) {
    const na = String(a.displayName || "");
    const nb = String(b.displayName || "");
    return na < nb ? -1 : (na > nb ? 1 : 0);
  });
  presenceRenderList();
}

function presenceRenderList() {
  const note = presenceEl("presence-login-note");
  const listEl = presenceEl("presence-players-list");
  const emptyEl = presenceEl("presence-empty");
  if (!listEl) return;
  const loggedIn = !!presenceMyUid;
  if (note) note.style.display = loggedIn ? "none" : "block";
  listEl.innerHTML = "";
  if (!loggedIn) {
    if (emptyEl) emptyEl.style.display = "none";
    return;
  }
  if (presencePlayers.length === 0) {
    if (emptyEl) emptyEl.style.display = "block";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  const inRoom = presenceIsInRoom();
  presencePlayers.forEach(function (p) {
    const li = document.createElement("li");
    li.className = "presence-player";
    const img = document.createElement("img");
    img.className = "presence-avatar";
    img.src = p.photoURL || "";
    img.alt = "";
    img.style.display = p.photoURL ? "block" : "none";
    const name = document.createElement("span");
    name.className = "presence-name";
    name.textContent = p.displayName || "玩家";
    const badge = document.createElement("span");
    const busy = !!p.inGame;
    badge.className = "presence-status " + (busy ? "busy" : "free");
    badge.textContent = busy ? "對戰中" : "有空";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wood-btn auth-btn small-btn presence-invite-btn";
    btn.textContent = "邀請對戰";
    // 對戰中的人、自己在房間裡、正在發邀請、已經邀請過這個人，都不能再邀
    btn.disabled = busy || inRoom || presenceInviteInFlight || !!presenceOutgoing;
    btn.addEventListener("click", function () { presenceSendInvite(p); });
    li.appendChild(img);
    li.appendChild(name);
    li.appendChild(badge);
    li.appendChild(btn);
    listEl.appendChild(li);
  });
}

// ---------- 邀請：發出 ----------
async function presenceSendInvite(target) {
  const WD = presenceGetWD();
  if (!WD || !presenceMyUid) return;
  if (presenceInviteInFlight || presenceOutgoing) return; // 同時只能發一筆邀請
  if (!target || target.uid === presenceMyUid) return; // 不能邀請自己
  if (target.inGame) return; // 不能邀請對戰中的人
  if (presenceIsInRoom()) return; // 自己在房間裡就不能邀請
  if (typeof WD.createRoom !== "function" || typeof WD.sendInvite !== "function") return;
  // online.js 沒載入就沒辦法接手房間
  if (typeof onlineSubscribe !== "function" || typeof onlineStartHeartbeat !== "function") return;
  presenceInviteInFlight = true;
  presenceRenderList();
  try {
    // 1. 先建房間（我是 p1、waiting）
    const code = await WD.createRoom();
    // 2. 寫一筆 pending 邀請給對方
    const inviteId = await WD.sendInvite(target.uid, code);
    // 3. 把房間交給 online.js：設定全域狀態、訂閱、開始心跳、顯示等待畫面
    //    （與 onlineCreateRoomFlow 的成功分支相同）
    onlineRoomCode = code;
    onlineMySlot = "p1";
    onlineResetFlags();
    gameMode = "ONLINE";
    onlineSubscribe(code);
    onlineStartHeartbeat();
    presenceMarkInGame(true);
    presenceShowEl(presenceEl("online-setup"), false);
    presenceShowEl(presenceEl("online-waiting"), true);
    onlineRenderWaiting(null);
    // 4. 記錄這筆發出的邀請：監聽對方接受／拒絕、60 秒逾時
    presenceOutgoing = {
      inviteId: inviteId,
      toUid: target.uid,
      toName: target.displayName || "玩家",
      roomCode: code,
      timer: null,
      unsubscribe: null,
    };
    presenceRenderInviteWaiting();
    if (typeof WD.subscribeInvite === "function") {
      presenceOutgoing.unsubscribe = WD.subscribeInvite(inviteId, presenceOnOutgoingInviteUpdate);
    }
    presenceOutgoing.timer = setTimeout(function () { presenceExpireOutgoing(); }, INVITE_TIMEOUT_MS);
  } catch (err) {
    console.error("[WDPresence] 邀請失敗", err);
    if (typeof alert === "function") alert("邀請失敗，請再試一次。");
  } finally {
    presenceInviteInFlight = false;
    presenceRenderList();
  }
}

// 邀請人等回覆的畫面（在線上玩家面板裡）
function presenceRenderInviteWaiting() {
  const box = presenceEl("online-invite-waiting");
  if (!box) return;
  if (!presenceOutgoing) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  const text = presenceEl("online-invite-waiting-text");
  if (text) {
    text.textContent = "已邀請 " + presenceOutgoing.toName + "，等待回覆…（60 秒內沒回覆會自動取消）";
  }
}

function presenceClearOutgoing() {
  if (!presenceOutgoing) return;
  if (presenceOutgoing.timer) { clearTimeout(presenceOutgoing.timer); presenceOutgoing.timer = null; }
  if (presenceOutgoing.unsubscribe) { presenceOutgoing.unsubscribe(); presenceOutgoing.unsubscribe = null; }
  presenceOutgoing = null;
  presenceRenderInviteWaiting();
}

// 邀請人收到的邀請狀態變化（接受／拒絕）
function presenceOnOutgoingInviteUpdate(data) {
  if (!presenceOutgoing) return;
  if (!data) return; // 文件被刪了（不應該發生）
  if (data.status === "accepted") {
    // 對方接受了：房間快照會推進開局，這裡只要清掉等待畫面
    presenceClearOutgoing();
    presenceRenderList();
  } else if (data.status === "declined") {
    presenceEndInviteRoom("對方拒絕了邀請。");
  }
  // pending：繼續等；cancelled / expired 由我方處理，不會走到這裡
}

// 邀請沒成：刪房間、回主畫面、顯示原因
function presenceEndInviteRoom(msg) {
  presenceClearOutgoing();
  if (typeof onlineLeaveRoomFlow === "function") onlineLeaveRoomFlow();
  if (msg) {
    if (typeof onlineSetError === "function") onlineSetError(msg);
    else if (typeof alert === "function") alert(msg);
  }
  presenceRenderList();
}

// 邀請人這邊 60 秒逾時
async function presenceExpireOutgoing() {
  if (!presenceOutgoing) return;
  const WD = presenceGetWD();
  const out = presenceOutgoing;
  try {
    if (WD && typeof WD.getInvite === "function") {
      const inv = await WD.getInvite(out.inviteId);
      if (!inv || inv.status !== "pending") {
        // 對方剛好在同一刻接受／拒絕了，不用過期；清掉等待狀態就好
        presenceClearOutgoing();
        presenceRenderList();
        return;
      }
    }
    if (WD && typeof WD.expireInvite === "function") await WD.expireInvite(out.inviteId);
  } catch (err) {
    console.error("[WDPresence] 邀請過期寫入失敗", err);
  }
  presenceEndInviteRoom("邀請已過期（對方 60 秒內沒有回覆）。");
}

// 邀請人取消邀請
async function presenceCancelOutgoing() {
  if (!presenceOutgoing) return;
  const WD = presenceGetWD();
  const out = presenceOutgoing;
  let stillPending = true;
  try {
    if (WD && typeof WD.getInvite === "function") {
      const inv = await WD.getInvite(out.inviteId);
      if (!inv || inv.status !== "pending") stillPending = false;
    }
  } catch (err) {}
  presenceClearOutgoing();
  if (!stillPending) {
    // 對方剛好接受了，不取消房間
    presenceRenderList();
    return;
  }
  try {
    if (WD && typeof WD.cancelInvite === "function") await WD.cancelInvite(out.inviteId);
  } catch (err) {
    console.error("[WDPresence] 取消邀請失敗", err);
  }
  if (typeof onlineLeaveRoomFlow === "function") onlineLeaveRoomFlow();
  presenceRenderList();
}

// ---------- 邀請：收到 ----------
// 監聽寄給我的待回覆邀請（docChanges：added / modified / removed）
// 注意：firebase.js 的訂閱只用 toUid 一個條件，status 在這裡過濾，
// 所以非 pending 的變化（接受／拒絕／取消／過期）也會送進來，要自己擋掉。
function presenceOnInviteChanges(changes) {
  console.log("[WDPresence] 收到邀請變化：", (changes || []).length, "筆");
  (changes || []).forEach(function (ch) {
    if (ch.type === "removed") {
      presenceRemoveIncoming(ch.id);
    } else if (ch.type === "added" || ch.type === "modified") {
      const data = ch.data || {};
      if (data.status === "pending") {
        console.log("[WDPresence] 收到待回覆邀請：", ch.id, "來自", data.fromName || "玩家");
        presenceAddIncoming(ch.id, data);
      } else presenceRemoveIncoming(ch.id);
    }
  });
  presenceRenderIncoming();
}

function presenceAddIncoming(id, data) {
  presenceIncoming[id] = data;
  if (!presenceIncomingTimers[id]) {
    presenceIncomingTimers[id] = setTimeout(function () { presenceExpireIncoming(id); }, INVITE_TIMEOUT_MS);
  }
}

function presenceRemoveIncoming(id) {
  delete presenceIncoming[id];
  if (presenceIncomingTimers[id]) {
    clearTimeout(presenceIncomingTimers[id]);
    delete presenceIncomingTimers[id];
  }
}

// 我這邊 60 秒沒回：把邀請標成過期、卡片消失（邀請人那邊的計時器也會處理）
async function presenceExpireIncoming(id) {
  const WD = presenceGetWD();
  presenceRemoveIncoming(id);
  presenceRenderIncoming();
  try {
    if (WD && typeof WD.getInvite === "function") {
      const inv = await WD.getInvite(id);
      if (inv && inv.status === "pending" && typeof WD.expireInvite === "function") {
        await WD.expireInvite(id);
      }
    }
  } catch (err) {}
}

// 接受邀請：回覆 accepted，然後加入那間房（p2），沿用原本的加入流程
async function presenceAcceptInvite(id) {
  const inv = presenceIncoming[id];
  if (!inv) return;
  const WD = presenceGetWD();
  presenceRemoveIncoming(id);
  presenceRenderIncoming();
  try {
    if (WD && typeof WD.respondInvite === "function") await WD.respondInvite(id, true);
  } catch (err) {
    console.error("[WDPresence] 接受邀請失敗", err);
  }
  if (typeof onlineJoinRoomFlow === "function") {
    onlineJoinRoomFlow(inv.roomCode);
    // 加入是異步的（要等 Firestore 交易回來才算進房）：每 500ms 看一次，
    // 一進房就馬上把 inGame 設 true，不用等 2 秒的房間檢查（否則這段空窗會被別人邀請）
    presenceWaitForRoomAndMarkInGame();
  } else if (typeof onlineOpenOnlinePanel === "function") {
    onlineOpenOnlinePanel();
  }
}

// 接受邀請後快速把 inGame 設 true：每 500ms 檢查是否已進房，最多等 5 秒
function presenceWaitForRoomAndMarkInGame() {
  let tries = 0;
  const timer = setInterval(function () {
    tries++;
    if (presenceIsInRoom()) {
      clearInterval(timer);
      presenceMarkInGame(true);
    } else if (tries >= 10) {
      clearInterval(timer);
    }
  }, 500);
}

// 拒絕邀請：回覆 declined，邀請人那邊會收到通知、房間刪除
async function presenceDeclineInvite(id) {
  presenceRemoveIncoming(id);
  presenceRenderIncoming();
  const WD = presenceGetWD();
  try {
    if (WD && typeof WD.respondInvite === "function") await WD.respondInvite(id, false);
  } catch (err) {
    console.error("[WDPresence] 拒絕邀請失敗", err);
  }
}

// 收到的邀請卡片（全域浮層，任何畫面都看得到，一筆邀請一張卡片）
function presenceRenderIncoming() {
  const box = presenceEl("online-invite-cards");
  if (!box) return;
  box.innerHTML = "";
  const ids = Object.keys(presenceIncoming);
  if (ids.length === 0) {
    box.style.display = "none";
    return;
  }
  console.log("[WDPresence] 顯示邀請卡片：", ids.length, "張");
  box.style.display = "block";
  ids.forEach(function (id) {
    const inv = presenceIncoming[id];
    const card = document.createElement("div");
    card.className = "invite-card";
    const img = document.createElement("img");
    img.className = "invite-avatar";
    img.src = inv.fromPhoto || "";
    img.alt = "";
    img.style.display = inv.fromPhoto ? "block" : "none";
    const text = document.createElement("span");
    text.className = "invite-text";
    text.textContent = (inv.fromName || "玩家") + " 邀請你對戰！";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "wood-btn auth-btn small-btn invite-accept-btn";
    accept.textContent = "接受";
    accept.addEventListener("click", function () { presenceAcceptInvite(id); });
    const decline = document.createElement("button");
    decline.type = "button";
    decline.className = "wood-btn auth-btn small-btn invite-decline-btn";
    decline.textContent = "拒絕";
    decline.addEventListener("click", function () { presenceDeclineInvite(id); });
    card.appendChild(img);
    card.appendChild(text);
    card.appendChild(accept);
    card.appendChild(decline);
    box.appendChild(card);
  });
}

// ---------- 登入狀態改變（firebase.js 的 onAuthStateChanged 呼叫） ----------
function presenceStopAll() {
  if (presenceHeartbeatTimer) { clearInterval(presenceHeartbeatTimer); presenceHeartbeatTimer = null; }
  if (presenceUnsubscribe) { presenceUnsubscribe(); presenceUnsubscribe = null; }
  if (presenceInvitesUnsubscribe) { presenceInvitesUnsubscribe(); presenceInvitesUnsubscribe = null; }
  Object.keys(presenceIncomingTimers).forEach(function (id) { clearTimeout(presenceIncomingTimers[id]); });
  presenceIncomingTimers = {};
  presenceIncoming = {};
  if (presenceOutgoing) presenceClearOutgoing();
  presencePlayers = [];
  presenceInGame = false;
}

function presenceOnAuthChanged(user) {
  presenceStopAll();
  if (!user) {
    presenceMyUid = null;
    presenceRenderList();
    presenceRenderIncoming();
    return;
  }
  presenceMyUid = user.uid;
  const WD = presenceGetWD();
  if (WD && typeof WD.setPresenceOnline === "function") WD.setPresenceOnline();
  presenceInGame = presenceIsInRoom();
  presenceHeartbeatTimer = setInterval(presenceHeartbeatTick, PRESENCE_HEARTBEAT_MS);
  if (WD && typeof WD.subscribePresence === "function") {
    presenceUnsubscribe = WD.subscribePresence(presenceOnPresenceSnapshot);
  }
  if (WD && typeof WD.subscribeInvitesToMe === "function") {
    console.log("[WDPresence] 訂閱收到的邀請，uid =", user.uid);
    presenceInvitesUnsubscribe = WD.subscribeInvitesToMe(user.uid, presenceOnInviteChanges);
  }
  presenceRenderList();
  presenceRenderIncoming();
}

// ---------- 綁定 UI（script 在 body 尾端，DOM 已經有了） ----------
function presenceBindUI() {
  const cancelBtn = presenceEl("online-invite-cancel-btn");
  if (cancelBtn) {
    cancelBtn.addEventListener("click", function (e) {
      if (e && e.target && e.target.blur) e.target.blur();
      presenceCancelOutgoing();
    });
  }
}
presenceBindUI();
presenceRenderList();
presenceRenderIncoming();

// 每 5 秒檢查一次是否進出房間（同步 inGame 給列表看）
presenceRoomWatchTimer = setInterval(presenceRoomWatchTick, PRESENCE_ROOM_WATCH_MS);

// 關掉頁面時盡量清掉在線狀態（不一定送得到，60 秒過期兜底）
window.addEventListener("pagehide", function () {
  const WD = presenceGetWD();
  if (WD && presenceMyUid && typeof WD.removePresence === "function") {
    try { WD.removePresence(); } catch (e) {}
  }
});

// 暴露給 firebase.js（onAuthStateChanged 呼叫）與測試的介面
window.WDPresence = {
  onAuthChanged: presenceOnAuthChanged,
  renderList: presenceRenderList,
  sendInvite: presenceSendInvite,
  acceptInvite: presenceAcceptInvite,
  declineInvite: presenceDeclineInvite,
  cancelOutgoing: presenceCancelOutgoing,
  expireOutgoing: presenceExpireOutgoing,
  expireIncoming: presenceExpireIncoming,
};
