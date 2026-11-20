// WOODEN DUEL — 線上對戰留言列（文字聊天）：只有線上對戰的遊戲畫面才顯示。
// 遊戲下方一行（正常排版，不是浮層，永遠不蓋住畫布、HUD 或按鈕）：
// 顯示最新一則留言，左右滑動（觸控滑動＋滑鼠拖曳）往回看舊留言，
// 點一下展開輸入列打字。留言走 window.WD（firebase.js 模組）的 chatMessages collection。
// 注意：本檔不用 IIFE，所有識別字都加 chat 前綴，避免與 game.js／online.js 全域變數撞名。

const CHAT_MAX_LEN = 200; // 單則最多 200 字
const CHAT_LIMIT = 50; // 只顯示最近 50 則
const CHAT_SWIPE_MIN = 30; // 滑動判定距離（px）
const CHAT_TAP_MAX = 10; // 點按判定：移動小於這個距離才算點按

let chatRoomCode = null;
let chatUnsubscribe = null;
let chatMessages = []; // 最近的留言（已按時間排序，舊→新）
let chatFollowing = true; // true＝顯示最新一則；false＝正在往回看舊留言
let chatViewIndex = -1; // 正在看的那則在 chatMessages 裡的位置（following 時不用）
let chatHasNew = false; // 正在看舊留言時，對方傳了新留言

function chatEl(id) { return document.getElementById(id); }
function chatGetWD() {
  return (typeof window !== "undefined" && window.WD) ? window.WD : null;
}
function chatGetMyUid() {
  const WD = chatGetWD();
  const user = WD && typeof WD.getCurrentUser === "function" ? WD.getCurrentUser() : null;
  return user ? user.uid : null;
}

// 進入線上房間的遊戲畫面：訂閱這個房間的留言、顯示留言列
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

// 離開房間：取消訂閱、清空留言、收起輸入列與留言列
function chatLeaveRoom() {
  if (chatUnsubscribe) { try { chatUnsubscribe(); } catch (e) {} chatUnsubscribe = null; }
  chatRoomCode = null;
  chatMessages = [];
  chatFollowing = true;
  chatViewIndex = -1;
  chatHasNew = false;
  chatRenderStrip();
  chatShowInput(false);
  chatSetVisible(false);
}

// 收到留言列表：照時間排序後顯示最新一則（除非正在往回看舊留言）
function chatOnMessages(list) {
  const prevLast = chatMessages.length ? chatMessages[chatMessages.length - 1] : null;
  chatMessages = (list || []).slice();
  const last = chatMessages.length ? chatMessages[chatMessages.length - 1] : null;
  const myUid = chatGetMyUid();
  if (!last) {
    chatFollowing = true;
    chatHasNew = false;
  } else if (!prevLast || last.id !== prevLast.id) {
    // 有新留言進來
    if (last.uid && last.uid === myUid) { chatFollowing = true; chatHasNew = false; }
    else if (!chatFollowing) { chatHasNew = true; }
    else { chatHasNew = false; }
  }
  chatRenderStrip();
}

// 顯示目前這一則（最新或正在看的舊留言）
function chatRenderStrip() {
  const textEl = chatEl("chat-strip-text");
  const posEl = chatEl("chat-strip-pos");
  const dotEl = chatEl("chat-strip-new-dot");
  if (!textEl) return;
  if (!chatMessages.length) {
    textEl.textContent = "💬 還沒有留言，點一下開始聊";
    textEl.classList.add("chat-strip-empty");
    if (posEl) posEl.textContent = "";
    if (dotEl) dotEl.style.display = "none";
    return;
  }
  textEl.classList.remove("chat-strip-empty");
  const idx = chatFollowing ? chatMessages.length - 1 : Math.min(chatViewIndex, chatMessages.length - 1);
  const m = chatMessages[idx];
  textEl.textContent = (m.displayName || "玩家") + "：" + (m.text || "");
  if (posEl) posEl.textContent = chatFollowing ? "最新" : ((idx + 1) + " / " + chatMessages.length);
  if (dotEl) dotEl.style.display = chatHasNew ? "" : "none";
}

// 往回看舊留言（左滑或 ← 鍵）
function chatBrowseOlder() {
  if (!chatMessages.length) return;
  if (chatFollowing) { chatViewIndex = chatMessages.length - 2; chatFollowing = false; }
  else { chatViewIndex = Math.max(0, chatViewIndex - 1); }
  if (chatViewIndex < 0) chatViewIndex = 0;
  chatRenderStrip();
}

// 往新留言看（右滑或 → 鍵），看到最新就回到跟隨
function chatBrowseNewer() {
  if (!chatMessages.length || chatFollowing) return;
  chatViewIndex = Math.min(chatMessages.length - 1, chatViewIndex + 1);
  if (chatViewIndex >= chatMessages.length - 1) { chatFollowing = true; chatHasNew = false; }
  chatRenderStrip();
}

// 跳回最新一則
function chatJumpToLatest() {
  if (!chatMessages.length) return;
  chatFollowing = true;
  chatHasNew = false;
  chatRenderStrip();
}

// 送出留言：空白不送、超過 200 字截斷、Enter 也能送
function chatSend() {
  const input = chatEl("chat-input");
  const WD = chatGetWD();
  if (!input || !WD || !chatRoomCode || typeof WD.sendChatMessage !== "function") return;
  const text = String(input.value || "").trim().slice(0, CHAT_MAX_LEN);
  if (!text) return;
  chatFollowing = true;
  chatHasNew = false;
  WD.sendChatMessage(chatRoomCode, text).then(function () {
    input.value = "";
    chatShowInput(false);
  }).catch(function (err) {
    console.error("[WDChat] 留言送出失敗", err);
  });
}

function chatShowInput(show) {
  const row = chatEl("chat-strip-input-row");
  if (!row) return;
  row.style.display = show ? "flex" : "none";
  if (show) {
    const input = chatEl("chat-input");
    if (input) input.focus();
  }
}

function chatSetVisible(show) {
  const strip = chatEl("chat-strip");
  if (strip) strip.style.display = show ? "" : "none";
  if (!show) chatShowInput(false);
}

function chatBindUI() {
  const view = chatEl("chat-strip-view");
  if (view) {
    let startX = null;
    let moved = false;
    view.addEventListener("pointerdown", function (e) {
      startX = (e && typeof e.clientX === "number") ? e.clientX : 0;
      moved = false;
      if (view.setPointerCapture && e && e.pointerId !== undefined) {
        try { view.setPointerCapture(e.pointerId); } catch (err) {}
      }
    });
    view.addEventListener("pointermove", function (e) {
      if (startX === null) return;
      const x = (e && typeof e.clientX === "number") ? e.clientX : 0;
      if (Math.abs(x - startX) > CHAT_TAP_MAX) moved = true;
    });
    view.addEventListener("pointerup", function (e) {
      if (startX === null) return;
      const x = (e && typeof e.clientX === "number") ? e.clientX : 0;
      const dx = x - startX;
      startX = null;
      // 點到「● 新留言」：跳回最新，不開輸入列
      if (e && e.target && e.target.id === "chat-strip-new-dot") return;
      if (moved && dx < -CHAT_SWIPE_MIN) { chatBrowseOlder(); return; }
      if (moved && dx > CHAT_SWIPE_MIN) { chatBrowseNewer(); return; }
      if (!moved) {
        const row = chatEl("chat-strip-input-row");
        chatShowInput(!row || row.style.display !== "flex");
      }
    });
    view.addEventListener("pointercancel", function () { startX = null; moved = false; });
    view.addEventListener("keydown", function (e) {
      if (!e) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); chatBrowseOlder(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); chatBrowseNewer(); }
      else if (e.key === "Enter") { e.preventDefault(); chatShowInput(true); }
    });
  }
  const dot = chatEl("chat-strip-new-dot");
  if (dot) dot.addEventListener("click", function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    chatJumpToLatest();
  });
  const composeBtn = chatEl("chat-strip-compose-btn");
  if (composeBtn) composeBtn.addEventListener("click", function (e) {
    if (e && e.target && e.target.blur) e.target.blur();
    const row = chatEl("chat-strip-input-row");
    chatShowInput(!row || row.style.display !== "flex");
  });
  const sendBtn = chatEl("chat-send-btn");
  if (sendBtn) sendBtn.addEventListener("click", function (e) { if (e && e.target && e.target.blur) e.target.blur(); chatSend(); });
  const input = chatEl("chat-input");
  if (input) input.addEventListener("keydown", function (e) {
    if (!e) return;
    if (e.key === "Enter") { e.preventDefault(); chatSend(); }
    else if (e.key === "Escape") { e.preventDefault(); chatShowInput(false); input.blur(); }
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
  getState: function () {
    return {
      following: chatFollowing,
      viewIndex: chatViewIndex,
      hasNew: chatHasNew,
      count: chatMessages.length,
    };
  },
};
