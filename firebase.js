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
  increment,
  serverTimestamp,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
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
};
