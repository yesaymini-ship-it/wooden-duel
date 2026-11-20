// WOODEN DUEL — 線上對戰留言板（文字聊天）：只有線上對戰的遊戲畫面才顯示。
// 經典 script（index.html 裡 <script src="chat.js">，載在 online.js 之後），
// 留言走 window.WD（firebase.js 模組）的 chatMessages collection（頂層，欄位 roomCode）。
// 注意：本檔不用 IIFE，所有識別字都加 chat 前綴，避免與 game.js／online.js 全域變數撞名。

const CHAT_MAX_LEN = 200; // 單則最多 200 字
const CHAT_LIMIT = 50; // 只顯示最近 50 則

let chatRoomCode = null;
let chatUnsubscribe = null;
let chatMessages = []; // 最近顯示的留言（已按時間排序）

function chatEl(id) { return document.getElementById(id); }
function chatGetWD() {
  return (typeof window !== "undefined" && window.WD) ? window.WD : null;
}
function chatGetMyUid() {
  const WD = chatGetWD();
  const user = WD && typeof WD.getCurrentUser === "function" ? WD.getCurrentUser() : null;
  return user ? user.uid : null;
}

// 進入線上房間的遊戲畫面：訂閱這個房間的留言、顯示留言按鈕
function chatEnterRoom(code) {
  if (!code) return;
  if (chatRoomCode === code && chatUnsubscribe) { chatSetVisible(true); return; }
  chatLeaveRoom();
  chatRoomCode = code;
  const WD = chatGetWD();
  if (WD && typeof WD.subscribeChatMessages === "function") {
    chatUnsubscribe = WD.subscribeChatMessages(code, chatOnMessages);
  }
  chatSetVisible(true);
}

// 離開房間：取消訂閱、清空留言、收起面板與按鈕
function chatLeaveRoom() {
  if (chatUnsubscribe) { try { chatUnsubscribe(); } catch (e) {} chatUnsubscribe = null; }
  chatRoomCode = null;
  chatMessages = [];
  chatRenderMessages();
  chatShowPanel(false);
  chatSetVisible(false);
}

// 收到留言列表：照時間排序後顯示，收到新訊息自動捲到最下面
function chatOnMessages(list) {
  chatMessages = (list || []).slice();
  const panel = chatEl("chat-panel");
  const wasClosed = !panel || panel.style.display === "none";
  const myUid = chatGetMyUid();
  const last = chatMessages[chatMessages.length - 1];
  chatRenderMessages();
  // 面板關著時收到對方的新留言：按鈕亮金邊提醒
  if (wasClosed && last && last.uid && last.uid !== myUid) {
    const btn = chatEl("chat-toggle-btn");
    if (btn) btn.classList.add("chat-has-new");
  }
}

function chatRenderMessages() {
  const listEl = chatEl("chat-list");
  if (!listEl) return;
  listEl.innerHTML = "";
  const myUid = chatGetMyUid();
  chatMessages.forEach(function (m) {
    const row = document.createElement("div");
    row.className = "chat-msg" + (m.uid && m.uid === myUid ? " chat-mine" : "");
    const name = document.createElement("span");
    name.className = "chat-name";
    name.textContent = (m.displayName || "玩家") + "：";
    const text = document.createElement("span");
    text.className = "chat-text";
    text.textContent = m.text || "";
    row.appendChild(name);
    row.appendChild(text);
    listEl.appendChild(row);
  });
  try { listEl.scrollTop = listEl.scrollHeight; } catch (e) {}
}

// 送出留言：空白不送、超過 200 字截斷、Enter 也能送
function chatSend() {
  const input = chatEl("chat-input");
  const WD = chatGetWD();
  if (!input || !WD || !chatRoomCode || typeof WD.sendChatMessage !== "function") return;
  const text = String(input.value || "").trim().slice(0, CHAT_MAX_LEN);
  if (!text) return;
  WD.sendChatMessage(chatRoomCode, text).then(function () {
    input.value = "";
  }).catch(function (err) {
    console.error("[WDChat] 留言送出失敗", err);
  });
}

function chatShowPanel(show) {
  const panel = chatEl("chat-panel");
  if (!panel) return;
  panel.style.display = show ? "flex" : "none";
  if (show) {
    const btn = chatEl("chat-toggle-btn");
    if (btn) btn.classList.remove("chat-has-new");
    const listEl = chatEl("chat-list");
    try { if (listEl) listEl.scrollTop = listEl.scrollHeight; } catch (e) {}
  }
}

function chatSetVisible(show) {
  const btn = chatEl("chat-toggle-btn");
  if (btn) btn.style.display = show ? "" : "none";
  if (!show) chatShowPanel(false);
}

function chatBindUI() {
  const toggle = chatEl("chat-toggle-btn");
  if (toggle) toggle.addEventListener("click", function (e) {
    e.target.blur();
    const panel = chatEl("chat-panel");
    chatShowPanel(!panel || panel.style.display === "none");
  });
  const closeBtn = chatEl("chat-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", function (e) { e.target.blur(); chatShowPanel(false); });
  const sendBtn = chatEl("chat-send-btn");
  if (sendBtn) sendBtn.addEventListener("click", function (e) { e.target.blur(); chatSend(); });
  const input = chatEl("chat-input");
  if (input) input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); chatSend(); }
  });
}
chatBindUI();

// 暴露給 online.js 呼叫的介面（與測試用）
window.WDChat = {
  enterRoom: chatEnterRoom,
  leaveRoom: chatLeaveRoom,
  send: chatSend,
  setVisible: chatSetVisible,
  getMessages: function () { return chatMessages; },
};
