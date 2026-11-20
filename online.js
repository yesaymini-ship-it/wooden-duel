// WOODEN DUEL — 線上對戰（第二階段）：開房間邀朋友，用 Firestore 即時同步
// 經典 script（index.html 裡 <script src="online.js">，載在 game.js 之後），
// 房間操作走 window.WD（firebase.js 模組），遊戲狀態直接讀寫 game.js 的全域變數。
// 同步模型：開火方在本機模擬整發流程，結束後寫入權威結果狀態＋開火參數（lastShot）；
// 對方用同樣的開火參數預算軌跡、播放重播動畫，再套用權威結果（不各自算傷害）。
// 注意：本檔不用 IIFE（與 game.js 同風格），所有識別字都加 online 前綴，避免與 game.js 全域變數撞名。

// ---------- 小工具 ----------
function onlineEl(id) { return document.getElementById(id); }
function onlineShowEl(el, show) { if (el) el.style.display = show ? "" : "none"; }
function onlineClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function onlineDist(x1, y1, x2, y2) {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}
function onlineGetWD() {
  return (typeof window !== "undefined" && window.WD) ? window.WD : null;
}

// ---------- 線上狀態 ----------
let onlineRoomCode = null;
let onlineMySlot = null; // 'p1' | 'p2'
let onlineUnsubscribe = null;
let onlineRoomData = null; // 快取的房間文件
let onlineLastAppliedRev = 0;
let onlinePendingState = null; // 已收到、等重播播完才套用的權威狀態 { rev, status, state, winner }
let onlinePendingStateTimer = null;
let onlineScoreRecordedRev = 0; // 已經記過分的 finished rev（每人只記一次）
let onlineSawPlaying = false; // 這次連線有看過 playing（重整後直接看到 finished 不記分）
let onlineHeartbeatTimer = null;
let onlineStaleCheckTimer = null;
let onlinePendingJoinCode = null; // URL ?room= 帶來的待加入房間
let onlineAutoJoinTimer = null;
let onlineShotCounter = 0;
let onlineReplayQueue = [];
let onlineReplay = null; // { points, idx, elapsed, landing, weaponType, shotId }
let onlineReplayLastTick = 0;
let onlineLastReplayedShotId = null;
let onlineOpponentLeftShown = false;
let onlinePoseSeq = 0; // 本機發出的姿態序號（每發一次 +1）
let onlineLastSentPose = null; // 上次發出的姿態（不含 seq/at）
let onlineLastPoseSentAt = 0; // 上次發出的時間（Date.now）
let onlinePoseTrailingTimer = null; // 收尾發送的計時器
let onlineAppliedPose = { p1: { seq: 0, at: 0 }, p2: { seq: 0, at: 0 } }; // 對方姿態已套用的最新序號／時間
const ONLINE_POSE_THROTTLE_MS = 150; // 姿態寫入節流：最多每 150ms 寫一次

function onlineMySlotNum() { return onlineMySlot === "p2" ? 2 : 1; }
function onlineOtherSlot() { return onlineMySlot === "p1" ? "p2" : "p1"; }

// 等 firebase.js 模組載入（模組是 deferred，載入時間不一定）
function onlineWhenWDReady(cb) {
  if (onlineGetWD()) { cb(); return; }
  let tries = 0;
  const timer = setInterval(function () {
    tries++;
    if (onlineGetWD()) {
      clearInterval(timer);
      cb();
    } else if (tries > 75) { // 約 15 秒還沒好就放棄
      clearInterval(timer);
    }
  }, 200);
}

// ---------- 給 game.js 呼叫的介面 ----------
function onlineIsMyTurn() {
  return !!onlineRoomCode && !!onlineMySlot && !!onlineRoomData &&
    onlineRoomData.status === "playing" &&
    onlineRoomData.state && onlineRoomData.state.turn === onlineMySlot;
}

function onlineIsReplayActive() { return !!onlineReplay; }

function onlineGetOnlineNames() {
  if (!onlineRoomData || !onlineRoomData.players) return { p1: "軍隊 01", p2: "軍隊 02" };
  return {
    p1: (onlineRoomData.players.p1 && onlineRoomData.players.p1.displayName) || "軍隊 01",
    p2: (onlineRoomData.players.p2 && onlineRoomData.players.p2.displayName) || "軍隊 02",
  };
}

// game.js 的 fireProjectile 呼叫：我開火了，把參數送到房間
function onlineOnLocalShotFired(p) {
  if (!onlineRoomCode || !onlineMySlot) return;
  onlineShotCounter++;
  const shot = {
    shotId: "s" + Date.now().toString(36) + "-" + onlineShotCounter,
    by: onlineMySlot,
    fromX: Math.round(p.fromX * 10) / 10,
    fromY: Math.round(p.fromY * 10) / 10,
    angle: p.angle,
    power: Math.round(p.power * 10) / 10,
    weapon: p.weapon,
    isGuided: !!p.isGuided,
    targetX: p.targetX || 0,
    targetY: p.targetY || 0,
    wind: p.wind,
  };
  const WD = onlineGetWD();
  if (WD && typeof WD.sendShot === "function") {
    WD.sendShot(onlineRoomCode, shot).catch(function (err) {
      console.error("[WDOnline] 開火同步失敗", err);
    });
  }
}

// game.js 的 startTurnSwitch 呼叫（線上模式）：我這發模擬完了，寫入權威結果狀態
function onlineCommitTurnResult() {
  if (!onlineRoomCode || !onlineMySlot || !onlineRoomData) return;
  // 產生下一回合的風（共用原本的 generateWind，順便更新畫面）
  generateWind();
  const nextTurn = onlineOtherSlot();
  const prevState = onlineRoomData.state || {};
  const newState = {
    turn: nextTurn,
    round: nextTurn === "p1" ? (prevState.round || 1) + 1 : (prevState.round || 1),
    wind: wind,
    p1: onlineSnapshotCannon(player1),
    p2: onlineSnapshotCannon(player2),
    holes: onlineClone(bridgeHoles),
  };
  // 下一位玩家燃料回滿、取消連發選擇（與本地 startTurnSwitch 相同）
  newState[nextTurn].fuel = 100;
  newState[nextTurn].useDouble = false;
  const newRev = (onlineRoomData.rev || 0) + 1;
  const WD = onlineGetWD();
  if (WD && typeof WD.sendState === "function") {
    WD.sendState(onlineRoomCode, newState, newRev).catch(function (err) {
      console.error("[WDOnline] 回合狀態寫入失敗", err);
    });
  }
}

// game.js 的 showGameOver 呼叫（線上模式）：我這邊判定勝負了，寫入終局（不記分，記分由快照統一做）
function onlineOnLocalGameOver(winnerText) {
  if (!onlineRoomCode || !onlineMySlot || !onlineRoomData) return;
  let winner = "draw";
  if (winnerText === "PLAYER 1 獲勝") winner = "p1";
  else if (winnerText === "PLAYER 2 獲勝") winner = "p2";
  const prevState = onlineRoomData.state || {};
  const finalState = {
    turn: prevState.turn || "p1",
    round: prevState.round || 1,
    wind: wind,
    p1: onlineSnapshotCannon(player1),
    p2: onlineSnapshotCannon(player2),
    holes: onlineClone(bridgeHoles),
  };
  const newRev = (onlineRoomData.rev || 0) + 1;
  const WD = onlineGetWD();
  if (WD && typeof WD.finishRoom === "function") {
    WD.finishRoom(onlineRoomCode, winner, finalState, newRev).catch(function (err) {
      console.error("[WDOnline] 終局寫入失敗，2 秒後重試一次", err);
      setTimeout(function () {
        const WD2 = onlineGetWD();
        if (WD2 && typeof WD2.finishRoom === "function") {
          WD2.finishRoom(onlineRoomCode, winner, finalState, newRev).catch(function (e2) {
            console.error("[WDOnline] 終局寫入重試失敗", e2);
          });
        }
      }, 2000);
    });
  }
  // 立即把結算畫面換成線上版（名字＋再來一場／回主畫面），不用等快照回來
  onlineShowOnlineGameOver(winner);
}

function onlineSnapshotCannon(c) {
  return {
    x: Math.round(c.x * 10) / 10,
    y: Math.round(c.y * 10) / 10,
    hp: c.hp,
    angle: c.angle,
    fuel: Math.round(c.fuel),
    weapon: c.selectedWeapon,
    doubleUses: c.doubleUses,
    useDouble: c.useDouble,
    isFalling: !!c.isFalling,
  };
}

function onlineApplyCannon(c, s) {
  if (!s) return;
  c.x = s.x;
  c.y = s.y;
  c.hp = s.hp;
  c.angle = s.angle;
  c.fuel = s.fuel;
  c.selectedWeapon = s.weapon;
  c.doubleUses = s.doubleUses;
  c.useDouble = s.useDouble;
  c.isFalling = !!s.isFalling;
  c.fallSpeed = 0;
}

// ---------- 回合內即時姿態同步：移動／角度／武器 ----------
// 回合內移動只改本機砲台物件，不會寫進房間，所以對方看不到；
// 這裡每幀檢查自己的砲台姿態，變了就節流寫入 rooms.poses.<slot>，對方即時套用。
// 注意：姿態寫入不碰 state／rev，開火後的權威結果同步保持原樣。
function onlineBuildPose(c) {
  return {
    x: Math.round(c.x * 10) / 10,
    angle: Math.round(c.angle),
    weapon: c.selectedWeapon,
    fuel: Math.round(c.fuel),
    useDouble: !!c.useDouble,
  };
}

function onlinePoseChanged(a, b) {
  if (!a || !b) return true;
  return a.x !== b.x || a.angle !== b.angle || a.weapon !== b.weapon ||
    a.fuel !== b.fuel || a.useDouble !== b.useDouble;
}

// 每幀由 game.js 的 gameLoop 呼叫：輪到自己回合時，把姿態變化節流寫進房間
function onlineMaybeSendPose() {
  if (gameMode !== "ONLINE" || !onlineRoomCode || !onlineMySlot) return;
  if (!onlineIsMyTurn() || onlineIsReplayActive()) return;
  if (gameState !== STATES.PLAYING && gameState !== STATES.CHARGING) return;
  const me = onlineMySlot === "p2" ? player2 : player1;
  if (!me || me.isFalling) return;
  const pose = onlineBuildPose(me);
  if (!onlinePoseChanged(pose, onlineLastSentPose)) return;
  const now = Date.now();
  const weaponChanged = onlineLastSentPose &&
    (pose.weapon !== onlineLastSentPose.weapon || pose.useDouble !== onlineLastSentPose.useDouble);
  if (!weaponChanged && now - onlineLastPoseSentAt < ONLINE_POSE_THROTTLE_MS) {
    onlineSchedulePoseFlush(now - onlineLastPoseSentAt);
    return;
  }
  onlineSendPoseNow(pose, now);
}

function onlineSendPoseNow(pose, now) {
  onlinePoseSeq++;
  onlineLastSentPose = pose;
  onlineLastPoseSentAt = now;
  const WD = onlineGetWD();
  if (WD && typeof WD.sendPose === "function") {
    WD.sendPose(onlineRoomCode, onlineMySlot, Object.assign({}, pose, { seq: onlinePoseSeq, at: now })).catch(function (err) {
      console.error("[WDOnline] 姿態同步失敗", err);
    });
  }
}

function onlineSchedulePoseFlush(elapsed) {
  if (onlinePoseTrailingTimer) return;
  const delay = Math.max(0, ONLINE_POSE_THROTTLE_MS - elapsed);
  onlinePoseTrailingTimer = setTimeout(function () {
    onlinePoseTrailingTimer = null;
    onlineFlushPose();
  }, delay);
}

// 收尾發送：移動停下來後，把最後一個姿態補送出去，避免對方永遠停在舊位置
function onlineFlushPose() {
  if (gameMode !== "ONLINE" || !onlineRoomCode || !onlineMySlot) return;
  if (!onlineIsMyTurn() || onlineIsReplayActive()) return;
  if (gameState !== STATES.PLAYING && gameState !== STATES.CHARGING) return;
  const me = onlineMySlot === "p2" ? player2 : player1;
  if (!me || me.isFalling) return;
  const pose = onlineBuildPose(me);
  if (!onlinePoseChanged(pose, onlineLastSentPose)) return;
  const now = Date.now();
  if (now - onlineLastPoseSentAt < ONLINE_POSE_THROTTLE_MS) {
    onlineSchedulePoseFlush(now - onlineLastPoseSentAt);
    return;
  }
  onlineSendPoseNow(pose, now);
}

// 對方姿態來了：只套用對方砲台的位置／角度／武器（不動 HP、勝負、回合）
function onlineApplyOpponentPose(slot, pose) {
  if (!pose || typeof pose.x !== "number") return;
  if (onlineReplay || onlineReplayQueue.length > 0) return; // 重播中不套用，等權威狀態
  const applied = onlineAppliedPose[slot] || { seq: 0, at: 0 };
  if (!(pose.seq > applied.seq || pose.at > applied.at)) return; // 過期快照不套用
  onlineAppliedPose[slot] = { seq: pose.seq || 0, at: pose.at || 0 };
  const c = slot === "p2" ? player2 : player1;
  if (!c || c.isFalling) return; // 墜落中不套用，等權威狀態
  c.x = pose.x;
  c.angle = pose.angle;
  c.selectedWeapon = pose.weapon;
  c.fuel = pose.fuel;
  c.useDouble = !!pose.useDouble;
  // y 會由 updatePhysics 每幀依地形自動跟著 x 走，不用另外同步
  updateHUD();
}

// 把房間的權威狀態套用到本地遊戲物件
function onlineApplyOnlineState(state) {
  if (!state) return;
  onlineApplyCannon(player1, state.p1);
  onlineApplyCannon(player2, state.p2);
  onlineRebuildBridge(state.holes || []);
  wind = state.wind;
  renderWind();
  currentPlayer = state.turn === "p2" ? 2 : 1;
  // 換回合時清掉殘留的按鍵狀態，避免卡鍵
  keys.a = keys.d = keys.w = keys.s = keys.space = false;
  projectile = null;
  gameState = STATES.PLAYING;
  updateHUD();
}

// 依房間的橋洞陣列重建高度地圖（不經過 addBridgeHole，避免重複記錄）
function onlineRebuildBridge(holes) {
  bridgeHeightMap.fill(BRIDGE_Y);
  bridgeHoles = [];
  (holes || []).forEach(function (h) {
    bridgeHoles.push({ x: h.x, y: h.y, r: h.r });
    carveBridgeHole(h.x, h.y, h.r);
  });
}

// ---------- 重播動畫：對方開火的軌跡預算與播放 ----------
// 與 updatePhysics 第三段（砲彈飛行）同樣的物理，一步一步預算整條軌跡，
// 播放時只顯示動畫，不算傷害；傷害與勝負以權威狀態為準。
function onlineComputeTrajectory(p) {
  const angleRad = p.angle * Math.PI / 180;
  const velocity = MIN_POWER + (p.power / 100) * (MAX_POWER - MIN_POWER);
  const weaponType = p.weapon;
  const radius = weaponType === 2 ? 9 : 4;
  const startX = p.fromX;
  const startY = p.fromY;
  const points = [{ x: startX, y: startY }];
  let landing = null;
  const shooterNum = p.by === "p2" ? 2 : 1;

  if (p.isGuided && p.targetX) {
    // 引導彈道（自動瞄準）：與 updatePhysics 的貝茲曲線相同
    const totalFrames = Math.max(45, Math.round(Math.abs(p.targetX - startX) / 8));
    const peakHeight = Math.min(startY, p.targetY) - 180;
    for (let f = 1; f <= totalFrames; f++) {
      const t = Math.min(1, f / totalFrames);
      const x = startX + (p.targetX - startX) * t;
      const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * peakHeight + t * t * p.targetY;
      points.push({ x: x, y: y });
    }
    landing = { x: p.targetX, y: p.targetY, weaponType: weaponType };
  } else {
    let vx = Math.cos(angleRad) * velocity;
    let vy = Math.sin(angleRad) * velocity;
    let x = startX;
    let y = startY;
    for (let i = 0; i < 1200; i++) {
      vx += p.wind * WIND_FACTOR;
      vy += GRAVITY;
      x += vx;
      y += vy;
      points.push({ x: x, y: y });
      // 撞玩家（排除發射者）
      if (shooterNum !== 1 && !player1.isFalling && onlineDist(x, y, player1.x, player1.y) < radius + player1.radius) {
        landing = { x: x, y: y, hitTarget: 1, weaponType: weaponType };
        break;
      }
      if (shooterNum !== 2 && !player2.isFalling && onlineDist(x, y, player2.x, player2.y) < radius + player2.radius) {
        landing = { x: x, y: y, hitTarget: 2, weaponType: weaponType };
        break;
      }
      // 撞橋面
      const xi = Math.round(x);
      if (xi >= 0 && xi < CANVAS_WIDTH) {
        const groundY = bridgeHeightMap[xi];
        if (y >= groundY) {
          if (xi >= BRIDGE_START && xi <= BRIDGE_END && groundY >= BRIDGE_Y + BRIDGE_THICKNESS) {
            // 已被挖空，穿過
          } else {
            landing = { x: x, y: y, weaponType: weaponType };
            break;
          }
        }
      }
      // 出界
      if (y > CANVAS_HEIGHT + 50 || x < -100 || x > CANVAS_WIDTH + 100) {
        landing = { x: x, y: y, outOfBounds: true, weaponType: weaponType };
        break;
      }
    }
    if (!landing) landing = { x: x, y: y, outOfBounds: true, weaponType: weaponType };
  }
  return { points: points, landing: landing };
}

function onlineStartReplay(shot) {
  try {
    const traj = onlineComputeTrajectory({
      fromX: shot.fromX, fromY: shot.fromY, angle: shot.angle, power: shot.power,
      weapon: shot.weapon, isGuided: !!shot.isGuided, targetX: shot.targetX, targetY: shot.targetY,
      wind: (typeof shot.wind === "number" ? shot.wind : wind), by: shot.by,
    });
    onlineReplay = { points: traj.points, landing: traj.landing, weaponType: shot.weapon, shotId: shot.shotId, idx: 0, elapsed: 0 };
    onlineReplayLastTick = 0;
  } catch (err) {
    console.error("[WDOnline] 重播軌跡計算失敗，直接套用狀態", err);
    onlineReplay = null;
    onlineApplyPendingState();
  }
}

// 每幀由 game.js 的 gameLoop 呼叫：推進重播進度（60fps 播放）
function onlineTickReplay() {
  if (!onlineReplay) return;
  const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  if (!onlineReplayLastTick) onlineReplayLastTick = now;
  const dt = Math.min(100, now - onlineReplayLastTick);
  onlineReplayLastTick = now;
  onlineReplay.elapsed += dt;
  onlineReplay.idx = Math.min(onlineReplay.points.length - 1, Math.floor(onlineReplay.elapsed / (1000 / 60)));
  if (onlineReplay.idx >= onlineReplay.points.length - 1) {
    onlineFinishReplay();
  }
}

function onlineFinishReplay() {
  const r = onlineReplay;
  onlineReplay = null;
  onlineReplayLastTick = 0;
  if (!r) return;
  if (r.landing && !r.landing.outOfBounds) {
    onlineShowReplayExplosion(r.landing.x, r.landing.y, r.weaponType);
  }
  onlinePumpReplayQueue();
}

// 重播落點的視覺爆炸（只有效果與挖洞，不算傷害、不判定勝負）
function onlineShowReplayExplosion(x, y, weaponType) {
  explosions.push({
    x: x, y: y, currentRadius: 0,
    maxRadius: weaponType === 2 ? 70 : 35,
    speed: weaponType === 2 ? 5 : 3.5,
  });
  const count = weaponType === 2 ? 55 : 25;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 1 + Math.random() * (weaponType === 2 ? 8 : 5);
    const rand = Math.random();
    const color = rand < 0.4 ? "#815938" : rand < 0.75 ? "#e06e12" : "#5a5d63";
    particles.push(new Particle(x, y, Math.cos(a) * sp, Math.sin(a) * sp, color, weaponType === 2 ? 6 : 4, 35));
  }
  shakeIntensity = weaponType === 2 ? 22 : 12;
  // 視覺挖洞（權威狀態到了會再重建一次，這裡先挖是為了讓地形與開火方一致；
  // 若權威狀態已經套用過（洞已在陣列裡），就不再重複挖）
  if (y >= BRIDGE_Y - 20 && y <= BRIDGE_Y + BRIDGE_THICKNESS + 20) {
    const hr = weaponType === 2 ? 40 : 22;
    const exists = bridgeHoles.some(function (h) {
      return Math.abs(h.x - x) < 1 && Math.abs(h.y - y) < 1 && h.r === hr;
    });
    if (!exists) addBridgeHole(x, y, hr);
  }
}

// 由 game.js 的 render() 呼叫：畫重播中的砲彈
function onlineDrawReplay() {
  if (!onlineReplay) return;
  const pts = onlineReplay.points;
  const idx = Math.min(onlineReplay.idx, pts.length - 1);
  const pt = pts[idx];
  if (!pt) return;
  ctx.save();
  ctx.shadowBlur = 0;
  if (idx > 1) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i <= idx; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.strokeStyle = "rgba(60, 62, 66, 0.4)";
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.stroke();
  }
  ctx.fillStyle = "#333538";
  ctx.strokeStyle = "#1b1c1e";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(pt.x, pt.y, onlineReplay.weaponType === 2 ? 9 : 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function onlinePumpReplayQueue() {
  if (onlineReplay) return; // 正在播，等播完再播下一個
  const shot = onlineReplayQueue.shift();
  if (!shot) {
    if (onlinePendingState) onlineApplyPendingState();
    return;
  }
  onlineStartReplay(shot);
}

// ---------- 房間快照：狀態機 ----------
// Firestore 每次文件有變動（開火、回合、終局、心跳）都會推一份快照過來；
// 下面的守衛（rev、shotId、scoreRecordedRev）讓重複推播不會重複套用或重複記分。
function onlineOnRoomSnapshot(data) {
  if (!onlineRoomCode) return; // 已經離開房間了
  if (!data) { // 房間被刪了（對方取消）
    onlineHandleRoomDeleted();
    return;
  }
  onlineRoomData = data;

  if (data.leftBy && data.leftBy !== onlineMySlot) {
    onlineShowOpponentLeft();
  }

  if (data.status === "waiting") {
    onlineRenderWaiting(data);
    return;
  }

  if (data.status === "playing") {
    onlineSawPlaying = true;
    // 對方回合內的即時姿態（移動／角度／武器）
    if (data.poses) {
      const other = onlineOtherSlot();
      if (data.poses[other]) onlineApplyOpponentPose(other, data.poses[other]);
    }
    // 對方的新開火：排進重播佇列
    if (data.lastShot && data.lastShot.by !== onlineMySlot && data.lastShot.shotId !== onlineLastReplayedShotId) {
      onlineLastReplayedShotId = data.lastShot.shotId;
      onlineReplayQueue.push(data.lastShot);
      onlinePumpReplayQueue();
    }
    // 新權威狀態
    if (data.state && data.rev > onlineLastAppliedRev) {
      onlinePendingState = { rev: data.rev, status: "playing", state: data.state, winner: null };
      onlineMaybeApplyPending();
    }
    return;
  }

  if (data.status === "finished") {
    // 記分：每人只記一次（以 rev 為準）；平手不記；重整後直接看到 finished 不記
    // （onlineSawPlaying 只有在這次連線看過 playing 才會是 true）
    if (data.winner && data.winner !== "draw" && onlineScoreRecordedRev !== data.rev && onlineSawPlaying) {
      onlineScoreRecordedRev = data.rev;
      const WD = onlineGetWD();
      if (WD && typeof WD.recordResult === "function") {
        WD.recordResult(data.winner === onlineMySlot);
      }
    }
    if (data.state && data.rev > onlineLastAppliedRev) {
      onlinePendingState = { rev: data.rev, status: "finished", state: data.state, winner: data.winner };
      onlineMaybeApplyPending();
    }
    return;
  }
}

function onlineMaybeApplyPending() {
  if (!onlinePendingState) return;
  if (onlineReplay || onlineReplayQueue.length > 0) {
    onlineSchedulePendingApply();
    return;
  }
  onlineApplyPendingState();
}

function onlineSchedulePendingApply() {
  // 重播還在播就等它播完；設一個 6 秒超時，避免重播卡住一直不套用
  if (onlinePendingStateTimer) return;
  onlinePendingStateTimer = setTimeout(function () {
    onlinePendingStateTimer = null;
    if (onlinePendingState) onlineApplyPendingState();
  }, 6000);
}

function onlineApplyPendingState() {
  if (!onlinePendingState) return;
  const st = onlinePendingState;
  onlinePendingState = null;
  if (onlinePendingStateTimer) { clearTimeout(onlinePendingStateTimer); onlinePendingStateTimer = null; }
  onlineLastAppliedRev = st.rev;
  onlineApplyOnlineState(st.state);
  if (st.status === "finished") {
    onlineShowOnlineGameOver(st.winner);
  } else {
    // 輪到自己了就播提示音（對方開完火換到我、剛開局輪到我、再來一場由我先攻，都算）
    if (currentPlayer === onlineMySlotNum() && typeof playTurnSound === "function") {
      playTurnSound();
    }
    // 回到遊戲畫面（再來一場時從結算畫面回來）
    onlineStartOnlineGameScreen();
    onlineShowEl(onlineEl("online-rematch-btn"), false);
    onlineShowEl(onlineEl("online-back-btn"), false);
    onlineShowEl(onlineEl("restart-btn"), true);
  }
}

// 線上結算畫面：顯示贏家名字＋再來一場／回主畫面
function onlineShowOnlineGameOver(winner) {
  const textEl = onlineEl("winner-text");
  if (textEl) {
    const names = onlineGetOnlineNames();
    if (winner === "draw") textEl.innerText = "雙方平手";
    else if (winner === "p1") textEl.innerText = (names.p1 || "玩家 1") + " 獲勝";
    else if (winner === "p2") textEl.innerText = (names.p2 || "玩家 2") + " 獲勝";
  }
  onlineShowEl(onlineEl("restart-btn"), false);
  onlineShowEl(onlineEl("online-rematch-btn"), true);
  onlineShowEl(onlineEl("online-back-btn"), true);
  switchScreen("gameover-screen");
  gameState = STATES.GAMEOVER;
}

function onlineStartOnlineGameScreen() {
  gameMode = "ONLINE";
  switchScreen("game-screen");
  onlineShowEl(onlineEl("online-leave-btn"), true);
  // 線上留言板：進房間的遊戲畫面就訂閱留言、顯示留言按鈕
  if (typeof window !== "undefined" && window.WDChat && typeof window.WDChat.enterRoom === "function") {
    window.WDChat.enterRoom(onlineRoomCode);
  }
  const banner = onlineEl("online-left-banner");
  if (banner) banner.style.display = "none";
}

// ---------- 房間 UI 流程 ----------
function onlineSetError(msg) {
  const el = onlineEl("online-error");
  if (!el) return;
  el.innerText = msg || "";
  el.style.display = msg ? "block" : "none";
}

function onlineOpenOnlinePanel() {
  onlineShowEl(onlineEl("online-panel"), true);
  onlineRenderOnlinePanel();
  const panel = onlineEl("online-panel");
  if (panel && panel.scrollIntoView) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function onlineRenderOnlinePanel() {
  const WD = onlineGetWD();
  const user = WD ? WD.getCurrentUser() : null;
  onlineShowEl(onlineEl("online-login-note"), !user);
  onlineShowEl(onlineEl("online-setup"), !!user && !onlineRoomCode);
  onlineShowEl(onlineEl("online-waiting"), !!onlineRoomCode);
  if (onlineRoomCode) onlineRenderWaiting(onlineRoomData);
}

function onlineResetFlags() {
  onlineLastAppliedRev = 0;
  onlinePendingState = null;
  if (onlinePendingStateTimer) { clearTimeout(onlinePendingStateTimer); onlinePendingStateTimer = null; }
  onlineScoreRecordedRev = 0;
  onlineSawPlaying = false;
  onlineReplayQueue = [];
  onlineReplay = null;
  onlineReplayLastTick = 0;
  onlineLastReplayedShotId = null;
  onlineOpponentLeftShown = false;
  onlinePoseSeq = 0;
  onlineLastSentPose = null;
  onlineLastPoseSentAt = 0;
  if (onlinePoseTrailingTimer) { clearTimeout(onlinePoseTrailingTimer); onlinePoseTrailingTimer = null; }
  onlineAppliedPose = { p1: { seq: 0, at: 0 }, p2: { seq: 0, at: 0 } };
}

function onlineCreateRoomFlow() {
  const WD = onlineGetWD();
  if (!WD) { onlineSetError("Firebase 還在載入，請稍等再試。"); return; }
  const user = WD.getCurrentUser();
  if (!user) { onlineSetError("請先登入 Google 帳號，才能建立房間。"); return; }
  onlineSetError("");
  WD.createRoom().then(function (code) {
    onlineRoomCode = code;
    onlineMySlot = "p1";
    onlineResetFlags();
    gameMode = "ONLINE";
    onlineSubscribe(code);
    onlineStartHeartbeat();
    onlineShowEl(onlineEl("online-setup"), false);
    onlineShowEl(onlineEl("online-waiting"), true);
    onlineRenderWaiting(null);
  }).catch(function (err) {
    console.error("[WDOnline] 建立房間失敗", err);
    onlineSetError("建立房間失敗，請再試一次。");
  });
}

function onlineJoinRoomFlow(code) {
  const WD = onlineGetWD();
  if (!WD) { onlineSetError("Firebase 還在載入，請稍等再試。"); return; }
  const user = WD.getCurrentUser();
  if (!user) { onlineSetError("請先登入 Google 帳號，才能加入房間。"); return; }
  code = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) { onlineSetError("房間代碼是 6 碼，請檢查後再輸入。"); return; }
  onlineSetError("");
  // 先看自己是不是已經在這個房間裡（重整頁面回來）
  WD.rejoinRoom(code).then(function (slot) {
    onlineRoomCode = code;
    onlineMySlot = slot;
    onlineResetFlags();
    gameMode = "ONLINE";
    onlineSubscribe(code);
    onlineStartHeartbeat();
    onlineShowEl(onlineEl("online-setup"), false);
    onlineShowEl(onlineEl("online-waiting"), true);
    onlineRenderWaiting(null);
  }).catch(function (err) {
    if (err && err.message === "NOT_IN_ROOM") {
      WD.joinRoom(code).then(function () {
        onlineRoomCode = code;
        onlineMySlot = "p2";
        onlineResetFlags();
        gameMode = "ONLINE";
        onlineSubscribe(code);
        onlineStartHeartbeat();
        onlineShowEl(onlineEl("online-setup"), false);
        onlineShowEl(onlineEl("online-waiting"), true);
        onlineRenderWaiting(null);
      }).catch(function (err2) { onlineShowJoinError(err2); });
    } else {
      onlineShowJoinError(err);
    }
  });
}

function onlineShowJoinError(err) {
  let msg = "加入房間失敗，請再試一次。";
  if (err && err.message === "ROOM_NOT_FOUND") msg = "找不到這個房間，請確認 6 碼代碼是否正確。";
  else if (err && err.message === "ROOM_FULL") msg = "這個房間已經滿了（兩個人都在裡面了）。";
  else if (err && err.message === "ROOM_FINISHED") msg = "這個房間的對戰已經結束了，請對方再開一個新房間。";
  else if (err && err.message === "BAD_CODE") msg = "房間代碼是 6 碼，請檢查後再輸入。";
  onlineSetError(msg);
}

function onlineSubscribe(code) {
  const WD = onlineGetWD();
  if (!WD || typeof WD.subscribeRoom !== "function") return;
  if (onlineUnsubscribe) onlineUnsubscribe();
  onlineUnsubscribe = WD.subscribeRoom(code, onlineOnRoomSnapshot);
}

function onlineInviteLink(code) {
  let base = "";
  try {
    base = window.location.origin + window.location.pathname;
  } catch (e) {
    base = "https://yesaymini-ship-it.github.io/wooden-duel/";
  }
  return base + "?room=" + code;
}

function onlineRenderWaiting(data) {
  const codeEl = onlineEl("online-room-code");
  if (codeEl && onlineRoomCode) codeEl.innerText = onlineRoomCode;
  const linkEl = onlineEl("online-invite-link");
  if (linkEl && onlineRoomCode) linkEl.value = onlineInviteLink(onlineRoomCode);
  const listEl = onlineEl("online-players-list");
  if (listEl) {
    const names = [];
    if (data && data.players) {
      if (data.players.p1) names.push("🏠 " + (data.players.p1.displayName || "玩家") + "（房主）");
      if (data.players.p2) names.push("👤 " + (data.players.p2.displayName || "玩家"));
      else names.push("⏳ 等待對方加入…");
    } else {
      const WD = onlineGetWD();
      const user = WD ? WD.getCurrentUser() : null;
      names.push("🏠 " + (user ? (user.displayName || "玩家") : "你") + "（房主）");
      names.push("⏳ 等待對方加入…");
    }
    listEl.innerHTML = "";
    names.forEach(function (n) {
      const li = document.createElement("li");
      li.textContent = n;
      listEl.appendChild(li);
    });
  }
  const statusEl = onlineEl("online-waiting-status");
  if (statusEl) {
    if (data && data.leftBy) statusEl.innerText = "對方已離開房間。";
    else if (data && data.players && data.players.p2) statusEl.innerText = "對方加入了，馬上開局…";
    else statusEl.innerText = "等待對方加入…（把連結傳給朋友）";
  }
}

function onlineCopyInviteLink() {
  const linkEl = onlineEl("online-invite-link");
  const text = linkEl ? linkEl.value : onlineInviteLink(onlineRoomCode);
  function done() {
    const btn = onlineEl("online-copy-link-btn");
    if (btn) {
      const old = btn.innerText;
      btn.innerText = "已複製！";
      setTimeout(function () { btn.innerText = old; }, 1500);
    }
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { onlineFallbackCopy(); done(); });
    } else {
      onlineFallbackCopy();
      done();
    }
  } catch (e) { onlineFallbackCopy(); done(); }
}

function onlineFallbackCopy() {
  try {
    const linkEl = onlineEl("online-invite-link");
    if (linkEl && linkEl.select) linkEl.select();
    if (document.execCommand) document.execCommand("copy");
  } catch (e) {}
}

// 再來一場：重置成新一局（雙方都要在房間裡才有效），輸的人先攻
function onlineRequestRematch() {
  const WD = onlineGetWD();
  if (!WD || !onlineRoomCode || !onlineRoomData) return;
  if (onlineRoomData.leftBy) {
    alert("對方已經離開了，沒辦法再來一場。");
    return;
  }
  if (onlineRoomData.status !== "finished") return; // 已經有人按過再來一場了
  const newState = WD.initialRoomState();
  // 輸的人先攻：贏家從房間文件（共用的 winner）算，兩邊一定一致；平手維持 p1 先攻
  if (onlineRoomData.winner === "p1") newState.turn = "p2";
  else if (onlineRoomData.winner === "p2") newState.turn = "p1";
  const newRev = (onlineRoomData.rev || 0) + 1;
  WD.rematchRoom(onlineRoomCode, newState, newRev).catch(function (err) {
    console.error("[WDOnline] 再來一場失敗", err);
  });
}

// ---------- 離開、心跳、對方離開 ----------
function onlineShowOpponentLeft() {
  if (onlineOpponentLeftShown) return;
  onlineOpponentLeftShown = true;
  const banner = onlineEl("online-left-banner");
  if (banner) {
    banner.style.display = "block";
    banner.innerText = "對方已離開房間，你可以回主畫面再開一個新房間。";
  }
  const statusEl = onlineEl("online-waiting-status");
  if (statusEl) statusEl.innerText = "對方已離開房間。";
}

function onlineStartHeartbeat() {
  onlineStopHeartbeat();
  onlineHeartbeatTimer = setInterval(function () {
    const WD = onlineGetWD();
    if (WD && onlineRoomCode && onlineMySlot) WD.heartbeatRoom(onlineRoomCode, onlineMySlot);
  }, 15000);
  onlineStaleCheckTimer = setInterval(onlineCheckOpponentStale, 5000);
}

function onlineStopHeartbeat() {
  if (onlineHeartbeatTimer) { clearInterval(onlineHeartbeatTimer); onlineHeartbeatTimer = null; }
  if (onlineStaleCheckTimer) { clearInterval(onlineStaleCheckTimer); onlineStaleCheckTimer = null; }
}

// 對方超過 60 秒沒心跳（例如直接關掉頁面），視為離開
function onlineCheckOpponentStale() {
  if (!onlineRoomData || !onlineRoomData.players) return;
  if (onlineRoomData.status !== "playing" && onlineRoomData.status !== "waiting") return;
  if (onlineRoomData.leftBy) return;
  const other = onlineRoomData.players[onlineOtherSlot()];
  if (!other || !other.lastSeen || typeof other.lastSeen.toMillis !== "function") return;
  const age = Date.now() - other.lastSeen.toMillis();
  if (age > 60000) onlineShowOpponentLeft();
}

function onlineCleanupLocal() {
  onlineStopHeartbeat();
  if (onlineUnsubscribe) { onlineUnsubscribe(); onlineUnsubscribe = null; }
  onlineRoomCode = null;
  onlineMySlot = null;
  onlineRoomData = null;
  onlineOpponentLeftShown = false;
  gameMode = "PVP"; // 回到預設模式，避免線上分支殘留
  // 本機狀態回到開始畫面
  bridgeHeightMap.fill(BRIDGE_Y);
  bridgeHoles = [];
  onlineResetCannonLocal(player1, 260, -45);
  onlineResetCannonLocal(player2, 764, -135);
  currentPlayer = 1;
  projectile = null;
  particles = [];
  explosions = [];
  pendingShots = 0;
  gameState = STATES.START;
  updateHUD();
  onlineShowEl(onlineEl("online-leave-btn"), false);
  const banner = onlineEl("online-left-banner");
  if (banner) banner.style.display = "none";
  onlineShowEl(onlineEl("online-rematch-btn"), false);
  onlineShowEl(onlineEl("online-back-btn"), false);
  onlineShowEl(onlineEl("restart-btn"), true);
  // 線上留言板：離開房間就取消訂閱、清空留言、收起按鈕
  if (typeof window !== "undefined" && window.WDChat && typeof window.WDChat.leaveRoom === "function") {
    window.WDChat.leaveRoom();
  }
  switchScreen("start-screen");
}

function onlineResetCannonLocal(c, x, angle) {
  c.hp = 100;
  c.x = x;
  c.y = BRIDGE_Y - 15;
  c.angle = angle;
  c.fuel = 100;
  c.selectedWeapon = 1;
  c.doubleUses = 2;
  c.useDouble = false;
  c.isFalling = false;
  c.fallSpeed = 0;
}

function onlineLeaveRoomFlow() {
  const code = onlineRoomCode;
  const slot = onlineMySlot;
  const WD = onlineGetWD();
  onlineCleanupLocal();
  if (WD && code && slot && typeof WD.leaveRoom === "function") {
    WD.leaveRoom(code, slot); // 不等它完成
  }
  onlineRenderOnlinePanel();
}

// 房間被對方刪除（例如對方在等待時按取消）
function onlineHandleRoomDeleted() {
  const wasInGame = gameState !== STATES.START;
  onlineCleanupLocal();
  if (wasInGame) {
    onlineSetError("房間已經關閉了（對方離開）。");
  } else {
    onlineSetError("房間已經關閉了（對方取消）。");
  }
  onlineOpenOnlinePanel();
}

// ---------- 邀請連結自動加入 ----------
function onlineReadInviteCodeFromURL() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    const code = params.get("room");
    if (code) return String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
  } catch (e) {}
  return null;
}

function onlineMaybeAutoJoin() {
  if (!onlinePendingJoinCode || onlineRoomCode) return;
  const WD = onlineGetWD();
  if (!WD) return;
  const user = WD.getCurrentUser();
  if (!user) return; // 還沒登入，等登入後再試（每秒檢查一次）
  const code = onlinePendingJoinCode;
  onlinePendingJoinCode = null;
  if (onlineAutoJoinTimer) { clearInterval(onlineAutoJoinTimer); onlineAutoJoinTimer = null; }
  onlineOpenOnlinePanel();
  onlineJoinRoomFlow(code);
}

// ---------- 綁定 UI（script 在 body 尾端，DOM 已經有了） ----------
function onlineBindUI() {
  let b;
  b = onlineEl("start-online-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineOpenOnlinePanel(); });
  b = onlineEl("online-login-btn");
  if (b) b.addEventListener("click", function () { const WD = onlineGetWD(); if (WD) WD.loginWithGoogle(); });
  b = onlineEl("online-create-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineCreateRoomFlow(); });
  b = onlineEl("online-join-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineJoinRoomFlow(onlineEl("online-join-code") ? onlineEl("online-join-code").value : ""); });
  b = onlineEl("online-copy-link-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineCopyInviteLink(); });
  b = onlineEl("online-cancel-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineLeaveRoomFlow(); });
  b = onlineEl("online-leave-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineLeaveRoomFlow(); });
  b = onlineEl("online-rematch-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineRequestRematch(); });
  b = onlineEl("online-back-btn");
  if (b) b.addEventListener("click", function (e) { e.target.blur(); onlineLeaveRoomFlow(); });
  const input = onlineEl("online-join-code");
  if (input) {
    // 打字時即時轉大寫、只留英數字
    input.addEventListener("input", function () {
      const v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (input.value !== v) input.value = v;
    });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") onlineJoinRoomFlow(input.value); });
  }
}
onlineBindUI();

onlinePendingJoinCode = onlineReadInviteCodeFromURL();
if (onlinePendingJoinCode) {
  // 有邀請連結：等登入後自動加入
  onlineAutoJoinTimer = setInterval(onlineMaybeAutoJoin, 1000);
  onlineWhenWDReady(function () {
    const WD = onlineGetWD();
    if (WD && WD.getCurrentUser()) onlineMaybeAutoJoin();
    else onlineOpenOnlinePanel(); // 還沒登入，先打開線上對戰面板請他登入
  });
}

// 關掉頁面時盡量通知對方我離開了（不一定送得到，對方還有心跳超時兜底）
window.addEventListener("pagehide", function () {
  if (onlineRoomCode && onlineMySlot) {
    const WD = onlineGetWD();
    if (WD && typeof WD.leaveRoom === "function") {
      try { WD.leaveRoom(onlineRoomCode, onlineMySlot); } catch (e) {}
    }
  }
});

// 暴露給 game.js 呼叫的介面
window.WDOnline = {
  isMyTurn: onlineIsMyTurn,
  isReplayActive: onlineIsReplayActive,
  getOnlineNames: onlineGetOnlineNames,
  onLocalShotFired: onlineOnLocalShotFired,
  commitTurnResult: onlineCommitTurnResult,
  onLocalGameOver: onlineOnLocalGameOver,
  tickReplay: onlineTickReplay,
  drawReplay: onlineDrawReplay,
  maybeSendPose: onlineMaybeSendPose,
  computeTrajectory: onlineComputeTrajectory,
  openOnlinePanel: onlineOpenOnlinePanel,
};
