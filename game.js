// --- 遊戲組態與常數 ---
const CANVAS_WIDTH = 1024;
const CANVAS_HEIGHT = 576;

const BRIDGE_Y = 350; // 將獨木橋往下移
const BRIDGE_START = 150;
const BRIDGE_END = 874;
const BRIDGE_THICKNESS = 80; // 巨大厚實的電子巨木樹幹



const GRAVITY = 0.25;      // 重力加速度
const WIND_FACTOR = 0.03;  // 風力對砲彈的影響係數
const FUEL_CONSUMPTION = 0.6; // 降低移動電量消耗，讓移動更順暢
const MAX_POWER = 16;      // 最大發射初速
const MIN_POWER = 3;       // 最小發射初速，防止砲彈垂直掉在自己頭上

// 顏色定義 (與 CSS 同步)
const COLORS = {
    cyan: '#c94432',     // 玩家一：軍隊紅
    magenta: '#3d7cb8',  // 玩家二：軍隊藍
    yellow: '#d4a73b',   // 黃色高亮 / 爆炸核心
    bridge: '#815938',
    bg: '#1a2219',
    grid: 'rgba(0, 0, 0, 0.02)',
    bridgeSupport: 'rgba(92, 60, 33, 0.3)'
};

// 遊戲狀態列舉
const STATES = {
    START: 'START',
    PLAYING: 'PLAYING',
    CHARGING: 'CHARGING',
    FLYING: 'FLYING',
    EXPLODING: 'EXPLODING',
    SWITCH_TURN: 'SWITCH_TURN',
    GAMEOVER: 'GAMEOVER'
};

// --- 全域變數 ---
let canvas, ctx;
let offCanvas, offCtx; // 離屏畫布與快取上下文（優化記憶體，防止 FPS 驟降）
let gameState = STATES.START;
let currentPlayer = 1; // 1 或 2
let gameMode = 'PVP';  // 'PVP' 或 'PVE'
let isAutoAiming = false; // 是否正在執行自動瞄準動畫與發射
let autoAimTarget = null; // 自動瞄準的目標位置物件 { x, y }
let wind = 0; // 當前風力 (-5 到 5)
let shakeIntensity = 0; // 畫面震動強度
let shakeDecay = 0.9;   // 畫面震動衰減
let screenShakeX = 0;
let screenShakeY = 0;
let bgStars = [];
let gridOffset = 0; // 用於底部 perspective 網格滾動
let bridgeHeightMap = new Float32Array(CANVAS_WIDTH); // 橋樑高度地圖（支援挖洞）
let bridgeHoles = []; // 儲存所有爆炸挖洞的圓圈座標與半徑

// 載入美術資源圖片
const imgBg = new Image();
imgBg.src = 'assets/bg.png';

const imgWood = new Image();
imgWood.src = 'assets/wood.png';
let patWood = null;

const imgRock = new Image();
imgRock.src = 'assets/rock.png';
let patRock = null;



// 按鍵輸入狀態
const keys = {
    a: false,
    d: false,
    w: false,
    s: false,
    space: false
};

// 粒子系統
let particles = [];
let projectile = null;
let pendingShots = 0;
let lastChargePower = 0;
let explosions = [];

// 玩家大砲類別
class Cannon {
    constructor(id, x, color, rangeMin, rangeMax) {
        this.id = id;
        this.x = x;
        this.y = BRIDGE_Y - 15; // 放在獨木橋上方
        this.color = color;
        this.rangeMin = rangeMin;
        this.rangeMax = rangeMax;
        
        this.hp = 100;
        this.angle = id === 1 ? -45 : -135; // 角度以度數表示，往上射擊為負
        this.barrelLength = 28;
        this.radius = 18;
        this.fuel = 100;
        this.targetAngle = this.angle;
        
        this.selectedWeapon = 1; // 1: 小高爆彈, 2: 大裂地彈
        this.doubleUses = 2; // 每局 2 次
        this.useDouble = false; // 是否啟用連發雙彈
        this.isFalling = false;
        this.fallSpeed = 0;
    }

    move(dir) {
        if (this.fuel <= 0 || this.isFalling) return;
        const newX = this.x + dir * 3;
        if (newX >= this.rangeMin && newX <= this.rangeMax) {
            // 物理限制：檢測新位置是否過於陡峭（坡度大於 60 度）或前進垂直落差太大
            const targetX = Math.round(newX);
            const currentX = Math.round(this.x);
            const xL = Math.max(0, Math.min(CANVAS_WIDTH - 1, targetX - 12));
            const xR = Math.max(0, Math.min(CANVAS_WIDTH - 1, targetX + 12));
            const yL = bridgeHeightMap[xL];
            const yR = bridgeHeightMap[xR];
            const slopeAngleRad = Math.atan2(yR - yL, xR - xL);
            const slopeAngleDeg = Math.abs(slopeAngleRad * 180 / Math.PI);
            
            const currentGroundY = bridgeHeightMap[currentX];
            const targetGroundY = bridgeHeightMap[targetX];
            const heightDiff = targetGroundY - currentGroundY; // 負值代表往上爬，正值代表往下走

            // 物理限制：只有在「往上爬坡」時限制 60 度與 8px 高度差，往下走（包括下斜坡、滑入彈坑）則不受限
            if (heightDiff < 0) { // 往上爬
                if (slopeAngleDeg > 60 || Math.abs(heightDiff) > 8) {
                    // 產生灰色警戒阻礙微粒
                    createMuzzleFlash(this.x, this.y + 6, -90, '#737373');
                    return;
                }
            }

            this.x = newX;
            // 大砲的 Y 軸高度跟隨兩側車輪的地表高度平均值，使其能自然適應斜坡與彈坑
            if (!this.isFalling) {
                this.y = (yL + yR) / 2 - 15;
            }
            this.fuel = Math.max(0, this.fuel - FUEL_CONSUMPTION);
            document.getElementById('fuel-value').innerText = Math.round(this.fuel);
        }
    }

    rotate(dir) {
        // 限制旋轉角度：可以完整的180度（上方半圓為 -180 到 0 度）
        const minAngle = -180;
        const maxAngle = 0;
        this.angle = Math.max(minAngle, Math.min(maxAngle, this.angle + dir * 1.5));
        
        // 更新 HUD
        const displayAngle = Math.round(Math.abs(this.angle));
        document.getElementById(`p${this.id}-angle`).innerText = displayAngle;
    }

    draw() {
        ctx.save();
        
        // 無發光特效，使用自然的木質與青銅質感影影
        ctx.shadowBlur = 0;

        // 計算車輪下的地形傾斜度
        const xL = Math.max(0, Math.min(CANVAS_WIDTH - 1, Math.round(this.x - 12)));
        const xR = Math.max(0, Math.min(CANVAS_WIDTH - 1, Math.round(this.x + 12)));
        const yL = bridgeHeightMap[xL];
        const yR = bridgeHeightMap[xR];
        const slopeAngle = Math.atan2(yR - yL, xR - xL);

        // 移至大砲位置並根據地形傾斜度旋轉
        ctx.translate(this.x, this.y);
        ctx.rotate(slopeAngle);

        // 1. 繪製軍隊小隊旗幟 (Flag)
        ctx.save();
        ctx.strokeStyle = '#42454a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        // 旗桿偏向後方
        const flagOffsetX = this.id === 1 ? -12 : 12;
        ctx.moveTo(flagOffsetX, -4);
        ctx.lineTo(flagOffsetX, -25);
        ctx.stroke();

        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.moveTo(flagOffsetX, -25);
        const flagTipX = this.id === 1 ? -26 : 26;
        ctx.lineTo(flagTipX, -20);
        ctx.lineTo(flagOffsetX, -15);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // 2. 繪製砲車木製底座 (Carriage body)
        ctx.fillStyle = '#5c3c21'; // 溫暖木褐
        ctx.strokeStyle = '#2d1c10';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-20, 6);
        ctx.lineTo(-14, -6);
        ctx.lineTo(14, -6);
        ctx.lineTo(20, 6);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 木製底座鐵箍裝飾
        ctx.strokeStyle = '#42454a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-8, 6);
        ctx.lineTo(-8, -6);
        ctx.moveTo(8, 6);
        ctx.lineTo(8, -6);
        ctx.stroke();

        // 3. 旋轉青銅砲管 (Bronze cannon barrel)
        ctx.save();
        ctx.translate(0, -6);
        // 砲口的角度要相對於世界坐標系旋轉，故需將地形的 slopeAngle 扣除
        ctx.rotate((this.angle * Math.PI / 180) - slopeAngle);
        
        // 漸層青銅色
        ctx.fillStyle = '#a87e3b';
        ctx.strokeStyle = '#5a3d12';
        ctx.lineWidth = 1.5;

        // 砲管本體 (後粗前細)
        ctx.beginPath();
        ctx.moveTo(0, -6);
        ctx.lineTo(this.barrelLength, -3);
        ctx.lineTo(this.barrelLength, 3);
        ctx.lineTo(0, 6);
        // 砲尾球 (Cascabel)
        ctx.arc(-2, 0, 6, Math.PI / 2, -Math.PI / 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 砲管加強箍 (Reinforcement rings)
        ctx.beginPath();
        ctx.moveTo(this.barrelLength * 0.4, -5);
        ctx.lineTo(this.barrelLength * 0.4, 5);
        ctx.moveTo(this.barrelLength * 0.8, -4);
        ctx.lineTo(this.barrelLength * 0.8, 4);
        ctx.stroke();
        
        ctx.restore();

        // 4. 繪製左右兩側的實木鐵邊車輪 (Wheels)
        const drawWheel = (wx, wy) => {
            ctx.save();
            // 木製輪轂
            ctx.fillStyle = '#815938';
            ctx.strokeStyle = '#3a220f';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(wx, wy, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // 外圍鐵胎 (Iron Rim)
            ctx.strokeStyle = '#3c3e42';
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.arc(wx, wy, 9, 0, Math.PI * 2);
            ctx.stroke();

            // 輪輻 (Spokes)
            ctx.strokeStyle = '#3a220f';
            ctx.lineWidth = 1;
            for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
                ctx.beginPath();
                ctx.moveTo(wx, wy);
                ctx.lineTo(wx + Math.cos(a) * 7.5, wy + Math.sin(a) * 7.5);
                ctx.stroke();
            }

            // 軸心
            ctx.fillStyle = '#3c3e42';
            ctx.beginPath();
            ctx.arc(wx, wy, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        };

        drawWheel(-12, 6);
        drawWheel(12, 6);

        ctx.restore();
    }
}

// 宣告玩家物件
const player1 = new Cannon(1, 260, COLORS.cyan, BRIDGE_START, 450);
const player2 = new Cannon(2, 764, COLORS.magenta, 574, BRIDGE_END);

// --- 初始化遊戲 ---
window.onload = function() {
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');

    // 建立一次離屏畫布快取，避免每幀重複建立造成記憶體洩漏與卡頓
    offCanvas = document.createElement('canvas');
    offCanvas.width = CANVAS_WIDTH;
    offCanvas.height = CANVAS_HEIGHT;
    offCtx = offCanvas.getContext('2d');

    // 初始化高度地圖
    bridgeHeightMap.fill(BRIDGE_Y);

    // 初始化科幻背景星空/數據點
    for (let i = 0; i < 70; i++) {
        bgStars.push({
            x: Math.random() * CANVAS_WIDTH,
            y: Math.random() * (BRIDGE_Y - 40),
            size: 0.5 + Math.random() * 2,
            twinkleSpeed: 0.01 + Math.random() * 0.03,
            alpha: Math.random()
        });
    }

    // 綁定 DOM 事件
    const startPveBtn = document.getElementById('start-pve-btn');
    if (startPveBtn) {
        startPveBtn.addEventListener('click', function(e) {
            e.target.blur();
            gameMode = 'PVE';
            startGame();
        });
    }
    const startPvpBtn = document.getElementById('start-pvp-btn');
    if (startPvpBtn) {
        startPvpBtn.addEventListener('click', function(e) {
            e.target.blur();
            gameMode = 'PVP';
            startGame();
        });
    }
    
    document.getElementById('restart-btn').addEventListener('click', function(e) {
        e.target.blur(); // 移除按鈕焦點
        resetGame();
    });

    const autoAimBtn = document.getElementById('auto-aim-btn');
    if (autoAimBtn) {
        autoAimBtn.addEventListener('click', function(e) {
            e.target.blur();
            triggerAutoAim();
        });
    }

    // --- 觸控按鈕（手機） ---
    // 按住型：按住操作、放開停止；直接操作 keys 狀態，與按住鍵盤完全一樣
    function bindHoldButton(id, onPress, onRelease) {
        const btn = document.getElementById(id);
        if (!btn) return;
        const press = function(e) {
            e.preventDefault();
            onPress();
        };
        const release = function(e) {
            e.preventDefault();
            onRelease();
        };
        btn.addEventListener('touchstart', press, { passive: false });
        btn.addEventListener('touchend', release, { passive: false });
        btn.addEventListener('touchcancel', release, { passive: false });
        btn.addEventListener('mousedown', press);
        btn.addEventListener('mouseup', release);
        btn.addEventListener('mouseleave', release);
        btn.addEventListener('contextmenu', function(e) { e.preventDefault(); });
    }
    // 點按型：點一下執行一次
    function bindTapButton(id, onTap) {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.addEventListener('click', function(e) {
            e.preventDefault();
            onTap();
        });
    }

    bindHoldButton('touch-left', function() { if (canAcceptInput()) keys.a = true; }, function() { keys.a = false; });
    bindHoldButton('touch-right', function() { if (canAcceptInput()) keys.d = true; }, function() { keys.d = false; });
    bindHoldButton('touch-up', function() { if (canAcceptInput()) keys.w = true; }, function() { keys.w = false; });
    bindHoldButton('touch-down', function() { if (canAcceptInput()) keys.s = true; }, function() { keys.s = false; });
    bindHoldButton('touch-fire', function() { startCharging(); }, function() { releaseFire(); });
    bindTapButton('touch-w1', function() { selectWeapon(1); });
    bindTapButton('touch-w2', function() { selectWeapon(2); });
    bindTapButton('touch-w3', function() { selectWeapon(3); });

    // 鍵盤事件監聽
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // 開始繪製初始背景
    requestAnimationFrame(gameLoop);
};

function startGame() {
    window.focus(); // 確保視窗取得焦點
    switchScreen('game-screen');
    const p2Name = document.querySelector('.p2-panel .player-name');
    if (p2Name) {
        p2Name.innerText = gameMode === 'PVE' ? '智慧電腦 [VS AI]' : '軍隊 02 [右方]';
    }
    gameState = STATES.PLAYING;
    generateWind();
    updateHUD();
}

function resetGame() {
    window.focus(); // 確保視窗取得焦點
    
    // 重設高度地圖與破洞記錄
    bridgeHeightMap.fill(BRIDGE_Y);
    bridgeHoles = [];
    
    player1.hp = 100;
    player1.x = 260;
    player1.y = BRIDGE_Y - 15;
    player1.angle = -45;
    player1.fuel = 100;
    player1.selectedWeapon = 1;
    player1.doubleUses = 2;
    player1.useDouble = false;
    player1.isFalling = false;
    player1.fallSpeed = 0;

    player2.hp = 100;
    player2.x = 764;
    player2.y = BRIDGE_Y - 15;
    player2.angle = -135;
    player2.fuel = 100;
    player2.selectedWeapon = 1;
    player2.doubleUses = 2;
    player2.useDouble = false;
    player2.isFalling = false;
    player2.fallSpeed = 0;

    currentPlayer = 1;
    projectile = null;
    particles = [];
    explosions = [];
    gameState = STATES.PLAYING;
    
    const p2Name = document.querySelector('.p2-panel .player-name');
    if (p2Name) {
        p2Name.innerText = gameMode === 'PVE' ? '智慧電腦 [VS AI]' : '軍隊 02 [右方]';
    }

    generateWind();
    updateHUD();
    switchScreen('game-screen');
}

function switchScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

// --- 鍵盤／觸控共用輸入邏輯 ---
// 觸控按鈕直接操作同一個 keys 狀態，行為與按住鍵盤完全一樣
function canAcceptInput() {
    if (isAutoAiming) return false;
    if (gameMode === 'PVE' && currentPlayer === 2) return false; // 電腦回合禁止手動輸入
    return gameState === STATES.PLAYING || gameState === STATES.CHARGING;
}

// 切換砲彈（鍵盤 1／2／3 與觸控按鈕共用）
function selectWeapon(n) {
    if (!canAcceptInput() || gameState !== STATES.PLAYING) return;
    const activePlayer = currentPlayer === 1 ? player1 : player2;
    if (n === 1) {
        activePlayer.selectedWeapon = 1;
        updateHUD();
        createMuzzleFlash(activePlayer.x, activePlayer.y - 10, activePlayer.angle, activePlayer.color);
    } else if (n === 2) {
        activePlayer.selectedWeapon = 2;
        updateHUD();
        createMuzzleFlash(activePlayer.x, activePlayer.y - 10, activePlayer.angle, COLORS.yellow);
    } else if (n === 3) {
        if (activePlayer.doubleUses > 0) {
            activePlayer.useDouble = !activePlayer.useDouble;
            updateHUD();
            createMuzzleFlash(activePlayer.x, activePlayer.y - 10, activePlayer.angle, COLORS.magenta);
        }
    }
}

// 開始蓄力（鍵盤空白鍵與觸控「發射」按鈕共用）
function startCharging() {
    if (!canAcceptInput() || gameState !== STATES.PLAYING) return;
    keys.space = true;
    gameState = STATES.CHARGING;
    chargePower = 0;
    document.getElementById('power-overlay').style.display = 'flex';
}

// 放開發射（放開空白鍵與放開觸控「發射」按鈕共用）
function releaseFire() {
    if (isAutoAiming) {
        keys.space = false;
        return;
    }
    if (gameState !== STATES.CHARGING) {
        keys.space = false;
        return;
    }
    keys.space = false;
    fireProjectile();
}

// --- 輸入處理 ---
function handleKeyDown(e) {
    if (isAutoAiming) return;
    // 防止空白鍵使網頁向下滾動，也防止空白鍵重複觸發按鈕
    if (e.code === 'Space') {
        e.preventDefault();
    }

    if (gameState !== STATES.PLAYING && gameState !== STATES.CHARGING) return;
    if (gameMode === 'PVE' && currentPlayer === 2) return; // 電腦回合禁止手動輸入

    // 自動瞄準外掛 (按鍵 H)
    if ((e.key === 'h' || e.key === 'H') && gameState === STATES.PLAYING) {
        e.preventDefault();
        triggerAutoAim();
        return;
    }

    // 武器切換 (按鍵 1、2、3，與觸控按鈕共用 selectWeapon)
    if (e.key === '1') selectWeapon(1);
    if (e.key === '2') selectWeapon(2);
    if (e.key === '3') selectWeapon(3);

    if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') {
        e.preventDefault();
        keys.a = true;
    }
    if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') {
        e.preventDefault();
        keys.d = true;
    }
    if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') {
        e.preventDefault();
        keys.w = true;
    }
    if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') {
        e.preventDefault();
        keys.s = true;
    }
    
    if (e.code === 'Space') {
        e.preventDefault();
        startCharging();
    }
}

function handleKeyUp(e) {
    if (isAutoAiming) return;
    if (gameMode === 'PVE' && currentPlayer === 2) return; // 電腦回合禁止手動輸入

    if (e.code === 'Space' || ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
    }

    if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') keys.a = false;
    if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') keys.d = false;
    if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') keys.w = false;
    if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') keys.s = false;

    if (e.code === 'Space') {
        releaseFire();
    }
}

// --- 蓄力射擊邏輯 ---
let chargePower = 0;

function updateCharging() {
    if (gameState !== STATES.CHARGING || isAutoAiming) return;
    
    // 蓄力只遞增，到100%自動發射
    chargePower += 1.5;
    if (chargePower >= 100) {
        chargePower = 100;
        document.getElementById('power-fill').style.width = `100%`;
        keys.space = false;
        fireProjectile();
        return;
    }

    // 更新力量條 UI
    document.getElementById('power-fill').style.width = `${chargePower}%`;
}

function fireProjectile() {
    const activePlayer = currentPlayer === 1 ? player1 : player2;
    const angleRad = activePlayer.angle * Math.PI / 180;
    
    // 計算大砲砲管出口位置
    const startX = activePlayer.x + Math.cos(angleRad) * activePlayer.barrelLength;
    const startY = activePlayer.y + Math.sin(angleRad) * activePlayer.barrelLength;

    if (pendingShots === 0) {
        lastChargePower = chargePower;
    }

    // 將百分比發射力道轉為物理速度，確保有最低初速
    const velocity = MIN_POWER + (lastChargePower / 100) * (MAX_POWER - MIN_POWER);

    const weaponType = activePlayer.selectedWeapon;
    let projRadius = 4;
    let projColor = activePlayer.color;

    if (weaponType === 2) {
        projRadius = 9; // 大砲彈體積較大
        projColor = COLORS.yellow; // 黃色發光，提示爆裂效果
    }

    // 處理連發邏輯 (若啟用雙發且為第一發)
    if (pendingShots === 0 && activePlayer.useDouble) {
        if (activePlayer.doubleUses > 0) {
            activePlayer.doubleUses--;
            pendingShots = 1; // 總共發射 2 發 (本發 + 1發 pending)
            activePlayer.useDouble = false; // 發射後重設為 false
            updateHUD();
        }
    }

    projectile = {
        x: startX,
        y: startY,
        vx: Math.cos(angleRad) * velocity,
        vy: Math.sin(angleRad) * velocity,
        radius: projRadius,
        color: projColor,
        weaponType: weaponType,
        trail: [], // 紀錄軌跡點做發光尾跡
        isGuided: isAutoAiming,
        startX: startX,
        startY: startY,
        targetX: autoAimTarget ? autoAimTarget.x : 0,
        targetY: autoAimTarget ? autoAimTarget.y : 0,
        totalFrames: autoAimTarget ? Math.max(45, Math.round(Math.abs(autoAimTarget.x - startX) / 8)) : 0,
        frameIndex: 0
    };

    // 關閉力量條
    document.getElementById('power-overlay').style.display = 'none';
    gameState = STATES.FLYING;

    // 砲口噴射粒子
    createMuzzleFlash(startX, startY, activePlayer.angle, projColor);
}

// 檢測大砲是否在橋體區段上
function isPlayerOnBridge(player) {
    const px = Math.round(player.x);
    if (px < BRIDGE_START || px > BRIDGE_END) return true; // 懸崖土地絕對安全
    // 只要高度地圖的值小於橋樑底部 Y 座標，就代表還有橋面可以踩
    return bridgeHeightMap[px] < BRIDGE_Y + BRIDGE_THICKNESS;
}

// 產生水花特效
function createSplash(x, y, color) {
    for (let i = 0; i < 20; i++) {
        const vx = (Math.random() - 0.5) * 4;
        const vy = -3 - Math.random() * 5;
        particles.push(new Particle(x, y, vx, vy, color, 4, 30));
    }
}

// --- 物理模擬與更新 ---
function updatePhysics() {
    // 1. 偵測並更新玩家地表高度 / 墜落狀態
    [player1, player2].forEach(p => {
        if (p.hp > 0 && !p.isFalling) {
            const px = Math.round(p.x);
            const xL = Math.max(0, Math.min(CANVAS_WIDTH - 1, px - 12));
            const xR = Math.max(0, Math.min(CANVAS_WIDTH - 1, px + 12));
            const yL = bridgeHeightMap[xL];
            const yR = bridgeHeightMap[xR];
            
            if (yL >= BRIDGE_Y + BRIDGE_THICKNESS && yR >= BRIDGE_Y + BRIDGE_THICKNESS) {
                // 完全被挖穿，進入墜落狀態
                p.isFalling = true;
                p.fallSpeed = 0;
                createDamageText(p.x, p.y - 40, "墜落中!", p.color);
            } else {
                // 緊貼地形平均高度
                p.y = (yL + yR) / 2 - 15;
            }
        }
        
        if (p.isFalling) {
            p.fallSpeed += 0.35; // 墜落重力
            p.y += p.fallSpeed;
            
            // 墜入電子海的瞬間產生水花與扣血
            if (p.y >= CANVAS_HEIGHT - 35 && p.y <= CANVAS_HEIGHT - 28) {
                createSplash(p.x, CANVAS_HEIGHT - 35, COLORS.magenta);
                shakeIntensity = 8;
            }
            
            // 掉出畫面外判定死亡
            if (p.y > CANVAS_HEIGHT + 30) {
                p.hp = 0;
                p.isFalling = false;
                if (!checkWinCondition()) {
                    startTurnSwitch();
                }
            }
        }
    });

    // 2. 大砲控制更新 (僅限當前玩家回合，墜落中無法控制)
    const activePlayer = currentPlayer === 1 ? player1 : player2;
    if ((gameState === STATES.PLAYING || gameState === STATES.CHARGING) && !activePlayer.isFalling) {
        if (keys.a) activePlayer.move(-1);
        if (keys.d) activePlayer.move(1);
        if (keys.w) activePlayer.rotate(-1);
        if (keys.s) activePlayer.rotate(1);
    }

    // 3. 砲彈飛行物理更新
    if (gameState === STATES.FLYING && projectile) {
        if (projectile.isGuided) {
            projectile.frameIndex++;
            const t = Math.min(1, projectile.frameIndex / projectile.totalFrames);
            projectile.x = projectile.startX + (projectile.targetX - projectile.startX) * t;
            
            // 彈道拋物線頂點：比起點/終點的最高處再往上 180 像素
            const peakHeight = Math.min(projectile.startY, projectile.targetY) - 180;
            projectile.y = (1 - t) * (1 - t) * projectile.startY + 2 * (1 - t) * t * peakHeight + t * t * projectile.targetY;
            
            // 軌跡記錄
            projectile.trail.push({ x: projectile.x, y: projectile.y });
            if (projectile.trail.length > 20) projectile.trail.shift();

            // 噴射微小尾跡粒子
            if (Math.random() < 0.4) {
                particles.push(new Particle(
                    projectile.x, projectile.y, 
                    (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 1, 
                    projectile.color, 4, 25
                ));
            }

            if (t >= 1) {
                // 根據當前射擊者，判定受擊目標是對方
                const targetPlayer = (currentPlayer === 1) ? player2 : player1;
                const hitTarget = (Math.abs(projectile.x - targetPlayer.x) < 15) ? targetPlayer : null;
                triggerExplosion(projectile.x, projectile.y, hitTarget, projectile.weaponType);
                return;
            }
        } else {
            // 風力與重力作用
            projectile.vx += wind * WIND_FACTOR;
            projectile.vy += GRAVITY;

            // 位置累加
            projectile.x += projectile.vx;
            projectile.y += projectile.vy;

            // 軌跡記錄
            projectile.trail.push({ x: projectile.x, y: projectile.y });
            if (projectile.trail.length > 20) projectile.trail.shift();

            // 噴射微小尾跡粒子
            if (Math.random() < 0.4) {
                particles.push(new Particle(
                    projectile.x, projectile.y, 
                    (Math.random() - 0.5) * 1, (Math.random() - 0.5) * 1, 
                    projectile.color, 4, 25
                ));
            }

        // 碰撞檢測：檢測是否擊中玩家（排除當前發射者，避免自爆）
        if (currentPlayer !== 1 && !player1.isFalling && checkCollision(projectile, player1)) {
            triggerExplosion(projectile.x, projectile.y, player1, projectile.weaponType);
            return;
        }

        if (currentPlayer !== 2 && !player2.isFalling && checkCollision(projectile, player2)) {
            triggerExplosion(projectile.x, projectile.y, player2, projectile.weaponType);
            return;
        }

        // 碰撞檢測：檢測是否擊中獨木橋地表 (由 Heightmap 動態判定，支援飛越彈坑)
        const projXInt = Math.round(projectile.x);
        if (projXInt >= 0 && projXInt < CANVAS_WIDTH) {
            const groundY = bridgeHeightMap[projXInt];
            // 只要砲彈的 Y 軸大於等於該 X 點的高度地圖值，即判定撞擊
            if (projectile.y >= groundY) {
                // 如果是射出橋外(例如左右土地外面)，判定為落水而非撞橋
                if (projXInt >= BRIDGE_START && projXInt <= BRIDGE_END && groundY >= BRIDGE_Y + BRIDGE_THICKNESS) {
                    // 已被挖空，砲彈直接穿過，不觸發撞擊
                } else {
                    triggerExplosion(projectile.x, projectile.y, null, projectile.weaponType);
                    return;
                }
            }
        }

        // 出界判定 (掉入水底或超出左右邊界)
        if (projectile.y > CANVAS_HEIGHT + 50 || projectile.x < -100 || projectile.x > CANVAS_WIDTH + 100) {
            projectile = null;
            if (pendingShots > 0) {
                pendingShots--;
                fireProjectile();
            } else {
                startTurnSwitch();
            }
        }
    }
}

    // 4. 粒子系統更新
    particles = particles.filter(p => p.update());

    // 5. 畫面震動更新
    if (shakeIntensity > 0.1) {
        screenShakeX = (Math.random() - 0.5) * shakeIntensity;
        screenShakeY = (Math.random() - 0.5) * shakeIntensity;
        shakeIntensity *= shakeDecay;
    } else {
        screenShakeX = 0;
        screenShakeY = 0;
        shakeIntensity = 0;
    }
}

function checkCollision(proj, target) {
    const dx = proj.x - target.x;
    const dy = proj.y - target.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return dist < (proj.radius + target.radius);
}

// 在獨木橋上挖洞 (從高度地圖中扣除圓形範圍)
function addBridgeHole(hx, hy, hr) {
    // 儲存此爆炸孔，用於視覺渲染 (使用 destination-out 擦除)
    bridgeHoles.push({ x: hx, y: hy, r: hr });

    // 更新物理地圖
    const startX = Math.max(0, Math.floor(hx - hr));
    const endX = Math.min(CANVAS_WIDTH - 1, Math.ceil(hx + hr));
    
    for (let x = startX; x <= endX; x++) {
        // 僅限於獨木橋區段進行地表修改
        if (x >= BRIDGE_START && x <= BRIDGE_END) {
            const dx = x - hx;
            const dy = Math.sqrt(hr * hr - dx * dx);
            const craterBottom = hy + dy;
            const craterTop = hy - dy;
            
            // 只要爆炸圈範圍切過當前高度
            if (craterBottom > bridgeHeightMap[x] && craterTop <= bridgeHeightMap[x]) {
                // 橋面下移（被挖去），深度不能超過橋底 Y 座標
                bridgeHeightMap[x] = Math.min(BRIDGE_Y + BRIDGE_THICKNESS, craterBottom);
            }
        }
    }
}

// 觸發爆炸與傷害計算
function triggerExplosion(x, y, directHitTarget, weaponType = 1) {
    projectile = null;
    gameState = STATES.EXPLODING;
    
    // 根據不同武器調整爆炸屬性
    const maxExplRadius = weaponType === 1 ? 35 : 70;
    const shake = weaponType === 1 ? 12 : 22; // 大裂地彈震動更大
    shakeIntensity = shake;

    // 建立爆炸特效圈
    explosions.push({
        x: x,
        y: y,
        currentRadius: 0,
        maxRadius: maxExplRadius,
        speed: weaponType === 1 ? 3.5 : 5
    });

    // 產生爆炸碎片粒子 (木屑、火花與煙霧)
    const particleCount = weaponType === 1 ? 25 : 55;
    for (let i = 0; i < particleCount; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * (weaponType === 1 ? 5 : 8);
        
        let color;
        const rand = Math.random();
        if (rand < 0.4) {
            color = '#815938'; // 木製碎片
        } else if (rand < 0.75) {
            color = '#e06e12'; // 火光橘色
        } else {
            color = '#5a5d63'; // 煙灰灰色
        }
        
        particles.push(new Particle(
            x, y, 
            Math.cos(angle) * speed, Math.sin(angle) * speed, 
            color, weaponType === 1 ? 4 : 6, 35
        ));
    }

    // 在獨木橋高度範圍內發生爆炸時進行挖洞
    if (y >= BRIDGE_Y - 20 && y <= BRIDGE_Y + BRIDGE_THICKNESS + 20) {
        const holeRadius = weaponType === 1 ? 22 : 40; // 小高爆彈挖 22px 缺口，大裂地彈挖 40px 缺口
        addBridgeHole(x, y, holeRadius);
    }

    // 傷害計算 (直接命中的傷害與範圍波及)
    calculateSplashDamage(x, y, weaponType);

    // 延遲後切換回合
    setTimeout(() => {
        explosions = [];
        const isGameOver = checkWinCondition();
        if (!isGameOver) {
            if (pendingShots > 0) {
                pendingShots--;
                fireProjectile();
            } else {
                startTurnSwitch();
            }
        }
    }, 1200);
}

function calculateSplashDamage(explX, explY, weaponType = 1) {
    const explosionRadius = weaponType === 1 ? 55 : 80;
    const maxDamage = weaponType === 1 ? 55 : 15;
    
    [player1, player2].forEach(p => {
        // 如果玩家已經掉落，不再計算傷害
        if (p.isFalling || p.hp <= 0) return;

        const dx = p.x - explX;
        const dy = p.y - explY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < explosionRadius) {
            // 距離越近傷害越高
            const damageFactor = 1 - (dist / explosionRadius);
            const damage = Math.round(maxDamage * damageFactor);
            p.hp = Math.max(0, p.hp - damage);
            
            // 飄字特效粒子 (扣血)
            createDamageText(p.x, p.y - 30, `-${damage} HP`, p.color);
        }
    });

    updateHUD();
}

// 切換回合準備
function startTurnSwitch() {
    gameState = STATES.SWITCH_TURN;
    setTimeout(() => {
        currentPlayer = currentPlayer === 1 ? 2 : 1;
        
        // 恢復下一個玩家的電量(燃料)並清除連發選擇
        const nextPlayer = currentPlayer === 1 ? player1 : player2;
        nextPlayer.fuel = 100;
        nextPlayer.useDouble = false;
        
        generateWind();
        updateHUD();
        gameState = STATES.PLAYING;

        // 如果是電腦回合且為 PVE 模式，啟動電腦 AI 決策
        if (currentPlayer === 2 && gameMode === 'PVE') {
            runAITurn();
        }
    }, 800);
}

function checkWinCondition() {
    if (player1.hp <= 0 && player2.hp <= 0) {
        showGameOver("雙方平手");
        return true;
    } else if (player1.hp <= 0) {
        showGameOver("PLAYER 2 獲勝");
        return true;
    } else if (player2.hp <= 0) {
        showGameOver("PLAYER 1 獲勝");
        return true;
    }
    return false;
}

function showGameOver(winnerText) {
    gameState = STATES.GAMEOVER;
    const textEl = document.getElementById('winner-text');
    textEl.innerText = winnerText;
    textEl.setAttribute('data-text', winnerText);

    // 第一階段記分：只計登入玩家的 VS AI 戰績（PVE 時玩家 1 是人類、玩家 2 是電腦）。
    // 2P 本地對戰不計分；平手不計分；未登入時 recordResult 內部會直接略過。
    if (gameMode === 'PVE' && window.WD && typeof window.WD.recordResult === 'function') {
        if (winnerText === 'PLAYER 1 獲勝') {
            window.WD.recordResult(true);
        } else if (winnerText === 'PLAYER 2 獲勝') {
            window.WD.recordResult(false);
        }
    }

    switchScreen('gameover-screen');
}

// 隨機產生風向
function generateWind() {
    // 風速介於 -5 (強左風) 到 +5 (強右風)
    wind = parseFloat((Math.random() * 10 - 5).toFixed(1));
    const arrowEl = document.getElementById('wind-arrow');
    const valueEl = document.getElementById('wind-value');

    valueEl.innerText = `${Math.abs(wind)} km/h`;
    
    if (wind > 0) {
        arrowEl.style.transform = 'rotate(0deg)';
        arrowEl.style.color = COLORS.yellow;
    } else if (wind < 0) {
        arrowEl.style.transform = 'rotate(180deg)';
        arrowEl.style.color = COLORS.yellow;
    } else {
        arrowEl.style.transform = 'scale(0)';
    }
}

function updateHUD() {
    // 血量條與角度
    document.getElementById('p1-hp').style.width = `${player1.hp}%`;
    document.getElementById('p1-hp-text').innerText = player1.hp;
    document.getElementById('p1-angle').innerText = Math.round(Math.abs(player1.angle));
    
    document.getElementById('p2-hp').style.width = `${player2.hp}%`;
    document.getElementById('p2-hp-text').innerText = player2.hp;
    document.getElementById('p2-angle').innerText = Math.round(Math.abs(player2.angle));

    // 武器名稱更新
    let p1WeaponText = player1.selectedWeapon === 1 ? '小高爆彈 (HE)' : '大裂地彈 (TERRA)';
    if (player1.useDouble) {
        p1WeaponText += ` + 連發 [雙彈] (剩餘 ${player1.doubleUses})`;
    } else {
        p1WeaponText += ` (連發剩餘 ${player1.doubleUses})`;
    }
    document.getElementById('p1-weapon').innerText = p1WeaponText;
    document.getElementById('p1-weapon').className = player1.useDouble ? 'neon-text-magenta' : (player1.selectedWeapon === 1 ? 'neon-text-cyan' : 'neon-text-yellow');
    
    let p2WeaponText = player2.selectedWeapon === 1 ? '小高爆彈 (HE)' : '大裂地彈 (TERRA)';
    if (player2.useDouble) {
        p2WeaponText += ` + 連發 [雙彈] (剩餘 ${player2.doubleUses})`;
    } else {
        p2WeaponText += ` (連發剩餘 ${player2.doubleUses})`;
    }
    document.getElementById('p2-weapon').innerText = p2WeaponText;
    document.getElementById('p2-weapon').className = player2.useDouble ? 'neon-text-magenta' : (player2.selectedWeapon === 1 ? 'neon-text-magenta' : 'neon-text-yellow');

    // 回合指示器
    const turnEl = document.getElementById('turn-indicator');
    if (currentPlayer === 1) {
        turnEl.innerText = "PLAYER 1 回合";
        turnEl.className = "turn-announcement p1-turn";
        document.querySelector('.p1-panel').classList.add('active');
        document.querySelector('.p2-panel').classList.remove('active');
        document.getElementById('fuel-value').innerText = Math.round(player1.fuel);
    } else {
        turnEl.innerText = "PLAYER 2 回合";
        turnEl.className = "turn-announcement p2-turn";
        document.querySelector('.p2-panel').classList.add('active');
        document.querySelector('.p1-panel').classList.remove('active');
        document.getElementById('fuel-value').innerText = Math.round(player2.fuel);
    }
}

// --- 繪製引擎 ---
function gameLoop() {
    updatePhysics();
    updateCharging();
    render();
    requestAnimationFrame(gameLoop);
}

function render() {
    // 1. 繪製精美森林大自然背景 (保持固定，不隨畫面震動偏移)
    if (imgBg.complete && imgBg.naturalWidth !== 0) {
        ctx.drawImage(imgBg, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    } else {
        ctx.fillStyle = COLORS.bg;
        ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    // 2. 繪製林間螢火蟲粒子系統 (同樣不震動)
    drawBackgroundGrid();

    ctx.save();
    
    // 僅在前景元素（橋體、車輪大砲、砲彈、爆炸效果）套用畫面震動
    ctx.translate(screenShakeX, screenShakeY);

    // 3. 繪製獨木橋與水面
    drawBridge();

    // 4. 繪製大砲
    player1.draw();
    player2.draw();

    // 5. 繪製射擊輔助預測虛線 (僅在玩家操控回合)
    if (gameState === STATES.PLAYING) {
        drawAimAssist();
    }

    // 6. 繪製飛行中的砲彈
    if (gameState === STATES.FLYING && projectile) {
        drawProjectile();
    }

    // 7. 繪製爆炸波
    drawExplosions();

    // 8. 繪製粒子系統
    particles.forEach(p => p.draw());

    ctx.restore();
}

function drawBackgroundGrid() {
    // 1. 繪製林間螢火蟲 (Fireflies) - 緩慢向上漂浮
    bgStars.forEach(star => {
        star.y -= 0.15;
        if (star.y < 0) star.y = BRIDGE_Y - 45;
        
        star.alpha += star.twinkleSpeed;
        if (star.alpha > 1 || star.alpha < 0.1) {
            star.twinkleSpeed = -star.twinkleSpeed;
        }
        ctx.fillStyle = `rgba(212, 167, 59, ${Math.max(0, Math.min(1, star.alpha * 0.7))})`; // 溫暖金色螢光
        ctx.beginPath();
        ctx.arc(star.x, star.y, star.size + 0.6, 0, Math.PI * 2);
        ctx.fill();
    });
}

function drawBridge() {
    // 1. 清除離屏畫布的快取像素，直接重複使用全域畫布防記憶體洩漏
    offCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // 2. 在離屏畫布上繪製左懸崖與右懸崖
    drawCliff(offCtx, 0, BRIDGE_START - 8, true);
    drawCliff(offCtx, BRIDGE_END + 8, CANVAS_WIDTH, false);

    // 3. 在離屏畫布上繪製整段巨木樹幹
    drawRawTrunk(offCtx);

    // 4. 使用 destination-out 對離屏畫布進行「圓形坑洞擦除」
    offCtx.save();
    offCtx.globalCompositeOperation = 'destination-out';
    bridgeHoles.forEach(hole => {
        offCtx.fillStyle = '#fff';
        offCtx.beginPath();
        offCtx.arc(hole.x, hole.y, hole.r, 0, Math.PI * 2);
        offCtx.fill();
    });
    offCtx.restore();

    // 5. 將挖完洞的離屏畫布一次性繪製到主畫面上
    ctx.drawImage(offCanvas, 0, 0);

    // 6. 繪製底部溪流水浪線
    drawLaserOcean();

    // 7. 獨木橋的缺口不需要顯示年輪 (已移除年輪斷面繪製)
}

// 輔助函式：繪製土地懸崖
function drawCliff(targetCtx, startX, endX, isLeft) {
    targetCtx.save();
    
    // 初始化岩石紋路模式
    if (!patRock && imgRock.complete) {
        patRock = ctx.createPattern(imgRock, 'repeat');
    }
    
    // 岩石漸層
    const cliffGrad = targetCtx.createLinearGradient(0, BRIDGE_Y, 0, CANVAS_HEIGHT);
    cliffGrad.addColorStop(0, '#363533');
    cliffGrad.addColorStop(0.5, '#262524');
    cliffGrad.addColorStop(1, '#181716');
    
    if (patRock) {
        targetCtx.fillStyle = patRock;
    } else {
        targetCtx.fillStyle = cliffGrad;
    }
    
    targetCtx.strokeStyle = '#201f1e';
    targetCtx.lineWidth = 3;
    
    targetCtx.beginPath();
    if (isLeft) {
        targetCtx.moveTo(startX, BRIDGE_Y);
        targetCtx.lineTo(endX, BRIDGE_Y);
        targetCtx.lineTo(endX - 14, BRIDGE_Y + 30);
        targetCtx.lineTo(endX - 2, BRIDGE_Y + 70);
        targetCtx.lineTo(endX - 27, BRIDGE_Y + 110);
        targetCtx.lineTo(endX - 12, CANVAS_HEIGHT - 35);
        targetCtx.lineTo(startX, CANVAS_HEIGHT - 35);
    } else {
        targetCtx.moveTo(startX, BRIDGE_Y);
        targetCtx.lineTo(endX, BRIDGE_Y);
        targetCtx.lineTo(endX, CANVAS_HEIGHT - 35);
        targetCtx.lineTo(startX + 12, CANVAS_HEIGHT - 35);
        targetCtx.lineTo(startX + 27, BRIDGE_Y + 110);
        targetCtx.lineTo(startX + 2, BRIDGE_Y + 70);
        targetCtx.lineTo(startX + 14, BRIDGE_Y + 30);
    }
    targetCtx.closePath();
    targetCtx.fill();
    targetCtx.stroke();

    // 陰影疊加使懸崖立體
    if (patRock) {
        targetCtx.save();
        targetCtx.globalCompositeOperation = 'multiply';
        targetCtx.fillStyle = cliffGrad;
        targetCtx.beginPath();
        if (isLeft) {
            targetCtx.moveTo(startX, BRIDGE_Y);
            targetCtx.lineTo(endX, BRIDGE_Y);
            targetCtx.lineTo(endX - 14, BRIDGE_Y + 30);
            targetCtx.lineTo(endX - 2, BRIDGE_Y + 70);
            targetCtx.lineTo(endX - 27, BRIDGE_Y + 110);
            targetCtx.lineTo(endX - 12, CANVAS_HEIGHT - 35);
            targetCtx.lineTo(startX, CANVAS_HEIGHT - 35);
        } else {
            targetCtx.moveTo(startX, BRIDGE_Y);
            targetCtx.lineTo(endX, BRIDGE_Y);
            targetCtx.lineTo(endX, CANVAS_HEIGHT - 35);
            targetCtx.lineTo(startX + 12, CANVAS_HEIGHT - 35);
            targetCtx.lineTo(startX + 27, BRIDGE_Y + 110);
            targetCtx.lineTo(startX + 2, BRIDGE_Y + 70);
            targetCtx.lineTo(startX + 14, BRIDGE_Y + 30);
        }
        targetCtx.closePath();
        targetCtx.fill();
        targetCtx.restore();
    }

    // 自然草地皮與藤蔓
    targetCtx.shadowBlur = 0;
    targetCtx.strokeStyle = '#2d7a29'; // 自然綠
    targetCtx.lineWidth = 6;
    targetCtx.beginPath();
    targetCtx.moveTo(startX, BRIDGE_Y);
    targetCtx.lineTo(endX, BRIDGE_Y);
    targetCtx.stroke();

    // 繪製精緻的木生雜草細節
    targetCtx.fillStyle = '#2d7a29';
    const minX = Math.min(startX, endX);
    const maxX = Math.max(startX, endX);
    for (let gx = minX + 15; gx < maxX - 15; gx += 25) {
        targetCtx.beginPath();
        targetCtx.moveTo(gx, BRIDGE_Y);
        targetCtx.lineTo(gx - 3, BRIDGE_Y - 6);
        targetCtx.lineTo(gx + 1, BRIDGE_Y - 9);
        targetCtx.lineTo(gx + 4, BRIDGE_Y - 5);
        targetCtx.lineTo(gx + 8, BRIDGE_Y);
        targetCtx.fill();
    }
    
    targetCtx.restore();
}

// 輔助函式：繪製未損壞的完整樹幹
function drawRawTrunk(targetCtx) {
    targetCtx.save();
    
    // 初始化木頭紋理
    if (!patWood && imgWood.complete) {
        patWood = ctx.createPattern(imgWood, 'repeat');
    }

    // 木製橋墩與繩索綁定細節
    targetCtx.shadowBlur = 0;
    targetCtx.fillStyle = '#422814';
    targetCtx.strokeStyle = '#23140a';
    targetCtx.lineWidth = 2.5;
    
    // 左木樁
    targetCtx.beginPath();
    targetCtx.rect(BRIDGE_START - 14, BRIDGE_Y - 10, 16, BRIDGE_THICKNESS + 20);
    targetCtx.fill();
    targetCtx.stroke();
    
    // 右木樁
    targetCtx.beginPath();
    targetCtx.rect(BRIDGE_END - 2, BRIDGE_Y - 10, 16, BRIDGE_THICKNESS + 20);
    targetCtx.fill();
    targetCtx.stroke();

    // 樹幹本體
    const width = BRIDGE_END - BRIDGE_START;
    const trunkGrad = targetCtx.createLinearGradient(0, BRIDGE_Y, 0, BRIDGE_Y + BRIDGE_THICKNESS);
    trunkGrad.addColorStop(0, '#2b1a0e');
    trunkGrad.addColorStop(0.3, '#4d301b');
    trunkGrad.addColorStop(0.5, '#694327');
    trunkGrad.addColorStop(0.8, '#3d2514');
    trunkGrad.addColorStop(1, '#1b1008');

    // 填滿樹幹：優先使用木頭紋理
    if (patWood) {
        targetCtx.fillStyle = patWood;
    } else {
        targetCtx.fillStyle = trunkGrad;
    }
    targetCtx.strokeStyle = '#23140a';
    targetCtx.lineWidth = 2.5;
    
    targetCtx.beginPath();
    targetCtx.rect(BRIDGE_START, BRIDGE_Y, width, BRIDGE_THICKNESS);
    targetCtx.fill();
    targetCtx.stroke();

    // 木製陰影疊加
    if (patWood) {
        targetCtx.save();
        targetCtx.globalCompositeOperation = 'multiply';
        const shadowGrad = targetCtx.createLinearGradient(0, BRIDGE_Y, 0, BRIDGE_Y + BRIDGE_THICKNESS);
        shadowGrad.addColorStop(0, 'rgba(0,0,0,0.65)');
        shadowGrad.addColorStop(0.3, 'rgba(0,0,0,0.1)');
        shadowGrad.addColorStop(0.5, 'rgba(255,255,255,0)');
        shadowGrad.addColorStop(0.7, 'rgba(0,0,0,0.1)');
        shadowGrad.addColorStop(1, 'rgba(0,0,0,0.75)');
        targetCtx.fillStyle = shadowGrad;
        targetCtx.fillRect(BRIDGE_START, BRIDGE_Y, width, BRIDGE_THICKNESS);
        targetCtx.restore();
    }

    targetCtx.restore();
}

// 輔助函式：繪製自然溪水
function drawLaserOcean() {
    ctx.save();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = '#2d5b75'; // 自然淡藍色
    ctx.lineWidth = 3;
    ctx.beginPath();
    
    // 使用固定的正弦波形，不隨時間流逝而起伏滾動
    for (let x = 0; x <= CANVAS_WIDTH; x += 15) {
        let waveY = (CANVAS_HEIGHT - 35) + Math.sin(x * 0.02) * 5;
        if (x === 0) ctx.moveTo(x, waveY);
        else ctx.lineTo(x, waveY);
    }
    ctx.stroke();
    
    ctx.lineTo(CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.lineTo(0, CANVAS_HEIGHT);
    ctx.closePath();
    ctx.fillStyle = 'rgba(45, 91, 117, 0.45)';
    ctx.fill();
    ctx.restore();
}

// 繪製樹幹被炸斷時的真實木質年輪斷面
function drawTrunkCrossSection(x, isLeftEnd) {
    const rx = Math.round(x);
    if (rx < BRIDGE_START || rx > BRIDGE_END) return;

    const topY = bridgeHeightMap[rx];
    const bottomY = BRIDGE_Y + BRIDGE_THICKNESS;
    const thickness = bottomY - topY;

    // 如果該點沒有木頭或厚度太薄（小於 6px），就不繪製年輪，防止殘影懸空
    if (thickness < 6) return;

    ctx.save();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#dbb58c';    // 淺木年輪肉
    ctx.strokeStyle = '#4a2f19';  // 深褐色年輪線
    ctx.lineWidth = 2.5;

    const centerY = topY + thickness / 2;
    const radiusX = 6;
    const radiusY = thickness / 2;

    ctx.beginPath();
    ctx.ellipse(rx, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(rx, centerY, radiusX * 0.75, radiusY * 0.75, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(rx, centerY, radiusX * 0.5, radiusY * 0.5, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.ellipse(rx, centerY, radiusX * 0.25, radiusY * 0.25, 0, 0, Math.PI * 2);
    ctx.stroke();

    // 實木中心芯
    ctx.fillStyle = '#3a220f';
    ctx.beginPath();
    ctx.arc(rx, centerY, 2.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}

function drawProjectile() {
    ctx.save();
    ctx.shadowBlur = 0;

    // 繪製黑色引信煙霧
    if (projectile.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(projectile.trail[0].x, projectile.trail[0].y);
        for (let i = 1; i < projectile.trail.length; i++) {
            ctx.lineTo(projectile.trail[i].x, projectile.trail[i].y);
        }
        ctx.strokeStyle = 'rgba(60, 62, 66, 0.4)';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.stroke();
    }

    // 繪製鑄鐵大砲彈本體
    ctx.fillStyle = '#333538';
    ctx.strokeStyle = '#1b1c1e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(projectile.x, projectile.y, projectile.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 火引信燃燒火花
    if (Math.random() < 0.7) {
        particles.push(new Particle(
            projectile.x - projectile.vx * 0.3,
            projectile.y - projectile.vy * 0.3,
            (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 1.5 - 1.2,
            '#e06e12', // 燃燒橘
            3,
            12
        ));
    }
    
    ctx.restore();
}

function drawExplosions() {
    explosions.forEach(exp => {
        exp.currentRadius += exp.speed;
        
        ctx.save();
        ctx.shadowBlur = 0;
        
        // 煙塵環
        ctx.strokeStyle = 'rgba(80, 80, 80, 0.6)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(exp.x, exp.y, exp.currentRadius, 0, Math.PI * 2);
        ctx.stroke();
        
        // 燃燒火光環
        ctx.fillStyle = `rgba(224, 110, 18, ${1 - exp.currentRadius / exp.maxRadius})`;
        ctx.beginPath();
        ctx.arc(exp.x, exp.y, exp.currentRadius * 0.8, 0, Math.PI * 2);
        ctx.fill();
        
        // 爆炸中心強光
        ctx.fillStyle = `rgba(255, 234, 0, ${1 - exp.currentRadius / exp.maxRadius})`;
        ctx.beginPath();
        ctx.arc(exp.x, exp.y, exp.currentRadius * 0.4, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.restore();
    });
}

function drawAimAssist() {
    const activePlayer = currentPlayer === 1 ? player1 : player2;
    const angleRad = activePlayer.angle * Math.PI / 180;
    
    let simX = activePlayer.x + Math.cos(angleRad) * activePlayer.barrelLength;
    let simY = activePlayer.y + Math.sin(angleRad) * activePlayer.barrelLength;
    
    const simPower = 9;
    let simVx = Math.cos(angleRad) * simPower;
    let simVy = Math.sin(angleRad) * simPower;

    ctx.save();
    ctx.strokeStyle = 'rgba(229, 204, 159, 0.45)'; // 溫暖羊皮紙色拋物線
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(simX, simY);

    for (let i = 0; i < 40; i++) {
        simVx += wind * WIND_FACTOR;
        simVy += GRAVITY;
        simX += simVx;
        simY += simVy;
        ctx.lineTo(simX, simY);
        
        if (simY >= BRIDGE_Y && simX >= BRIDGE_START && simX <= BRIDGE_END) break;
    }
    ctx.stroke();
    ctx.restore();
}

// --- 粒子類別與特效輔助 ---
class Particle {
    constructor(x, y, vx, vy, color, size, life) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.color = color;
        this.size = size;
        this.maxLife = life;
        this.life = life;
        this.type = 'normal'; // 'normal' 或 'text'
        this.text = '';
    }

    update() {
        this.x += this.vx;
        this.y += this.vy;
        this.life--;
        return this.life > 0;
    }

    draw() {
        const alpha = this.life / this.maxLife;
        ctx.save();
        ctx.globalAlpha = alpha;

        if (this.type === 'text') {
            ctx.fillStyle = this.color;
            ctx.font = 'bold 20px Orbitron';
            ctx.shadowBlur = 10;
            ctx.shadowColor = this.color;
            ctx.fillText(this.text, this.x, this.y);
        } else {
            ctx.shadowBlur = 8;
            ctx.shadowColor = this.color;
            ctx.fillStyle = this.color;
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size * alpha, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }
}

// 砲口閃光粒子
function createMuzzleFlash(x, y, angleDeg, color) {
    const rad = angleDeg * Math.PI / 180;
    for (let i = 0; i < 12; i++) {
        // 沿著砲管發射方向散開
        const spreadAngle = rad + (Math.random() - 0.5) * 0.5;
        const speed = 1 + Math.random() * 4;
        particles.push(new Particle(
            x, y, 
            Math.cos(spreadAngle) * speed, Math.sin(spreadAngle) * speed, 
            color, 4, 15
        ));
    }
}

// 飄字傷害特效
function createDamageText(x, y, text, color) {
    const p = new Particle(x, y, (Math.random() - 0.5) * 1.5, -1.5, color, 0, 45);
    p.type = 'text';
    p.text = text;
    particles.push(p);
}

// --- 電腦對戰 AI 邏輯 ---
function runAITurn() {
    if (gameState !== STATES.PLAYING || currentPlayer !== 2 || gameMode !== 'PVE') return;

    // 1. 決定是否要移動 (AI 隨機往左或往右走一點，增加趣味性)
    const shouldMove = Math.random() < 0.5;
    let moveSteps = 0;
    let moveDir = 0;
    if (shouldMove && player2.fuel > 20) {
        moveSteps = Math.floor(Math.random() * 15) + 5;
        // 80%機率靠近玩家 20%機率遠離
        moveDir = Math.random() < 0.8 ? (player1.x < player2.x ? -1 : 1) : (player1.x < player2.x ? 1 : -1);
    }

    // 2. 決定武器與連發：智慧戰術選擇
    // 如果玩家 1 站在獨木橋上，且該位置的橋身已經有些被挖薄了，AI 會優先選「大裂地彈 (TERRA)」挖穿它！
    const p1XInt = Math.round(player1.x);
    const isP1OnBridge = p1XInt >= BRIDGE_START && p1XInt <= BRIDGE_END;
    const isBridgeThin = isP1OnBridge && (bridgeHeightMap[p1XInt] > BRIDGE_Y + 12);

    if (isBridgeThin) {
        player2.selectedWeapon = 2; // 挖穿計畫：優先大裂地彈
    } else {
        player2.selectedWeapon = Math.random() < 0.4 ? 2 : 1;
    }

    // 當有連發次數時，AI 在玩家 HP 較低或有機會挖穿時，以 70% 的高機率發動雙彈連發！
    if (player2.doubleUses > 0 && (player1.hp < 60 || isBridgeThin || Math.random() < 0.3)) {
        player2.useDouble = true;
    }
    updateHUD();

    // 3. 執行移動動畫，然後進行調整角度與蓄力
    let currentStep = 0;
    function aiMoveStep() {
        if (currentStep < moveSteps && player2.fuel > 5) {
            player2.move(moveDir);
            currentStep++;
            setTimeout(aiMoveStep, 60);
        } else {
            aiAimAndFire();
        }
    }
    
    if (moveSteps > 0) {
        setTimeout(aiMoveStep, 400);
    } else {
        aiAimAndFire();
    }

    function aiAimAndFire() {
        let targetX = player1.x;
        let targetY = player1.y;

        // 如果電腦使用大砲彈 (selectedWeapon === 2)，目標設在玩家旁邊 (往右偏移 24px，即獨木橋內側)
        if (player2.selectedWeapon === 2) {
            targetX = player1.x + 24;
            const mapX = Math.max(0, Math.min(CANVAS_WIDTH - 1, Math.round(targetX)));
            targetY = bridgeHeightMap[mapX] - 15;
            createDamageText(player2.x, player2.y - 45, "電腦戰術挖地！", COLORS.yellow);
        } else {
            createDamageText(player2.x, player2.y - 45, "電腦精準直擊！", COLORS.cyan);
        }

        autoAimTarget = { x: targetX, y: targetY };
        isAutoAiming = true; // 啟用引導彈道，保證必中

        // 計算目標角度
        const dx = targetX - player2.x;
        const dy = targetY - player2.y;
        const angleToPlayer = Math.atan2(dy, dx) * 180 / Math.PI; // 通常在 -130 到 -160 之間
        
        // 聰明電腦：100% 精確對準玩家中心點，不再加入隨機瞄準角度偏差
        const targetAngle = Math.max(-175, Math.min(-95, angleToPlayer));
        
        // 砲管旋轉動畫
        let angleDiff = targetAngle - player2.angle;
        const steps = Math.abs(Math.round(angleDiff / 1.5));
        const rotateDir = angleDiff > 0 ? 1 : -1;
        
        let rotateStep = 0;
        function aiRotateStep() {
            if (rotateStep < steps) {
                player2.rotate(rotateDir);
                rotateStep++;
                setTimeout(aiRotateStep, 45);
            } else {
                aiFire();
            }
        }
        
        if (steps > 0) {
            setTimeout(aiRotateStep, 300);
        } else {
            aiFire();
        }
        
        function aiFire() {
            // 智慧電腦完美解析物理發射軌跡，將重力與風阻完全代入方程式計算
            const dx = player1.x - player2.x;
            const dy = player1.y - player2.y;
            const angleRad = player2.angle * Math.PI / 180;
            const ax = wind * WIND_FACTOR;
            const ay = GRAVITY;

            // 解 tan(theta) = (dy - 0.5 * ay * t^2) / (dx - 0.5 * ax * t^2)
            // 得 t^2 = (dy - dx * tan(theta)) / (0.5 * ay - 0.5 * ax * tan(theta))
            const tanTh = Math.tan(angleRad);
            const num = dy - dx * tanTh;
            const den = 0.5 * ay - 0.5 * ax * tanTh;
            const t2 = num / den;

            let requiredVel = 8;
            if (t2 > 0) {
                const t = Math.sqrt(t2);
                const vx = (dx - 0.5 * ax * t2) / t;
                const vy = (dy - 0.5 * ay * t2) / t;
                requiredVel = Math.sqrt(vx * vx + vy * vy);
            } else {
                // 回退算法
                const dist = Math.abs(dx);
                const sin2 = Math.sin(2 * Math.abs(angleRad)) || 0.5;
                requiredVel = Math.sqrt((dist * ay) / sin2) + wind * WIND_FACTOR * 12;
            }
            
            // 將初速轉換為 0-100% 蓄力百分比
            let idealPower = ((requiredVel - MIN_POWER) / (MAX_POWER - MIN_POWER)) * 100;
            
            // 聰明電腦：移除發射隨機误差，達到 100% 神射手精準度
            const targetPower = Math.max(20, Math.min(100, idealPower));
            
            // 開始蓄力動畫
            gameState = STATES.CHARGING;
            chargePower = 0;
            document.getElementById('power-overlay').style.display = 'flex';
            
            const chargeInterval = setInterval(() => {
                if (gameState !== STATES.CHARGING) {
                    clearInterval(chargeInterval);
                    return;
                }
                chargePower += 2;
                if (chargePower >= targetPower) {
                    chargePower = targetPower;
                    document.getElementById('power-fill').style.width = `${chargePower}%`;
                    clearInterval(chargeInterval);
                    setTimeout(() => {
                        fireProjectile();
                        isAutoAiming = false; // 發射後解鎖狀態
                    }, 200);
                } else {
                    document.getElementById('power-fill').style.width = `${chargePower}%`;
                }
            }, 25);
        }
    }
}

// --- 自動瞄準 (Auto-Aim) 外掛功能 ---
function triggerAutoAim() {
    if (gameState !== STATES.PLAYING || currentPlayer !== 1 || isAutoAiming) return;

    isAutoAiming = true; // 鎖定狀態，防止二次觸發與重疊輸入

    let targetX = player2.x;
    let targetY = player2.y;

    // 如果使用大砲彈 (selectedWeapon === 2)，目標設在對手大砲旁邊 (往左偏移 24px，即獨木橋內側)
    if (player1.selectedWeapon === 2) {
        targetX = player2.x - 24;
        const mapX = Math.max(0, Math.min(CANVAS_WIDTH - 1, Math.round(targetX)));
        targetY = bridgeHeightMap[mapX] - 15;
        createDamageText(player1.x, player1.y - 45, "戰術挖地瞄準！", COLORS.yellow);
    } else {
        createDamageText(player1.x, player1.y - 45, "精準打擊瞄準！", COLORS.cyan);
    }

    autoAimTarget = { x: targetX, y: targetY };

    const dx = targetX - player1.x;
    const dy = targetY - player1.y;
    const ax = wind * WIND_FACTOR;
    const ay = GRAVITY;

    let bestAngle = player1.angle;
    let bestPower = 50;
    let found = false;
    let minDiff = Infinity;

    // 搜尋最接近 -45 度的完美彈道角度與對應的力道
    for (let testAngle = -80; testAngle <= -10; testAngle += 0.5) {
        const angleRad = testAngle * Math.PI / 180;
        const tanTh = Math.tan(angleRad);
        const num = dy - dx * tanTh;
        const den = 0.5 * ay - 0.5 * ax * tanTh;
        const t2 = num / den;
        if (t2 > 0) {
            const t = Math.sqrt(t2);
            const vx = (dx - 0.5 * ax * t2) / t;
            const vy = (dy - 0.5 * ay * t2) / t;
            if (vx > 0) {
                const vel = Math.sqrt(vx * vx + vy * vy);
                const power = ((vel - MIN_POWER) / (MAX_POWER - MIN_POWER)) * 100;
                if (power >= 20 && power <= 100) {
                    const anglePrefDiff = Math.abs(testAngle - (-45));
                    if (anglePrefDiff < minDiff) {
                        minDiff = anglePrefDiff;
                        bestAngle = testAngle;
                        bestPower = power;
                        found = true;
                    }
                }
            }
        }
    }

    if (!found) {
        // 回退算法
        const angleToPlayer = Math.atan2(dy, dx) * 180 / Math.PI;
        bestAngle = Math.max(-85, Math.min(-15, angleToPlayer - 15));
        const angleRad = bestAngle * Math.PI / 180;
        const dist = Math.abs(dx);
        const sin2 = Math.sin(2 * Math.abs(angleRad)) || 0.5;
        const vel = Math.sqrt((dist * ay) / sin2) + wind * WIND_FACTOR * 12;
        bestPower = Math.max(20, Math.min(100, ((vel - MIN_POWER) / (MAX_POWER - MIN_POWER)) * 100));
    }

    // 暫時將狀態改為 CHARGING 防止玩家在動畫期間手動輸入
    gameState = STATES.CHARGING;

    // 砲管旋轉動畫
    let angleDiff = bestAngle - player1.angle;
    const steps = Math.abs(Math.round(angleDiff / 1.5));
    const rotateDir = angleDiff > 0 ? 1 : -1;

    let rotateStep = 0;
    function autoRotateStep() {
        if (rotateStep < steps) {
            player1.rotate(rotateDir);
            rotateStep++;
            setTimeout(autoRotateStep, 30);
        } else {
            player1.angle = bestAngle;
            const displayAngle = Math.round(Math.abs(player1.angle));
            const angleEl = document.getElementById('p1-angle');
            if (angleEl) angleEl.innerText = displayAngle;
            autoFire();
        }
    }

    if (steps > 0) {
        autoRotateStep();
    } else {
        autoFire();
    }

    function autoFire() {
        chargePower = 0;
        const powerOverlay = document.getElementById('power-overlay');
        const powerFill = document.getElementById('power-fill');
        if (powerOverlay) powerOverlay.style.display = 'flex';

        const chargeInterval = setInterval(() => {
            chargePower += 2.5;
            if (chargePower >= bestPower) {
                chargePower = bestPower;
                if (powerFill) powerFill.style.width = `${chargePower}%`;
                clearInterval(chargeInterval);
                setTimeout(() => {
                    fireProjectile();
                    isAutoAiming = false; // 發射後解鎖狀態
                }, 200);
            } else {
                if (powerFill) powerFill.style.width = `${chargePower}%`;
            }
        }, 20);
    }
}

