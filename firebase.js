// WOODEN DUEL — Firebase 整合（第一階段：Google 登入＋VS AI 記分＋排行榜）
// 以 ES module 載入（index.html 裡用 <script type="module" src="firebase.js">），
// 透過 window.WD 暴露介面給傳統 script 的 game.js 呼叫。
// 注意：下面的 firebaseConfig 是前端公開設定，不是密碼，公開在網頁原始碼是正常的。

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  deleteDoc,
  increment,
  serverTimestamp,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  onSnapshot,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAlnoGQ505yVmH7y7UdAuk6gr1Os7O2OWY",
  authDomain: "wooden-duel.firebaseapp.com",
  projectId: "wooden-duel",
  storageBucket: "wooden-duel.firebasestorage.app",
  messagingSenderId: "578802390661",
  appId: "1:578802390661:web:0c705cf3508f2fe304fbec",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

let currentUser = null;

function $(id) {
  return document.getElementById(id);
}

// --- 登入狀態 UI：登入後顯示頭像＋名字＋登出，未登入顯示登入按鈕 ---
function renderAuthArea() {
  const loggedOut = $("auth-logged-out");
  const loggedIn = $("auth-logged-in");
  if (!loggedOut || !loggedIn) return;
  if (currentUser) {
    loggedOut.style.display = "none";
    loggedIn.style.display = "flex";
    const avatar = $("user-avatar");
    if (avatar) {
      avatar.src = currentUser.photoURL || "";
      avatar.style.display = currentUser.photoURL ? "block" : "none";
    }
    const nameEl = $("user-name");
    if (nameEl) nameEl.textContent = currentUser.displayName || "玩家";
  } else {
    loggedOut.style.display = "block";
    loggedIn.style.display = "none";
  }
}

async function loginWithGoogle() {
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    console.error("[WD] Google 登入失敗", err);
    alert("登入失敗：" + (err && err.message ? err.message : "請再試一次"));
  }
}

async function logout() {
  try {
    await signOut(auth);
  } catch (err) {
    console.error("[WD] 登出失敗", err);
  }
}

// --- 記分：只計 VS AI（PVE），2P 本地對戰不計；未登入不計；平手不計 ---
// Firestore：collection「players」，文件 id 用 Auth uid，
// 欄位 displayName / photoURL / wins / losses / games / updatedAt，
// 用 increment 更新，第一次打完就建立文件（setDoc + merge）。
async function recordResult(playerWon) {
  if (!currentUser) return; // 未登入不記分
  try {
    const ref = doc(db, "players", currentUser.uid);
    await setDoc(
      ref,
      {
        displayName: currentUser.displayName || "玩家",
        photoURL: currentUser.photoURL || "",
        wins: increment(playerWon ? 1 : 0),
        losses: increment(playerWon ? 0 : 1),
        games: increment(1),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    // 記分完成後刷新排行榜（之後回到開始畫面就看得到新成績）
    loadLeaderboard();
  } catch (err) {
    console.error("[WD] 記分寫入失敗", err);
  }
}

// --- 排行榜：公開（不用登入也能看），依 wins 由多到少取前 10 名 ---
async function loadLeaderboard() {
  const body = $("leaderboard-body");
  const empty = $("leaderboard-empty");
  const loading = $("leaderboard-loading");
  try {
    const q = query(collection(db, "players"), orderBy("wins", "desc"), limit(10));
    const snap = await getDocs(q);
    if (loading) loading.style.display = "none";
    if (!body) return;
    body.innerHTML = "";
    if (snap.empty) {
      if (empty) empty.style.display = "block";
      return;
    }
    if (empty) empty.style.display = "none";
    let rank = 0;
    snap.forEach((d) => {
      rank += 1;
      const data = d.data() || {};
      const wins = data.wins || 0;
      const losses = data.losses || 0;
      const games = data.games || wins + losses;
      const winRate = games > 0 ? Math.round((wins / games) * 100) : 0;
      const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : String(rank);
      const isMe = currentUser && d.id === currentUser.uid;
      const tr = document.createElement("tr");
      if (isMe) tr.className = "leaderboard-me";
      const rankCell = document.createElement("td");
      rankCell.className = "lb-rank";
      rankCell.textContent = medal;
      const nameCell = document.createElement("td");
      nameCell.className = "lb-name";
      nameCell.textContent = data.displayName || "玩家";
      const winsCell = document.createElement("td");
      winsCell.textContent = String(wins);
      const lossesCell = document.createElement("td");
      lossesCell.textContent = String(losses);
      const rateCell = document.createElement("td");
      rateCell.textContent = winRate + "%";
      tr.appendChild(rankCell);
      tr.appendChild(nameCell);
      tr.appendChild(winsCell);
      tr.appendChild(lossesCell);
      tr.appendChild(rateCell);
      body.appendChild(tr);
    });
  } catch (err) {
    console.error("[WD] 排行榜讀取失敗", err);
    if (loading) loading.textContent = "排行榜載入失敗，請重新整理頁面再試。";
  }
}

// --- 線上對戰房間（第二階段）：Firestore 即時同步 ---
// Collection「rooms」，文件 id 是 6 碼房間代碼；status: waiting / playing / finished。
// 規則是所有人可讀、登入者可寫（已在 Firebase Console 發佈），所以以下寫入都需要登入。
// 同步模型：開火方在本機模擬整發流程，結束後寫入「權威結果狀態」＋開火參數（lastShot）；
// 對方用同樣的開火參數播放重播動畫，再套用權威結果（不各自算傷害，避免算出不同結果）。

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 不含 0/O/1/I，避免唸錯

function generateRoomCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

function roomPlayerInfo(user) {
  return {
    uid: user.uid,
    displayName: user.displayName || "玩家",
    photoURL: user.photoURL || "",
    lastSeen: serverTimestamp(),
  };
}

// 新一局的初始狀態（雙方固定位置、HP 100、隨機風向、p1 先攻）
function initialRoomState() {
  return {
    turn: "p1",
    round: 1,
    wind: parseFloat((Math.random() * 10 - 5).toFixed(1)),
    p1: { x: 260, y: 335, hp: 100, angle: -45, fuel: 100, weapon: 1, doubleUses: 2, useDouble: false, isFalling: false },
    p2: { x: 764, y: 335, hp: 100, angle: -135, fuel: 100, weapon: 1, doubleUses: 2, useDouble: false, isFalling: false },
    holes: [],
  };
}

async function createRoom() {
  if (!currentUser) throw new Error("NEED_LOGIN");
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateRoomCode();
    const ref = doc(db, "rooms", code);
    const snap = await getDoc(ref);
    if (snap.exists()) continue; // 代碼撞了就換一個
    await setDoc(ref, {
      code,
      status: "waiting",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      rev: 1,
      players: { p1: roomPlayerInfo(currentUser), p2: null },
      state: initialRoomState(),
      lastShot: null,
      winner: null,
      leftBy: null,
    });
    return code;
  }
  throw new Error("CODE_RETRY");
}

async function joinRoom(code) {
  if (!currentUser) throw new Error("NEED_LOGIN");
  code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) throw new Error("BAD_CODE");
  const ref = doc(db, "rooms", code);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("ROOM_NOT_FOUND");
    const data = snap.data();
    if (data.status === "finished") throw new Error("ROOM_FINISHED");
    if ((data.players && data.players.p2) || data.status !== "waiting") throw new Error("ROOM_FULL");
    tx.update(ref, {
      players: { p1: data.players.p1, p2: roomPlayerInfo(currentUser) },
      status: "playing",
      rev: (data.rev || 0) + 1,
      updatedAt: serverTimestamp(),
    });
  });
  return code;
}

// 重新加入自己已經在裡面的房間（例如重整頁面後回來）：不佔新位置，只清掉自己的離開標記
async function rejoinRoom(code) {
  if (!currentUser) throw new Error("NEED_LOGIN");
  code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ref = doc(db, "rooms", code);
  const snap = await getDoc(ref);
  if (!snap.exists()) throw new Error("ROOM_NOT_FOUND");
  const data = snap.data();
  let slot = null;
  if (data.players && data.players.p1 && data.players.p1.uid === currentUser.uid) slot = "p1";
  else if (data.players && data.players.p2 && data.players.p2.uid === currentUser.uid) slot = "p2";
  if (!slot) throw new Error("NOT_IN_ROOM");
  const patch = { updatedAt: serverTimestamp() };
  if (data.leftBy === slot) patch.leftBy = null;
  await updateDoc(ref, patch);
  return slot;
}

// 即時監聽房間文件；文件被刪除時回傳 null
function subscribeRoom(code, onUpdate) {
  const ref = doc(db, "rooms", code);
  return onSnapshot(
    ref,
    (snap) => { onUpdate(snap.exists() ? snap.data() : null); },
    (err) => { console.error("[WD] 房間監聽失敗", err); }
  );
}

// 開火參數（對方收到後播放重播動畫）
async function sendShot(code, shot) {
  const ref = doc(db, "rooms", code);
  await updateDoc(ref, {
    lastShot: Object.assign({}, shot, { at: serverTimestamp() }),
    updatedAt: serverTimestamp(),
  });
}

// 回合結束後的權威結果狀態（rev 由呼叫方遞增）
async function sendState(code, state, rev) {
  const ref = doc(db, "rooms", code);
  await updateDoc(ref, { state, rev, updatedAt: serverTimestamp() });
}

// 終局（winner: 'p1' / 'p2' / 'draw'）
async function finishRoom(code, winner, state, rev) {
  const ref = doc(db, "rooms", code);
  await updateDoc(ref, { status: "finished", winner, state, rev, updatedAt: serverTimestamp() });
}

// 再來一場：重置成新一局（雙方都要在房間裡才有效，由呼叫方確認）
async function rematchRoom(code, state, rev) {
  const ref = doc(db, "rooms", code);
  await updateDoc(ref, { status: "playing", winner: null, lastShot: null, leftBy: null, state, rev, updatedAt: serverTimestamp() });
}

// 離開房間：對方已經離開（或等待中根本沒人加入）→ 房間直接刪除，否則只標記我離開
async function leaveRoom(code, slot) {
  const ref = doc(db, "rooms", code);
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const other = slot === "p1" ? "p2" : "p1";
    if (data.leftBy === other || (slot === "p1" && !data.players.p2)) {
      await deleteDoc(ref);
      return;
    }
    await updateDoc(ref, { leftBy: slot, updatedAt: serverTimestamp() });
  } catch (err) {
    console.error("[WD] 離開房間寫入失敗", err);
  }
}

// 心跳：讓對方知道我還在（關掉頁面就停了，對方 60 秒沒收到就視為離開）
async function heartbeatRoom(code, slot) {
  if (!code || !slot) return;
  try {
    const ref = doc(db, "rooms", code);
    const patch = { updatedAt: serverTimestamp() };
    patch["players." + slot + ".lastSeen"] = serverTimestamp();
    await updateDoc(ref, patch);
  } catch (err) {
    // 心跳失敗不影響遊戲（對方頂多晚一點才知道我離開）
  }
}

// --- 綁定按鈕與監聽登入狀態（onAuthStateChanged 載入時就會觸發一次） ---
const loginBtn = $("google-login-btn");
if (loginBtn) loginBtn.addEventListener("click", loginWithGoogle);
const logoutBtn = $("logout-btn");
if (logoutBtn) logoutBtn.addEventListener("click", logout);

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  renderAuthArea();
  loadLeaderboard(); // 登入狀態改變後刷新排行榜（自己的那一行會標示出來）
});

// 暴露給 game.js（傳統 script）呼叫的介面
window.WD = {
  loginWithGoogle,
  logout,
  recordResult,
  loadLeaderboard,
  getCurrentUser: () => currentUser,
  // 線上對戰房間（第二階段）
  generateRoomCode,
  initialRoomState,
  createRoom,
  joinRoom,
  rejoinRoom,
  subscribeRoom,
  sendShot,
  sendState,
  finishRoom,
  rematchRoom,
  leaveRoom,
  heartbeatRoom,
};
