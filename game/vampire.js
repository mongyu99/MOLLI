// 뱀서 탭: 화면 공유로 게임을 보고, 몰리 뇌로 이동 방향을 정해서, 로컬 브릿지로 키를 보낸다.
// 브라우저는 다른 프로그램을 조작할 수 없기 때문에 실제 입력만 bot/bridge.py가 맡는다.
//
// 마우스는 쓰지 않는다. 모니터가 여러 대면 게임 창이 어느 모니터에 있는지 알 수 없어서
// 클릭이 주 모니터로 튀어버린다. 키보드는 활성화된 창으로 그냥 들어가므로 그 문제가 없다.
(function () {
  const DIRS = [
    { name: "위", keys: ["w"], dx: 0, dy: -1 },
    { name: "오른위", keys: ["w", "d"], dx: 1, dy: -1 },
    { name: "오른", keys: ["d"], dx: 1, dy: 0 },
    { name: "오른아래", keys: ["s", "d"], dx: 1, dy: 1 },
    { name: "아래", keys: ["s"], dx: 0, dy: 1 },
    { name: "왼아래", keys: ["s", "a"], dx: -1, dy: 1 },
    { name: "왼", keys: ["a"], dx: -1, dy: 0 },
    { name: "왼위", keys: ["w", "a"], dx: -1, dy: -1 },
  ];
  DIRS.forEach((d) => {
    const len = Math.hypot(d.dx, d.dy);
    d.ux = d.dx / len;
    d.uy = d.dy / len;
  });

  const AW = 480; // 분석 해상도 (전체 화면을 받으므로 조금 키웠다)
  const AH = 270;

  // 캐릭터 주변을 격자 지도로 본다.
  // 이전에는 8방향 밀도 32개로 뭉뚱그렸는데, 그러면 "적이 많은 쪽"과 "적 사이에 틈이 있는 쪽"이
  // 똑같아 보인다. 뱀서에서 죽는 이유는 거의 포위인데 그 틈을 못 보면 빠져나갈 수가 없다.
  const GRID_N = 24;
  const CELLS = GRID_N * GRID_N;

  // 격자 칸마다 어느 방향/얼마나 먼지는 화면 비율이 같으면 매 프레임 같으므로 미리 계산해둔다.
  //
  // 예전에는 화면 높이를 지름으로 하는 원 안만 봤다. 16:9 에서는 넓이의 44% 뿐이고
  // 좌우 20% 씩은 아예 안 봤다. 뱀서는 몬스터가 화면 밖에서 걸어 들어오므로 좌우 끝이
  // 몬스터가 처음 보이는 자리인데, 거기를 못 봐서 가까이 와서야 반응했다.
  //
  // 지금은 격자가 화면 사각형 전체를 덮는다. 다만 거리는 실제 픽셀 거리로 잰다 —
  // 칸 좌표로 재면 가로가 더 길어서 옆의 적이 실제보다 가깝게 계산된다.
  // 거리 단위는 예전과 같은 "화면 높이의 절반" 이라 좌우 끝은 약 1.8 이 된다.
  const cellDir = new Int8Array(CELLS).fill(-1);
  const cellDist = new Float32Array(CELLS);
  let geomAspect = 0;
  const CHAR_R = 0.12; // 캐릭터 반경 (화면 높이 절반 단위)

  function buildCellGeometry(aspect) {
    geomAspect = aspect;
    cellDir.fill(-1);
    for (let gy = 0; gy < GRID_N; gy++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        const i = gy * GRID_N + gx;
        // 칸 가운데의 실제 위치 (화면 높이의 절반 단위)
        const nx = (((gx + 0.5) / GRID_N) * 2 - 1) * aspect;
        const ny = ((gy + 0.5) / GRID_N) * 2 - 1;
        const dist = Math.hypot(nx, ny);
        cellDist[i] = dist;
        // 캐릭터 자신은 제외한다. 예전 기준(0.06)은 격자 칸 가운데보다 작아서 실제로는
        // 한 칸도 빠지지 않았다. 움직임으로 적을 가르면 캐릭터의 걷는 모션이 "움직이는 것"
        // 으로 잡혀 자기 자신을 적으로 보게 되므로, 캐릭터 크기만큼(화면 높이의 약 6%) 뺀다.
        if (dist < CHAR_R) continue;
        const ang = Math.atan2(ny, nx);
        let di = Math.round((ang + Math.PI / 2) / (Math.PI / 4)) % 8;
        if (di < 0) di += 8;
        cellDir[i] = di;
      }
    }
  }
  buildCellGeometry(AW / AH);

  const STATES = {
    play: "플레이 중",
    levelup: "레벨업 선택",
    menu: "시작/메뉴",
    dead: "사망/결과",
    chest: "보상 상자",
    revive: "부활",
  };
  // 기본으로 아는 화면들. 여기에 사용자가 만든 종류가 더해진다 —
  // 게임마다 화면은 다르고, 뱀서만 해도 이 여섯 개로는 모자란다.
  // "이건 캐릭터 고르는 화면이야" 라고 하면 그 자리에서 새 종류가 생긴다.
  const BUILTIN_STATES = Object.keys(STATES);
  // 실제로 채우는 건 아래 load() 가 만들어진 다음이다 (여기서 부르면 TDZ 로 터진다)
  let customStates = {}; // key -> 한국어 이름

  // 플레이가 아닌 화면에서는 몰리가 움직이지 않고 무엇을 누를지 정한다.
  const pausedStates = () => Object.keys(STATES).filter((k) => k !== "play");

  // 새 종류의 키는 프롬프트에도 들어가므로 영문 소문자로만 받는다.
  function addState(key, label) {
    const k = String(key || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
    const ko = String(label || "").trim().slice(0, 12);
    if (!k || !ko || k.length > 24 || STATES[k]) return null;
    STATES[k] = ko;
    customStates[k] = ko;
    save("customStates", customStates);
    renderTeachButtons();
    return k;
  }
  const STORE = "molli.vs2";

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  // 화면에서 완전히 떼어놓으면 브라우저가 프레임을 디코딩하지 않는 경우가 있다
  video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0.01;pointer-events:none;left:0;bottom:0;";
  document.body.appendChild(video);

  const work = document.createElement("canvas");
  work.width = AW;
  work.height = AH;
  const wctx = work.getContext("2d", { willReadFrequently: true });

  const view = document.getElementById("vsView");
  const vctx = view.getContext("2d");

  const el = {};
  [
    "vsShare", "vsDemo", "vsRun", "vsStop", "vsBridge", "vsLive", "vsDebug", "vsLogOn",
    "vsEnemyThr", "vsEnemyThrVal", "vsGemThr", "vsGemThrVal", "vsStatus", "vsState",
    "vsFeat", "vsDir", "vsEnemies", "vsGems", "vsFps", "vsHp", "vsXp", "vsWindow", "vsWindowNow", "vsWindowState", "vsMarks",
    "vsAvoid", "vsGreed", "vsAlpha", "vsAlphaVal", "vsRuns", "vsRunNow", "vsReward", "vsMenuStats", "vsModel", "vsLlmOn", "vsLlmState", "vsCards",
    "vsIdOn", "vsIdState", "vsGoal", "vsAskScreen", "vsAskRemember", "vsAskResult",
    "vsTellText", "vsTellBtn", "vsHints",
    "vsGoalRepeat", "vsGoalState", "vsRunResult", "vsTeachBtns", "vsReadLog",
    "vsTestImg", "vsTestPaste", "vsTestState",
    "vsBlindMode", "vsBlindStats", "vsProbeBtn", "vsProbeResult",
    "vsSight", "vsSightTable", "vsSightWhy", "vsEnemyMode", "vsMoveThr", "vsMoveThrVal", "vsDemoPause", "vsNavKeys",
    "vsRegionForm", "vsRegionLabel", "vsRegionScope", "vsRegionAsk", "vsRegionSave",
    "vsRegionCancel", "vsRegionState", "vsRegionList", "vsUiBlue", "vsUiThr", "vsUiThrVal", "vsUiColor", "vsUiLearn", "vsUiForget", "vsOcrOn", "vsOcrNow", "vsOcrResult", "vsOcrWords", "vsRemoteCode", "vsRemoteRevoke", "vsRemoteState",
  ].forEach((id) => (el[id] = document.getElementById(id)));

  const logger = createLogger("vsLog", { max: 60 });

  // 몰리는 세 탭이 같이 쓰는 요소가 하나뿐이라 복사할 수 없다.
  // 뱀서 탭에서는 왼쪽 위로 옮기고, 나가면 원래 오른쪽 칼럼 자리로 돌려놓는다.
  // 캔버스는 id 로 참조되므로 DOM 을 옮겨도 그리던 내용은 그대로 남는다.
  function placeMolli() {
    const molli = document.querySelector(".molli-column");
    const slot = document.getElementById("vsMolliSlot");
    const layout = document.querySelector(".layout");
    if (!molli || !slot || !layout) return;
    const onVamp = document.getElementById("panel-vamp")?.classList.contains("is-active");
    const want = onVamp ? slot : layout;
    if (molli.parentElement !== want) want.appendChild(molli);
  }
  // 게임 선택(tabs.js)이 화면을 바꿀 때마다 알려준다.
  document.addEventListener("gamechange", placeMolli);
  placeMolli();

  // 왼쪽 메뉴: 고른 것만 보여준다
  // "모니터링" 은 시야·로그·레벨업 읽은 것을 한 화면에 같이 보여준다.
  // 나머지 메뉴는 고른 것 하나만 보여준다.
  const MONITOR_SECS = ["see", "log", "read"];

  function showSection(sec) {
    const monitor = sec === "monitor";
    document.querySelectorAll(".vs-menu-btn").forEach((x) =>
      x.classList.toggle("is-active", x.dataset.sec === sec)
    );
    document.querySelector(".vs-main")?.classList.toggle("is-monitor", monitor);
    document.querySelectorAll(".vs-sec").forEach((el2) =>
      el2.classList.toggle(
        "is-active",
        monitor ? MONITOR_SECS.includes(el2.dataset.sec) : el2.dataset.sec === sec
      )
    );
    try { localStorage.setItem(STORE + ".menu", JSON.stringify(sec)); } catch (e) {}
  }
  document.querySelectorAll(".vs-menu-btn").forEach((b) =>
    b.addEventListener("click", () => showSection(b.dataset.sec))
  );

  // 로그 줄마다 "몇 번째 판의 몇 분 몇 초"를 앞에 붙인다.
  // 나중에 되짚을 때 어느 판의 일인지 알 수 없으면 기록이 반쪽짜리다.
  const rawPush = logger.push.bind(logger);
  logger.push = (html, kind) => rawPush(runStamp() + html, kind);

  function runNo() {
    return history.length + (run.active ? 1 : 0);
  }

  function runStamp() {
    if (run.active) {
      const sec = Math.max(0, (performance.now() - run.startedAt) / 1000);
      const mm = Math.floor(sec / 60);
      const ss = Math.floor(sec % 60).toString().padStart(2, "0");
      return `<span class="dim">[${runNo()}판 ${mm}:${ss}]</span> `;
    }
    // 판과 판 사이. 방금 끝난 판이 몇 번째였는지를 보여주는 편이 되짚기 쉽다.
    if (history.length) return `<span class="dim">[${history.length}판 뒤]</span> `;
    return '<span class="dim">[시작 전]</span> ';
  }

  // ---- 저장되는 설정 ----
  const load = (k, d) => {
    try {
      return JSON.parse(localStorage.getItem(STORE + "." + k)) ?? d;
    } catch (e) {
      return d;
    }
  };
  const save = (k, v) => localStorage.setItem(STORE + "." + k, JSON.stringify(v));

  let gameRect = load("game", null); // {x,y,w,h} 0~1 정규화
  let hpRect = load("hp", null);
  let xpRect = load("xp", null);
  let hpColor = load("hpColor", null);
  let cardRect = load("cards", null); // 레벨업 창이 뜨는 영역 (카드 + 새로고침·건너뛰기·삭제)
  // 상태 -> [{ t: 썸네일, note: 그 화면에 대한 사용자 메모 }]
  // 예전에는 썸네일 배열만 저장했다. 그때 저장해둔 것도 그대로 읽히게 한 번 변환한다.
  // 사용자가 만든 화면 종류를 기본 목록에 합친다
  customStates = load("customStates", {});
  Object.assign(STATES, customStates);

  let taught = load("taught", {});
  for (const [name, samples] of Object.entries(taught)) {
    taught[name] = (samples || []).map((s) => (Array.isArray(s) ? { t: s, note: "" } : s));
  }

  // ---- 상태 특징: 썸네일 ----
  // 숫자 몇 개(밝기·움직임)로는 레벨업 화면과 사망 화면을 못 가른다.
  // 화면을 아주 작게 줄인 썸네일을 통째로 비교하면 확실히 구분된다.
  const TW = 16;
  const TH = 10;
  let prevThumb = null;
  let motionEma = 0;

  // ---- 움직임으로 적 가르기 ----
  // 게임 영역을 MW x MH 흑백으로 줄여 들고 있다가, 다음 프레임과 비교한다.
  const MW = 160, MH = 90;
  const SHIFT_R = 6;        // 한 프레임에 카메라가 움직일 수 있는 최대 칸 수
  const ALIGN_BAD = 26;     // 가장 잘 겹쳐도 이만큼 다르면 장면이 바뀐 것 — 이 프레임은 색으로 판단
  let prevGray = null;
  let lastShift = { dx: 0, dy: 0, err: 0, ok: false };
  let lastResid = null;
  let lastFreshAt = 0;
  const STILL_MS = 300; // 이보다 오래 같은 장이면 정말 멈춘 화면으로 본다
  const ZERO_RESID = new Float32Array(MW * MH); // "아무것도 안 움직인다"

  // 두 장이 사실상 같은가 (영상이 아직 다음 장을 안 준 경우)
  function sameFrame(a, b) {
    let e = 0, n = 0;
    for (let i = 0; i < a.length; i += 7) { e += Math.abs(a[i] - b[i]); n++; }
    return e / n < 0.4;
  }

  function grayFrame(px, gx, gy, gw, gh) {
    const out = new Float32Array(MW * MH);
    for (let y = 0; y < MH; y++) {
      const sy = Math.min(AH - 1, (gy + ((y + 0.5) / MH) * gh) | 0);
      for (let x = 0; x < MW; x++) {
        const sx = Math.min(AW - 1, (gx + ((x + 0.5) / MW) * gw) | 0);
        const i = (sy * AW + sx) * 4;
        out[y * MW + x] = (px[i] + px[i + 1] + px[i + 2]) / 3;
      }
    }
    return out;
  }

  // 이전 프레임을 (dx,dy) 만큼 옮겼을 때 지금 프레임과 가장 잘 겹치는 값을 찾는다.
  // 가장자리는 HUD(경험치 바, 타이머)라서 카메라와 같이 움직이지 않는다 — 안쪽만 본다.
  function estimateShift(cur, prev) {
    const m = SHIFT_R + 10;
    let best = { dx: 0, dy: 0, err: Infinity };
    for (let dy = -SHIFT_R; dy <= SHIFT_R; dy++) {
      for (let dx = -SHIFT_R; dx <= SHIFT_R; dx++) {
        let e = 0, n = 0;
        for (let y = m; y < MH - m; y += 2) {
          const py = y - dy;
          for (let x = m; x < MW - m; x += 2) {
            e += Math.abs(cur[y * MW + x] - prev[py * MW + (x - dx)]);
            n++;
          }
        }
        e /= n;
        if (e < best.err) best = { dx, dy, err: e };
      }
    }
    best.ok = best.err < ALIGN_BAD;
    return best;
  }

  // 카메라 이동을 빼고도 남는 차이. 여기서 큰 곳이 스스로 움직이는 것이다.
  function residualMap(cur, prev, sh) {
    const r = new Float32Array(MW * MH);
    for (let y = 0; y < MH; y++) {
      const py = y - sh.dy;
      if (py < 0 || py >= MH) continue;
      for (let x = 0; x < MW; x++) {
        const px = x - sh.dx;
        if (px < 0 || px >= MW) continue;
        r[y * MW + x] = Math.abs(cur[y * MW + x] - prev[py * MW + px]);
      }
    }
    return r;
  }

  // ---- 게임이 멈췄나 ----
  // 레벨업 창·메뉴는 가운데에 뜨고 그 뒤 전장은 멈춘다. 가운데를 빼고 바깥 전장만 보면
  // 창의 반짝임에 속지 않는다. 카메라도 안 움직여야 멈춘 것이다.
  const STILL_RATIO = 0.003; // 바깥쪽에서 스스로 움직이는 점이 이 비율 미만이면 멈춘 것
  const CENTER_SKIP = 0.8;   // 가운데 이만큼(화면 높이 절반 단위)은 창이 뜨는 자리라 뺀다
  let stillSince = 0;
  let hintedIdOff = false;

  // 레벨업 영역을 지정했으면 그 사각형을(조금 넉넉하게) 빼고, 아니면 가운데 원을 뺀다.
  // g: 게임 영역 (분석 캔버스 픽셀). 움직임 버퍼는 게임 영역을 MW x MH 로 줄인 것이다.
  function outerMotion(resid, moveThr, aspect, g) {
    let skip = null;
    if (cardRect && g) {
      const pad = 0.04;
      const toX = (v) => ((v * AW - g.gx) / g.gw) * MW;
      const toY = (v) => ((v * AH - g.gy) / g.gh) * MH;
      skip = {
        x0: toX(cardRect.x - pad), x1: toX(cardRect.x + cardRect.w + pad),
        y0: toY(cardRect.y - pad), y1: toY(cardRect.y + cardRect.h + pad),
      };
    }
    let m = 0, n = 0;
    for (let y = Math.ceil(MH * 0.1); y < MH; y += 2) { // 맨 위 HUD 는 뺀다
      const ny = (y - MH / 2) / (MH / 2);
      for (let x = 0; x < MW; x += 2) {
        if (skip) {
          if (x >= skip.x0 && x <= skip.x1 && y >= skip.y0 && y <= skip.y1) continue;
        } else {
          const nx = ((x - MW / 2) / (MW / 2)) * aspect;
          if (Math.hypot(nx, ny) < CENTER_SKIP) continue;
        }
        n++;
        if (resid[y * MW + x] > moveThr) m++;
      }
    }
    return n ? m / n : 0;
  }

  // ---- 파란 창: 게임이 아닌 화면 ----
  // 움직임만으로 멈춤을 보면, 판이 막 시작해 아무것도 안 움직일 때 플레이를 못 알아본다.
  // 몰리가 키를 안 누르니 카메라도 안 움직이고, 그러니 계속 "멈춘 화면" 으로 남는다.
  // 뱀서의 창(레벨업·메뉴·캐릭터 선택·결과)은 넓은 파란 판이다. 전장에도 파란 젬이 있지만
  // 점처럼 작아서 8x8 칸을 절반 넘게 채우지 못한다. 칸을 채울 만큼 넓게 파란 곳이
  // 일정 비율을 넘으면 창이 뜬 것 — 게임이 아니다.
  const UI_CELL = 8;         // 분석 캔버스 픽셀 (원본 1920 폭이면 약 32픽셀)
  const UI_FILL = 0.5;       // 칸 안의 파란 점이 이 비율을 넘으면 파란 칸
  const UI_HOLD = 200;       // 파란 창이 이만큼 이어져야 창으로 본다 (한 프레임 번쩍임 무시)
  const LONG_FREEZE = 3000;  // 파란 창 없이 멈춘 화면(상자·게임 오버 등)은 이만큼 멈춰 있어야 인정
  let blueSince = 0;
  let uiShown = false;
  let lastCamMoveAt = 0;
  const CAM_STILL_MS = 400; // 카메라가 이만큼 멈춰 있어야 창일 수 있다

  // 어디를 볼지: 레벨업 영역을 지정했으면 거기, 아니면 게임 영역 가운데.
  // 맨 위 경험치 바도 파랗기 때문에 가장자리는 뺀다.
  function uiCheckRect() {
    if (cardRect) return cardRect;
    const r = gameRect || { x: 0, y: 0, w: 1, h: 1 };
    return { x: r.x + r.w * 0.2, y: r.y + r.h * 0.15, w: r.w * 0.6, h: r.h * 0.75 };
  }

  const isUiBlue = (r, g, b) => b >= 50 && b - Math.max(r, g) >= 25;
  const isUiRed = (r, g, b) => r >= 100 && r - Math.max(g, b) >= 50;

  // 파란 바닥이 있는 맵에서는 바닥도 파랗다. 그래서 세 가지를 더 본다.
  //  1) 평평한가 — 창은 한 색으로 칠한 판이고, 바닥은 무늬가 있다.
  //  2) 창 색을 기억했는가 — 레벨업 창을 한 번 제대로 읽으면 그 창의 색을 기억하고,
  //     그다음부터는 그 색에 가까운 것만 창으로 본다. 다른 파랑은 세지 않는다.
  //  3) 카메라가 멈췄는가 — 창이 떠 있으면 게임이 멈춰 카메라도 안 움직인다 (판단하는 쪽에서 본다).
  let uiColor = load("uiColor", null); // [r, g, b] — 기억한 창 색
  let learnColorAsk = null;            // "auto" | "manual" — 다음 프레임에서 창 색을 배운다
  const UI_TOL = 60;    // 기억한 창 색과 세 채널 차이 합이 이 미만이면 같은 색 (창 안의 조금 밝은 칸까지)
  const UI_FLAT = 8;    // 칸 안 파란 점들이 평균에서 채널당 이만큼 이내로 모여 있어야 평평한 판

  const colorGap = (r, g, b, c) => Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]);
  // 후보는 넓게 잡는다. 기억한 색에 딱 맞는 점만 고르면 무늬 있는 바닥의 어두운 쪽만 남아서
  // 그것끼리는 평평해 보인다. 넓게 모아 평평한지 본 다음, 평균이 창 색인지 따로 본다.
  const isPanelColor = (r, g, b) => (uiColor ? colorGap(r, g, b, uiColor) < UI_TOL * 2.5 : isUiBlue(r, g, b));

  // blue : 평평한 창 색 칸의 비율 (이걸로 판단한다)
  // rough: 파랗지만 창이 아니라고 본 칸의 비율 (무늬가 있거나, 기억한 창 색과 다른 파랑)
  // red  : 빨간 점의 비율 (참고용 — 플레이 중에도 체력바가 빨갛다)
  function uiColors(px) {
    const rc = uiCheckRect();
    const x0 = Math.max(0, Math.round(rc.x * AW)), x1 = Math.min(AW, Math.round((rc.x + rc.w) * AW));
    const y0 = Math.max(0, Math.round(rc.y * AH)), y1 = Math.min(AH, Math.round((rc.y + rc.h) * AH));
    let cells = 0, flat = 0, rough = 0, red = 0, n = 0;
    const hit = [];
    for (let cy = y0; cy + UI_CELL <= y1; cy += UI_CELL) {
      for (let cx = x0; cx + UI_CELL <= x1; cx += UI_CELL) {
        let m = 0, sr = 0, sg = 0, sb = 0;
        hit.length = 0;
        for (let y = cy; y < cy + UI_CELL; y += 2) {
          for (let x = cx; x < cx + UI_CELL; x += 2) {
            const i = (y * AW + x) * 4;
            if (isPanelColor(px[i], px[i + 1], px[i + 2])) {
              hit.push(i);
              sr += px[i]; sg += px[i + 1]; sb += px[i + 2];
            }
            if (isUiRed(px[i], px[i + 1], px[i + 2])) red++;
            m++;
          }
        }
        cells++;
        n += m;
        const b = hit.length;
        if (b / m < UI_FILL) continue;
        const mr = sr / b, mg = sg / b, mb = sb / b;
        let dev = 0;
        for (const i of hit) dev += Math.abs(px[i] - mr) + Math.abs(px[i + 1] - mg) + Math.abs(px[i + 2] - mb);
        if (dev / (b * 3) > UI_FLAT) rough++;                              // 무늬 — 바닥
        else if (uiColor && colorGap(mr, mg, mb, uiColor) >= UI_TOL) rough++; // 평평하지만 다른 파랑
        else flat++;
      }
    }
    return { blue: cells ? flat / cells : 0, rough: cells ? rough / cells : 0, red: n ? red / n : 0 };
  }

  function learnNow(px) {
    const how = learnColorAsk;
    learnColorAsk = null;
    const c = learnPanelColor(px);
    if (!c) {
      if (how === "manual") {
        logger.push(
          '<span class="bad">창 색을 못 찾았습니다</span> <span class="dim">— 확인 영역(파란 점선, 또는 레벨업 영역)에 ' +
            "한 색으로 칠한 창이 넓게 보일 때 다시 눌러주세요.</span>"
        );
      }
      return null;
    }
    uiColor = c;
    save("uiColor", uiColor);
    renderUiColor();
    logger.push(
      `<span class="tag">창 색 기억</span> rgb(${c.join(", ")}) ` +
        `<span class="dim">— ${how === "auto" ? "레벨업 창을 읽은 김에 배웠습니다. " : ""}` +
        "이제 이 색에 가까운 평평한 판만 창으로 봅니다. 파란 바닥은 세지 않습니다.</span>"
    );
    return c;
  }

  function renderUiColor() {
    if (!el.vsUiColor) return;
    el.vsUiColor.innerHTML = uiColor
      ? `<span class="swatch" style="background:rgb(${uiColor.join(",")})"></span> rgb(${uiColor.join(", ")}) — 이 색에 가까운 것만 창으로 봄`
      : "아직 없음 — 파란 계열이면 다 창 후보로 봄 (레벨업 창을 한 번 읽으면 자동으로 배웁니다)";
  }

  // 창 색 배우기: 확인 영역에서 평평한 파란 칸들의 색을 모아 가장 많은 색을 고른다.
  // 파랑으로 한정한다. 창 뒤에 어둡게 깔린 배경도 평평해서, 한정하지 않으면 창보다 넓은
  // 그 배경색을 배워버린다 (테스트 영상에서 실제로 그랬다).
  function learnPanelColor(px) {
    const rc = uiCheckRect();
    const x0 = Math.max(0, Math.round(rc.x * AW)), x1 = Math.min(AW, Math.round((rc.x + rc.w) * AW));
    const y0 = Math.max(0, Math.round(rc.y * AH)), y1 = Math.min(AH, Math.round((rc.y + rc.h) * AH));
    const bins = new Map();
    let cells = 0;
    for (let cy = y0; cy + UI_CELL <= y1; cy += UI_CELL) {
      for (let cx = x0; cx + UI_CELL <= x1; cx += UI_CELL) {
        cells++;
        let m = 0, sr = 0, sg = 0, sb = 0;
        for (let y = cy; y < cy + UI_CELL; y += 2) {
          for (let x = cx; x < cx + UI_CELL; x += 2) {
            const i = (y * AW + x) * 4;
            sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; m++;
          }
        }
        const mr = sr / m, mg = sg / m, mb = sb / m;
        let dev = 0;
        for (let y = cy; y < cy + UI_CELL; y += 2) {
          for (let x = cx; x < cx + UI_CELL; x += 2) {
            const i = (y * AW + x) * 4;
            dev += Math.abs(px[i] - mr) + Math.abs(px[i + 1] - mg) + Math.abs(px[i + 2] - mb);
          }
        }
        if (dev / (m * 3) > UI_FLAT) continue;       // 무늬가 있는 칸은 창 바탕이 아니다
        if (!isUiBlue(mr, mg, mb)) continue;          // 파란 판만 (어둡게 깔린 배경은 아니다)
        const key = `${(mr / 24) | 0},${(mg / 24) | 0},${(mb / 24) | 0}`;
        const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += mr; e.g += mg; e.b += mb;
        bins.set(key, e);
      }
    }
    let best = null;
    for (const e of bins.values()) if (!best || e.n > best.n) best = e;
    if (!best || best.n < cells * 0.08) return null; // 한 색이 넓게 깔려 있지 않으면 창이 아니다
    return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
  }

  // 적·젬 격자를 시간축으로 누르기. 나타날 때는 빠르게, 사라질 때는 천천히 —
  // 한 프레임 번쩍이는 이펙트는 못 올라오고, 진짜 적은 잠깐 가려져도 남는다.
  const GRID_RISE = 0.5;
  const GRID_FALL = 0.15;
  const enemySmooth = new Float32Array(CELLS);
  const gemSmooth = new Float32Array(CELLS);
  let jitterEma = 0;

  function thumbnail(px, rect) {
    const t = new Float32Array(TW * TH);
    const rx = rect ? rect.x * AW : 0;
    const ry = rect ? rect.y * AH : 0;
    const rw = rect ? rect.w * AW : AW;
    const rh = rect ? rect.h * AH : AH;
    for (let y = 0; y < TH; y++) {
      for (let x = 0; x < TW; x++) {
        const sx = Math.floor(rx + (x / TW) * rw);
        const sy = Math.floor(ry + (y / TH) * rh);
        const i = (Math.min(AH - 1, sy) * AW + Math.min(AW - 1, sx)) * 4;
        t[y * TW + x] = (px[i] + px[i + 1] + px[i + 2]) / 3 / 255;
      }
    }
    return t;
  }

  // ---- 피격: 캐릭터가 빨개지는 순간 ----
  // 체력바는 캐릭터를 따라다녀서 위치가 계속 바뀌고, 지정해두지 않으면 아예 못 읽는다.
  // 하지만 캐릭터는 항상 화면 정중앙에 있고, 맞으면 스프라이트가 빨갛게 번쩍인다.
  // 그 번쩍임은 체력바 없이도 잡힌다.
  const HURT_BOX = 6; // 중앙에서 ±6픽셀 (분석 캔버스 480x270 기준, 캐릭터 크기쯤)
  const HURT_JUMP = 0.1; // 평소보다 이만큼 붉어지면 맞은 것으로 본다
  let redBase = null;

  function centerRedness(px) {
    const cx = ((gameRect ? gameRect.x + gameRect.w / 2 : 0.5) * AW) | 0;
    const cy = ((gameRect ? gameRect.y + gameRect.h / 2 : 0.5) * AH) | 0;
    let sum = 0, n = 0;
    for (let y = cy - HURT_BOX; y <= cy + HURT_BOX; y++) {
      if (y < 0 || y >= AH) continue;
      for (let x = cx - HURT_BOX; x <= cx + HURT_BOX; x++) {
        if (x < 0 || x >= AW) continue;
        const i = (y * AW + x) * 4;
        // 빨강이 나머지 두 색보다 얼마나 앞서는가. 밝기가 변해도 잘 흔들리지 않는다.
        sum += (px[i] - (px[i + 1] + px[i + 2]) / 2) / 255;
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  function thumbDist(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }

  const MATCH_THRESHOLD = 0.075;

  // frozen: 게임이 멈췄나 (바깥 전장 기준). 모르는 화면일 때 play/menu 를 가르는 데 쓴다.
  function classify(thumb, frozen) {
    let best = null;
    let bestSample = null;
    let bestD = Infinity;
    for (const [name, samples] of Object.entries(taught)) {
      for (const s of samples) {
        const d = thumbDist(thumb, Float32Array.from(s.t));
        if (d < bestD) {
          bestD = d;
          best = name;
          bestSample = s;
        }
      }
    }
    // 어떤 샘플에 맞았는지도 같이 돌려준다. 그 샘플에 붙은 메모만 쓰기 위해서다.
    if (best && bestD < MATCH_THRESHOLD) {
      return { state: best, dist: bestD, guessed: false, sample: bestSample, nearest: best };
    }
    // 가르쳐준 화면이 아니면: 전장이 멈췄으면 멈춘 화면(메뉴·레벨업 등), 아니면 플레이 중
    return { state: frozen ? "menu" : "play", dist: bestD, guessed: true, sample: null, nearest: best };
  }

  function teach(name, thumb, note) {
    const t = thumb || lastThumb;
    if (!t) {
      // 예전에는 여기서 조용히 끝나서, 버튼을 눌러도 아무 일도 없는 것처럼 보였다.
      logger.push(
        '<span class="bad">기억할 화면이 없습니다</span> ' +
          '<span class="dim">— 화면 공유(또는 테스트 영상)를 먼저 켜야 지금 화면을 붙잡을 수 있습니다.</span>'
      );
      return;
    }
    taught[name] = taught[name] || [];
    taught[name].push({ t: Array.from(t), note: String(note || "").trim().slice(0, 120) });
    if (taught[name].length > 4) taught[name].shift();
    save("taught", taught);
    renderMarks();
    logger.push(
      `<span class="good">"${STATES[name]}" 화면을 기억했습니다 (${taught[name].length}개)</span>` +
        (note ? ` <span class="dim">— ${note}</span>` : "")
    );
  }

  // ---- 브릿지 ----
  let ws = null;

  function connectBridge() {
    return new Promise((resolve) => {
      try {
        ws = new WebSocket(`ws://${location.hostname}:8744`);
      } catch (e) {
        el.vsBridge.textContent = "연결 실패";
        return resolve(false);
      }
      ws.onopen = () => {
        el.vsBridge.textContent = "연결됨";
        // 브릿지는 재시작하면 대상 창을 잊는다. 연결될 때마다 다시 알려준다.
        applyWindow();
        resolve(true);
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) {
            pending.get(m.id)(m);
            pending.delete(m.id);
            return;
          }
          // 게임 창에서 ESC 를 누르면 브릿지가 입력을 막고 알려준다
          if (m.halted && running) {
            stop();
            setStatus("ESC 로 정지됨 — 다시 하려면 '조작 시작'", "bad");
          }
          if (m.live !== undefined) el.vsLive.textContent = m.live ? "실제 입력" : "안전모드";
          if (m.remote !== undefined) {
            remoteOn = !!m.remote;
            renderRemote();
          }
        } catch (e) {}
      };
      ws.onclose = () => {
        el.vsBridge.textContent = "끊김";
        el.vsLive.textContent = "-";
        ws = null;
      };
      ws.onerror = () => {
        el.vsBridge.textContent = "연결 실패 (브릿지 확인)";
        resolve(false);
      };
      setTimeout(() => resolve(false), 2500);
    });
  }

  const wsSend = (o) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
  const sendKeys = (keys) => wsSend({ type: "move", keys });
  const sendTap = (key) => wsSend({ type: "tap", key });
  const sendStop = () => wsSend({ type: "stop" });

  // 브릿지를 거쳐 Ollama에 물어본다. 브라우저에서 직접 부르면 CORS 설정을 따로 해야 해서,
  // 어차피 로컬에서 도는 브릿지가 대신 부르게 했다.
  const pending = new Map();
  let reqId = 0;

  function askBridge(payload, timeoutMs) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ error: "브릿지 미연결" });
      const id = `r${++reqId}`;
      pending.set(id, resolve);
      wsSend({ ...payload, id });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ error: "응답 시간 초과" });
        }
      }, timeoutMs);
    });
  }

  // ---- 글자 읽기 (윈도우 내장 OCR — 브릿지가 대신 부른다) ----
  // LLM 은 글자를 지어낼 때가 있다 ("마나의 노래" 를 "슈퍼 소울" 로 읽었다). OCR 은 못 읽으면
  // 빈칸일 뿐 없는 글자를 만들지 않고, 한 장에 0.2초 안쪽이다.
  // 작은 글씨는 못 읽어서 2배로 키워 보낸다 — 재보니 1배에서는 레벨업 버튼 셋 중 둘을 놓쳤고
  // 2배에서는 다 읽었다. 3배는 오히려 나빴다.
  const OCR_SCALE = 2;
  const OCR_MAX_SIDE = 2560;
  let lastOcr = null;        // { lines, at, test, match } — 화면에 그리고 시야에 보여주려고 남긴다
  const ocrWarned = new Set();

  // rect: 화면 전체 기준 0~1 영역 (없으면 전체). bitmap: 사진 시험용 이미지 (없으면 화면 공유).
  // 돌려주는 줄 좌표도 화면 전체 기준 0~1 이다.
  async function ocrRead(rect, bitmap) {
    if (!el.vsOcrOn.checked) return null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return null;
    const vw = bitmap ? bitmap.width : video.videoWidth;
    const vh = bitmap ? bitmap.height : video.videoHeight;
    if (!vw) return null;
    const r = rect || { x: 0, y: 0, w: 1, h: 1 };
    const sw = r.w * vw, sh = r.h * vh;
    const scale = Math.min(OCR_SCALE, OCR_MAX_SIDE / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(bitmap || video, r.x * vw, r.y * vh, sw, sh, 0, 0, c.width, c.height);
    const res = await askBridge({ type: "ocr", image: c.toDataURL("image/jpeg", 0.95).split(",")[1] }, 20000);
    if (res.error) {
      // 브릿지를 예전 것으로 띄웠거나 윈도우가 아니면 여기로 온다. 한 번만 알린다.
      if (!ocrWarned.has(res.error)) {
        ocrWarned.add(res.error);
        logger.push(
          `<span class="bad">글자 읽기(OCR) 실패: ${res.error}</span> ` +
            '<span class="dim">— 브릿지를 새로 띄웠는지 확인하세요. 그동안은 LLM 만 씁니다.</span>'
        );
      }
      return null;
    }
    const lines = (res.lines || [])
      .map((l) => ({
        text: String(l.text || "").trim(),
        x: r.x + (l.x / c.width) * r.w,
        y: r.y + (l.y / c.height) * r.h,
        w: (l.w / c.width) * r.w,
        h: (l.h / c.height) * r.h,
      }))
      .filter((l) => l.text)
      .sort((a, b) => a.y - b.y || a.x - b.x);
    lastOcr = { lines, at: performance.now(), test: !!bitmap, match: ocrMatch(lines), ms: res.ms || 0 };
    return lastOcr;
  }

  // 띄어쓰기와 대소문자는 OCR 이 자주 틀린다 ("컬렉 션"). 비교할 때는 뺀다.
  const ocrNorm = (t) => String(t || "").replace(/\s+/g, "").toUpperCase();

  // LLM 이 읽은 이름이 OCR 글자 중에 있나. 한 줄에 다른 글자가 붙어 읽힐 수 있어
  // ("마늘 새로운!") 포함도 인정한다.
  function ocrFind(name, lines) {
    const n = ocrNorm(name);
    if (!n || n === "?") return null;
    let best = null, bestS = 0;
    for (const l of lines || []) {
      const t = ocrNorm(l.text);
      if (n.length >= 2 && t.includes(n)) return l;
      const sc = similar(n, t);
      if (sc > bestS) { bestS = sc; best = l; }
    }
    return bestS >= SIMILAR_ENOUGH ? best : null;
  }

  // LLM 에게 "화면에서 이런 글자가 실제로 읽혔다" 고 알려준다. 지어내지 말고 여기서 베끼라고.
  function ocrBlock(lines, note) {
    if (!lines || !lines.length) return "";
    return (
      "\nText an OCR engine read on this screen, top to bottom (exact spelling; it can miss " +
      "some text or have small typos):\n" +
      lines.map((l) => "- " + l.text).join("\n") +
      "\n" + (note || "") + "\n"
    );
  }

  // 메뉴·화면 판별·폰 지시에서 LLM 에게 줄 화면 글자는 항목 이름처럼 보이는 것만 추린다.
  // 캐릭터 선택창은 능력치·설명·숫자 글자가 수십 줄이라, 그대로 주면 LLM 이 그걸 항목으로 적었다.
  // 위치로 커서를 옮기는 데는 추리기 전 글자를 그대로 쓴다 (이건 프롬프트에만 쓴다).
  const OCR_PROMPT_MAX = 20;
  // 캐릭터 정보 칸의 능력치 이름 — 짧아서 항목처럼 보이지만 고를 수 있는 게 아니다
  const STAT_WORDS = new Set(
    ["체력", "최대 체력", "회복", "방어력", "이동속도", "이동 속도", "피해량", "공격 범위", "범위",
     "투사체 속도", "지속시간", "투사체 수", "쿨타임", "행운", "성장", "탐욕", "저주", "자석", "부활"].map(ocrNorm)
  );
  function optionLike(lines) {
    return (lines || [])
      .filter((l) => {
        const t = String(l.text || "").trim();
        const n = ocrNorm(t);
        if (!n || n.length > 16) return false;                  // 긴 줄은 설명
        if (STAT_WORDS.has(n)) return false;                    // 능력치 이름
        if (/^[0-9\s.,:%+\-xX×/()]+$/.test(t)) return false;   // 숫자·수치만 ("120", "+10%")
        if (/[:：%]/.test(t)) return false;                      // "체력: 120", "피해량 +10%"
        return true;
      })
      .sort((a, b) => (b.h || 0) - (a.h || 0))                  // 큰 글자(버튼·제목)부터 남긴다
      .slice(0, OCR_PROMPT_MAX)
      .sort((a, b) => a.y - b.y || a.x - b.x);
  }

  // 화면에 이 글자가 보이면 그 화면이다. 위에 있는 줄부터 본다 — 레벨업이 제일 확실하고,
  // "시작" 같은 흔한 글자는 결과 화면("다시 시작")에도 나올 수 있어 메뉴를 맨 아래에 둔다.
  const OCR_WORDS_DEFAULT = [
    "levelup: 레벨 업, LEVEL UP",
    "revive: 부활, REVIVE",
    "chest: 보물, TREASURE",
    "dead: 게임 오버, GAME OVER, 결과, RESULTS, 생존 시간",
    "menu: 시작, START, 캐릭터 선택, 스테이지, STAGE, 파워업, POWER UP, 컬렉션, COLLECTION",
  ].join("\n");

  function ocrWords() {
    const out = [];
    for (const raw of String(el.vsOcrWords?.value ?? OCR_WORDS_DEFAULT).split("\n")) {
      const m = raw.match(/^\s*([\w-]+)\s*:(.*)$/);
      if (!m || !STATES[m[1]]) continue;
      const words = m[2].split(",").map((w) => w.trim()).filter(Boolean);
      if (words.length) out.push([m[1], words]);
    }
    return out;
  }

  function ocrMatch(lines) {
    if (!lines || !lines.length) return null;
    const texts = lines.map((l) => ocrNorm(l.text));
    for (const [state, words] of ocrWords()) {
      for (const w of words) {
        const nw = ocrNorm(w);
        const i = texts.findIndex((t) => t.includes(nw) || (nw.length >= 3 && similar(t, nw) >= 0.75));
        if (i >= 0) return { state, word: w, text: lines[i].text };
      }
    }
    return null;
  }

  function showOcr(o, where) {
    if (!o) {
      el.vsOcrResult.textContent = "글자를 읽지 못했습니다 (브릿지 연결과 OCR 켜짐을 확인하세요)";
      return;
    }
    const list = o.lines.map((l) => l.text).join(" / ") || "(글자 없음)";
    el.vsOcrResult.innerHTML =
      `<b>${where}</b> ${o.ms}ms — ${list}<br />` +
      (o.match
        ? `→ <span class="good">${STATES[o.match.state]}</span> 화면 ("${o.match.text}" 이 보임)`
        : '→ <span class="dim">아래 목록에 있는 글자가 없어 화면 종류는 모름</span>');
  }

  // ---- 사진 한 장으로 레벨업 읽기를 시험한다 ----
  // 게임을 돌리면서 고치려면 한 번 확인하는 데 한 판이 걸린다. 스크린샷을 바로 넣어
  // 무엇을 읽는지 보면, 이름을 잘못 읽는지 아예 못 읽는지가 즉시 드러난다.
  async function runImageTest(blobOrFile) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) {
        el.vsTestState.textContent = "브릿지에 연결하지 못했습니다";
        return;
      }
    }
    const bitmap = await createImageBitmap(blobOrFile);

    // 글자부터 읽는다 — 빠르고, 이게 무슨 화면인지도 여기서 나온다
    el.vsTestState.textContent = "글자 읽는 중...";
    const ocr = await ocrRead(null, bitmap);
    showOcr(ocr, "사진");
    if (ocr?.match && ocr.match.state !== "levelup") {
      el.vsTestState.textContent =
        `${STATES[ocr.match.state]} 화면으로 보입니다 ("${ocr.match.text}" 이 보임) — 레벨업 읽기는 건너뜀. ` +
        `읽은 글자: ${ocr.lines.map((l) => l.text).join(" / ")}`;
      return;
    }
    if (!el.vsModel.value) {
      el.vsTestState.textContent = "모델을 먼저 고르세요";
      return;
    }
    el.vsTestState.textContent = "카드 읽는 중...";

    // 게임에서 보내는 것과 같은 조건으로 맞춘다 (같은 최대 크기, 같은 품질)
    const scale = Math.min(1, LEVELUP_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bitmap.width * scale));
    c.height = Math.max(1, Math.round(bitmap.height * scale));
    c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
    const testImage = {
      b64: c.toDataURL("image/jpeg", 0.9).split(",")[1],
      w: c.width,
      h: c.height,
      ocr, // 방금 읽은 글자 — 카드 이름을 맞춰보는 데 쓴다
    };

    const nCards = Math.max(2, Math.min(5, Number(el.vsCards.value)));
    const before = readLog.length;
    const choice = await llmPickCard(nCards, testImage);

    // llmPickCard 가 기록을 남기므로, 그걸 사진 시험이라고 표시만 해준다
    if (readLog.length > before) {
      readLog[readLog.length - 1].test = true;
      save("readLog", readLog);
      renderReadLog();
    }
    el.vsTestState.textContent = choice
      ? `${choice.item} (${(choice.took || 0).toFixed(1)}초)`
      : "읽지 못했습니다 — 아래 기록을 보세요";
  }

  el.vsTestImg.addEventListener("change", () => {
    const f = el.vsTestImg.files?.[0];
    if (f) runImageTest(f);
    el.vsTestImg.value = ""; // 같은 파일을 다시 골라도 동작하게
  });

  el.vsTestPaste.addEventListener("click", () => {
    el.vsTestState.textContent = "이 창에서 Ctrl+V 를 눌러주세요";
  });

  window.addEventListener("paste", (e) => {
    // 뱀서 탭이 보일 때만 받는다
    if (!document.getElementById("panel-vamp")?.classList.contains("is-active")) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    runImageTest(item.getAsFile());
  });

  // ---- 키를 보낼 창 ----
  // 활성 창을 안 보면 알트탭했을 때 다른 프로그램에 대고 WASD를 친다.
  // 제목 일부만 맞으면 되고, 아니면 브릿지가 잡고 있던 키까지 놓는다.
  async function applyWindow() {
    const want = (el.vsWindow.value || "").trim();
    save("window", want);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      el.vsWindowState.textContent = "브릿지에 연결되면 적용됩니다";
      return;
    }
    const res = await askBridge({ type: "set_window", window: want }, 5000);
    if (res.error) {
      el.vsWindowState.textContent = `설정 실패: ${res.error}`;
      return;
    }
    showWindowState(res.window, res.foreground);
  }

  function showWindowState(want, fg) {
    if (!want) {
      el.vsWindowState.innerHTML =
        '<span class="bad">대상 창이 지정되지 않았습니다</span> ' +
        `<span class="dim">— 지금 활성 창(${fg || "?"})이 무엇이든 키가 들어갑니다</span>`;
      return;
    }
    const ok = fg && fg.toLowerCase().includes(want.toLowerCase());
    el.vsWindowState.innerHTML =
      `대상 창 <b>${want}</b> · 지금 활성 창 <b>${fg || "?"}</b> → ` +
      (ok
        ? '<span class="good">키가 나갑니다</span>'
        : '<span class="dim">지금은 막혀 있습니다 (게임 창을 클릭하면 나갑니다)</span>');
  }

  el.vsWindow.addEventListener("change", applyWindow);

  el.vsWindowNow.addEventListener("click", async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) {
        el.vsWindowState.textContent = "브릿지에 연결하지 못했습니다";
        return;
      }
    }
    // 이 페이지를 클릭한 순간 활성 창은 브라우저다. 게임 창을 먼저 눌러두게 안내한다.
    const res = await askBridge({ type: "win_info" }, 5000);
    if (res.error) {
      el.vsWindowState.textContent = `조회 실패: ${res.error}`;
      return;
    }
    el.vsWindow.value = res.foreground || "";
    await applyWindow();
    logger.push(
      `<span class="tag">대상 창</span> <span class="pick">${res.foreground || "(없음)"}</span> ` +
        '<span class="dim">— 이 창이 앞에 있을 때만 키가 나갑니다</span>'
    );
  });

  // ---- 화면 공유 ----
  let stream = null;
  let demoOn = false;

  async function share() {
    demoOn = false;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      video.srcObject = stream;
      await video.play();
      stream.getVideoTracks()[0].addEventListener("ended", () => {
        stop();
        stream = null;
        setStatus("화면 공유가 끊겼습니다", "bad");
      });
      setStatus("화면 공유 중 — 게임 영역을 지정하세요", "ok");
      el.vsRun.disabled = false;
      startLoop();
      return true;
    } catch (e) {
      setStatus("화면 공유 취소됨", "bad");
      return false;
    }
  }

  function startDemoFeed() {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 360;
    const g = c.getContext("2d");

    // 월드 좌표. 카메라(=캐릭터)가 천천히 방향을 바꿔가며 걸어다닌다.
    const cam = { x: 0, y: 0, vx: 40, vy: 0, turnAt: 0 };
    const gems = Array.from({ length: 40 }, () => ({
      x: (Math.random() - 0.5) * 1400, y: (Math.random() - 0.5) * 900,
    }));
    const mobs = Array.from({ length: 16 }, () => ({
      x: (Math.random() - 0.5) * 900, y: (Math.random() - 0.5) * 600,
      sp: 25 + Math.random() * 30,
    }));
    // 바닥 무늬: 월드에 고정된 얼룩들
    const spots = Array.from({ length: 260 }, () => ({
      x: Math.random() * 1600, y: Math.random() * 1000,
      r: 3 + Math.random() * 9, c: 60 + Math.random() * 50,
    }));

    let prev = performance.now();
    const timer = setInterval(() => {
      if (!demoOn) return clearInterval(timer);
      const now = performance.now();
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;

      if (now > cam.turnAt) {
        const a = Math.random() * Math.PI * 2;
        const sp = demoPaused ? 0 : 35 + Math.random() * 40;
        cam.vx = Math.cos(a) * sp;
        cam.vy = Math.sin(a) * sp;
        cam.turnAt = now + 1200 + Math.random() * 1500;
      }
      if (demoPaused) { cam.vx = 0; cam.vy = 0; }
      cam.x += cam.vx * dt;
      cam.y += cam.vy * dt;

      const ox = c.width / 2 - cam.x, oy = c.height / 2 - cam.y;

      g.fillStyle = "#5d6e4a";
      g.fillRect(0, 0, c.width, c.height);
      // 바닥 무늬 (1600x1000 으로 반복)
      for (const s of spots) {
        const sx = ((((s.x + ox) % 1600) + 1600) % 1600) - 480;
        const sy = ((((s.y + oy) % 1000) + 1000) % 1000) - 320;
        g.fillStyle = `rgb(${s.c},${s.c + 22},${s.c - 10})`;
        g.fillRect(sx, sy, s.r, s.r);
      }
      // 보석: 바닥에 붙어 있다 (카메라와 함께 밀릴 뿐 스스로는 안 움직인다)
      g.fillStyle = "#2f7dff";
      for (const gm of gems) {
        g.beginPath();
        g.arc(gm.x + ox, gm.y + oy, 5, 0, Math.PI * 2);
        g.fill();
      }
      // 몬스터: 캐릭터 쪽으로 걸어온다
      g.fillStyle = "#1a1a20";
      for (const m of mobs) {
        if (!demoPaused) {
          const dx = cam.x - m.x, dy = cam.y - m.y, d = Math.hypot(dx, dy) || 1;
          m.x += (dx / d) * m.sp * dt;
          m.y += (dy / d) * m.sp * dt;
          if (d < 20) { m.x = cam.x + (Math.random() - 0.5) * 900; m.y = cam.y + (Math.random() - 0.5) * 600; }
        }
        g.beginPath();
        g.arc(m.x + ox, m.y + oy, 10, 0, Math.PI * 2);
        g.fill();
      }
      // 멈췄을 때는 레벨업 화면처럼: 전장은 그대로 멈추고 가운데에 창이 뜨며 반짝인다.
      // 반짝임은 매 프레임 바뀌므로, 화면 전체 변화로 판단하면 '움직인다' 로 속는다.
      if (demoPaused) {
        g.fillStyle = "rgba(10,10,20,0.55)";
        g.fillRect(0, 0, c.width, c.height);
        const pw = 240, ph = 200, px0 = c.width / 2 - pw / 2, py0 = c.height / 2 - ph / 2;
        // 뱀서 창처럼 파란 판에 빨간 테두리
        g.fillStyle = "#1f3480";
        g.fillRect(px0, py0, pw, ph);
        g.strokeStyle = "#c8372d";
        g.lineWidth = 4;
        g.strokeRect(px0, py0, pw, ph);
        g.lineWidth = 1;
        g.fillStyle = "#ffd75a";
        g.font = "bold 18px sans-serif";
        g.fillText("LEVEL UP!", px0 + 70, py0 + 26);
        for (let k = 0; k < 4; k++) {
          g.fillStyle = k === 0 ? "#3a5cc8" : "#2a449c";
          g.fillRect(px0 + 16, py0 + 40 + k * 38, pw - 32, 30);
          g.fillStyle = "#fff";
          g.font = "12px sans-serif";
          g.fillText(["Whip", "Magic Wand", "Garlic", "Spinach"][k], px0 + 52, py0 + 60 + k * 38);
        }
        for (let k = 0; k < 40; k++) {  // 반짝이 (매 프레임 다른 자리)
          g.fillStyle = `rgba(255,230,160,${0.4 + Math.random() * 0.6})`;
          g.fillRect(px0 + Math.random() * pw, py0 + Math.random() * ph, 3, 3);
        }
      }
      // 캐릭터와 체력바, 위쪽 HUD (카메라와 같이 안 움직인다)
      g.fillStyle = "#e8d8a0";
      g.fillRect(c.width / 2 - 8, c.height / 2 - 8, 16, 16);
      g.fillStyle = "#d33";
      g.fillRect(c.width / 2 - 20, c.height / 2 + 14, 40 * demoHp, 5);
      g.fillStyle = "#101014";
      g.fillRect(0, 0, c.width, 12);
      g.fillStyle = "#4aa8ff";
      g.fillRect(2, 3, (c.width - 4) * ((now / 9000) % 1), 6);
    }, 40);
    return c.captureStream(30);
  }
  // 멈추면 메뉴 화면처럼 아무것도 안 움직인다 — 이때 적이 0으로 잡혀야 한다
  let demoPaused = false;
  let demoHp = 1;

  async function useDemo() {
    demoOn = true;
    stream = startDemoFeed();
    video.srcObject = stream;
    await video.play();
    setStatus("테스트 영상 — 게임 없이 배선만 확인합니다", "ok");
    el.vsRun.disabled = false;
    startLoop();
  }

  // ---- 분석 ----
  // 입력은 방향별 (압박, 탈출여지, 젬) 24개. 규칙 기반이 쓰는 것과 같은 재료다.
  // 나중에 A단계로 가면 이 자리에 격자 지도를 통째로 넣고 KC를 2,000개로 늘리면 된다.
  const brain = new FlyBrain({
    nInputs: 24,
    nKC: 400, sparsity: 0.08, nActions: DIRS.length, lr: 0.12, gamma: 0.85,
  });

  function analyze() {
    wctx.drawImage(video, 0, 0, AW, AH);
    const img = wctx.getImageData(0, 0, AW, AH);
    const px = img.data;

    // 게임 영역 (지정 안 했으면 화면 전체)
    const gx = (gameRect ? gameRect.x : 0) * AW;
    const gy = (gameRect ? gameRect.y : 0) * AH;
    const gw = (gameRect ? gameRect.w : 1) * AW;
    const gh = (gameRect ? gameRect.h : 1) * AH;

    let sum = 0, cnt = 0;
    for (let y = gy; y < gy + gh; y += 7) {
      for (let x = gx; x < gx + gw; x += 7) {
        const i = ((y | 0) * AW + (x | 0)) * 4;
        sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
        cnt++;
      }
    }
    const bg = sum / Math.max(1, cnt);

    const enemyThr = Number(el.vsEnemyThr.value);
    const gemSat = Number(el.vsGemThr.value);

    // 카메라 이동을 재고, 그걸 빼고도 움직이는 곳을 구한다
    const nowMs = performance.now();
    const curGray = grayFrame(px, gx, gy, gw, gh);
    let resid = null;
    if (!prevGray) {
      prevGray = curGray;
      lastFreshAt = nowMs;
    } else if (sameFrame(curGray, prevGray)) {
      // 같은 장이 또 왔다. 잠깐이면 영상이 늦은 것 — 직전 결과를 그대로 쓰고
      // 비교 기준도 바꾸지 않는다. 오래가면 정말 멈춘 화면 — 아무것도 안 움직인다.
      resid = nowMs - lastFreshAt < STILL_MS ? lastResid : ZERO_RESID;
      // 정말 멈췄으면 카메라도 안 움직인 것이다. 마지막으로 잰 이동량을 그대로 두면
      // 멈춘 화면이 영원히 "카메라 움직이는 중" 으로 남는다.
      if (resid === ZERO_RESID) lastShift = { dx: 0, dy: 0, err: 0, ok: true };
    } else {
      lastFreshAt = nowMs;
      lastShift = estimateShift(curGray, prevGray);
      resid = lastShift.ok ? residualMap(curGray, prevGray, lastShift) : null;
      lastResid = resid;
      prevGray = curGray;
    }
    const moveThr = Number(el.vsMoveThr.value);
    const enemyMode = el.vsEnemyMode.value;
    let movingCount = 0;
    // 뱀서는 카메라가 캐릭터를 따라다녀서 캐릭터는 늘 게임 영역 중앙에 있다
    const cx = gx + gw / 2;
    const cy = gy + gh / 2;
    const halfW = gw / 2, halfH = gh / 2;
    // 게임 영역의 비율이 바뀌면(영역을 새로 지정하면) 격자 기하를 다시 만든다
    const aspect = gw / gh;
    if (Math.abs(aspect - geomAspect) > 0.01) buildCellGeometry(aspect);

    const enemyGrid = new Float32Array(CELLS);
    const gemGrid = new Float32Array(CELLS);
    let enemyCount = 0, gemCount = 0;
    const dots = [];

    for (let y = gy; y < gy + gh; y += 2) {
      for (let x = gx; x < gx + gw; x += 2) {
        const xi = x | 0, yi = y | 0;
        const i = (yi * AW + xi) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const lum = (r + g + b) / 3;
        // 화면 사각형 전체를 -1 ~ 1 로 (가로는 화면 폭, 세로는 화면 높이 기준)
        const ddx = (xi - cx) / halfW;
        const ddy = (yi - cy) / halfH;

        const isGem = b - (r + g) / 2 > gemSat && b > 90;
        const colorEnemy = bg - lum > enemyThr;
        // 카메라 이동을 빼고도 달라진 곳 = 스스로 움직이는 것
        let moving = false;
        if (resid) {
          const mx = Math.min(MW - 1, (((xi - gx) / gw) * MW) | 0);
          const my = Math.min(MH - 1, (((yi - gy) / gh) * MH) | 0);
          moving = resid[my * MW + mx] > moveThr;
          if (moving) movingCount++;
        }
        // 첫 프레임이거나 장면이 바뀌어 카메라 이동을 못 잰 프레임은 색으로 판단한다
        const isEnemy =
          !isGem &&
          (enemyMode === "color" || !resid
            ? colorEnemy
            : enemyMode === "motion"
            ? moving
            : colorEnemy && moving);
        if (!isGem && !isEnemy) continue;

        const gxi = Math.min(GRID_N - 1, Math.max(0, ((ddx + 1) / 2 * GRID_N) | 0));
        const gyi = Math.min(GRID_N - 1, Math.max(0, ((ddy + 1) / 2 * GRID_N) | 0));
        const ci = gyi * GRID_N + gxi;
        if (cellDir[ci] < 0) continue; // 캐릭터 자신이 있는 가운데 칸
        if (isGem) { gemGrid[ci] += 1; gemCount++; }
        else { enemyGrid[ci] += 1; enemyCount++; }
        if (dots.length < 1500) dots.push(xi, yi, isGem ? 1 : 0);
      }
    }

    // 칸 하나가 꽉 찬 정도를 0~1로. 칸은 이제 가로로 조금 긴 직사각형이고,
    // 2픽셀 간격으로 훑으므로 칸 하나에 (폭/칸수/2) x (높이/칸수/2) 개의 표본이 들어간다.
    const cellFull = Math.max(1, (gw / GRID_N / 2) * (gh / GRID_N / 2));
    for (let i = 0; i < CELLS; i++) {
      enemyGrid[i] = Math.min(1, enemyGrid[i] / cellFull);
      gemGrid[i] = Math.min(1, gemGrid[i] / cellFull);
    }

    // 폭발·데미지 숫자 같은 이펙트는 한두 프레임만 번쩍인다. 그대로 두면 그게 적이 된다.
    // 시간축으로 눌러서, 계속 있는 것만 남기고 잠깐 튀는 것은 죽인다.
    // 올라갈 때보다 내려갈 때를 느리게 해서 진짜 적이 한 프레임 사라져도 유지되게 한다.
    let jitter = 0;
    for (let i = 0; i < CELLS; i++) {
      const prevE = enemySmooth[i];
      jitter += Math.abs(enemyGrid[i] - prevE);
      enemySmooth[i] = enemyGrid[i] > prevE
        ? prevE + (enemyGrid[i] - prevE) * GRID_RISE
        : prevE + (enemyGrid[i] - prevE) * GRID_FALL;
      gemSmooth[i] = gemGrid[i] > gemSmooth[i]
        ? gemSmooth[i] + (gemGrid[i] - gemSmooth[i]) * GRID_RISE
        : gemSmooth[i] + (gemGrid[i] - gemSmooth[i]) * GRID_FALL;
      enemyGrid[i] = enemySmooth[i];
      gemGrid[i] = gemSmooth[i];
    }
    // 프레임마다 격자가 얼마나 흔들리는지. 이 값이 크면 이펙트를 적으로 세고 있다는 뜻이다.
    jitterEma = jitterEma * 0.9 + (jitter / CELLS) * 0.1;

    const field = fieldFeatures(enemyGrid, gemGrid);

    const thumb = thumbnail(px, gameRect);
    let motion = 0;
    if (prevThumb) {
      for (let i = 0; i < thumb.length; i++) motion += Math.abs(thumb[i] - prevThumb[i]);
      motion = (motion / thumb.length) * 100;
    }
    prevThumb = thumb;
    motionEma = motionEma * 0.6 + motion * 0.4;

    // 캐릭터가 평소보다 붉어졌는지. 번쩍이는 동안에는 기준을 갱신하지 않는다 —
    // 그러면 기준이 같이 끌려 올라가서 피격이 묻혀버린다.
    const red = centerRedness(px);
    let hurt = false;
    if (redBase === null) {
      redBase = red;
    } else {
      hurt = red > redBase + HURT_JUMP;
      if (!hurt) redBase = redBase * 0.98 + red * 0.02;
    }

    return {
      field, enemyGrid, gemGrid, enemyCount, gemCount, dots, thumb,
      motion: motionEma, hp: readHp(px), xp: readXp(px), red, redBase, hurt, jitter: jitterEma,
      shift: lastShift, usedMotion: !!resid && enemyMode !== "color", movingCount,
      outerMove: resid ? outerMotion(resid, moveThr, gw / gh, { gx, gy, gw, gh }) : null,
      ui: uiColors(px),
      learned: learnColorAsk ? learnNow(px) : null,
    };
  }

  // 격자 지도를 방향별 숫자 3개로 요약한다.
  //  threat       : 그쪽에 깔린 적의 압박 (가까울수록 크게)
  //  escape       : 그쪽으로 얼마나 달아날 수 있는지 = 가장 가까운 적까지의 거리
  //  gem          : 그쪽 젬의 매력
  // 포위돼서 죽는 게임이라 "적이 적은 쪽"보다 "빠져나갈 여지가 있는 쪽"이 중요하다.
  // 이 세 숫자는 규칙 기반 판단과 나중의 학습 양쪽이 같이 쓴다.
  function fieldFeatures(enemyGrid, gemGrid) {
    const threat = new Float32Array(8);
    const escape = new Float32Array(8).fill(1);
    const gem = new Float32Array(8);

    for (let i = 0; i < CELLS; i++) {
      const d = cellDir[i];
      if (d < 0) continue;
      const dist = cellDist[i];
      const e = enemyGrid[i];
      if (e > 0.05) {
        threat[d] += e / (dist + 0.15);
        if (dist < escape[d]) escape[d] = dist;
      }
      if (gemGrid[i] > 0.05) gem[d] += gemGrid[i] / (dist + 0.3);
    }

    let maxT = 1e-6, maxG = 1e-6;
    for (let d = 0; d < 8; d++) {
      if (threat[d] > maxT) maxT = threat[d];
      if (gem[d] > maxG) maxG = gem[d];
    }
    for (let d = 0; d < 8; d++) {
      threat[d] /= maxT;
      gem[d] /= maxG;
    }
    return { threat, escape, gem };
  }

  // 체력바: 지정할 때 왼쪽 끝 색을 기억해두고, 그 색과 비슷한 칸이 몇 %인지를 센다.
  // 게임마다 색이 달라도 동작하고, 바가 줄면 비율이 떨어진다.
  // 경험치 바는 색으로 읽지 않는다. 레벨업하면 번쩍여서 기준색과 안 맞게 되고,
  // 그 순간 0%로 읽혀 보상에 그대로 들어간다.
  //
  // 대신 채워진 경계가 어디인지를 찾는다. 기준은 매 프레임 바의 양쪽 끝에서 뽑는다 —
  // 왼쪽 끝은 차 있는 쪽, 오른쪽 끝은 비어 있는 쪽. 번쩍이면 기준과 본체가 같이
  // 변하므로 영향을 받지 않는다.
  // 경험치 바: 뱀서는 화면 맨 위 전체 폭이 경험치 바다. 지정하지 않아도 게임 영역 맨 위
  // 몇 줄 중에서 한 줄을 골라 읽는다. 두께 전체를 평균하면 테두리와 "LV" 글씨가 섞이므로
  // 지정했을 때도 그 사각형의 가운데 한 줄만 읽는다.
  //
  // 읽는 방식: 왼쪽 끝부터 "켜진 칸"(선명하거나 밝은 칸)이 어디까지 이어지는지.
  // 빈 트랙은 어둡고 흐리다. 바 색이 무엇이든 상관없고, 레벨업 때 바가 하얗게 반짝여도
  // 밝으니 켜진 칸이다. 오른쪽 끝의 "LV 12" 글씨는 왼쪽에서 오다 빈 곳에서 멈추니 닿지 않는다.
  const XP_ROWS = 4; // 맨 위에서 이만큼의 줄 중에서 고른다 (분석 화면 270줄 기준, 원본 약 16픽셀)
  const XP_TEXT = 0.12; // 오른쪽 끝 이만큼은 "LV" 글씨 자리 — 줄을 고를 때는 보지 않는다
  let xpRowY = null; // 마지막으로 고른 줄
  let xpLine = null; // 화면에 그리려고 남긴다 { x, y, w } (0~1)

  const isLit = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) > 50 || (r + g + b) / 3 > 150;

  // 한 줄 읽기. v: 왼쪽부터 켜진 길이 (0~1), tail: 그 뒤(글씨 자리 전까지)가 얼마나 빈 트랙 같은가
  function xpRowRead(px, x, w, y) {
    const x0 = Math.round(x * AW), n = Math.max(8, Math.round(w * AW));
    const lit = (xx) => {
      const i = (y * AW + Math.min(AW - 1, x0 + xx)) * 4;
      return isLit(px[i], px[i + 1], px[i + 2]);
    };
    // 한 칸만 꺼져도 멈추면 잡티에 걸린다. 몇 칸 연달아 꺼져야 끝으로 본다.
    const RUN = Math.max(2, (n * 0.03) | 0);
    let edge = n;
    for (let xx = 0; xx < n; xx++) {
      let off = 0;
      for (let j = xx; j < Math.min(n, xx + RUN); j++) if (!lit(j)) off++;
      if (off === Math.min(RUN, n - xx)) { edge = xx; break; }
    }
    const end = Math.round(n * (1 - XP_TEXT));
    let dark = 0, cnt = 0;
    for (let xx = edge; xx < end; xx++) { cnt++; if (!lit(xx)) dark++; }
    return { v: edge / n, tail: cnt ? dark / cnt : 1 };
  }

  function readXp(px) {
    if (xpRect) {
      const y = Math.min(AH - 1, Math.round((xpRect.y + xpRect.h / 2) * AH));
      xpLine = { x: xpRect.x, w: xpRect.w, y: (y + 0.5) / AH };
      return xpRowRead(px, xpRect.x, xpRect.w, y).v;
    }
    const g = gameRect || { x: 0, y: 0, w: 1, h: 1 };
    const top = Math.round(g.y * AH);
    // 바의 한가운데 줄은 "왼쪽은 켜지고 나머지는 빈 트랙" 으로 깔끔하게 갈린다.
    // 테두리 줄은 전부 꺼져 있고, 바 아래 맵은 뒤쪽이 빈 트랙처럼 어둡게 이어지지 않는다.
    // 경험치가 0 이거나 꽉 차면 갈리지 않는다 — 그때는 전에 고른 줄을 그대로 쓴다.
    let best = null, bestV = 0;
    for (let y = top; y < Math.min(AH, top + XP_ROWS); y++) {
      const r = xpRowRead(px, g.x, g.w, y);
      if (r.v > 0.01 && r.v < 1 - XP_TEXT && r.tail >= 0.8 && r.v > bestV) { bestV = r.v; best = y; }
    }
    if (best !== null) xpRowY = best;
    const y = xpRowY ?? Math.min(AH - 1, top + 1);
    xpLine = { x: g.x, w: g.w, y: (y + 0.5) / AH };
    return xpRowRead(px, g.x, g.w, y).v;
  }

  // 프롬프트 예시를 그대로 베껴 온 답을 걸러낸다. 못 읽었으면 못 읽었다고 나와야지,
  // 그럴듯한 이름이 들어오면 그게 진짜인 줄 알고 눌러버린다.
  // 두 판독이 얼마나 닮았는지 (0~1). 편집 거리를 길이로 나눈 값이다.
  //   시금치 / 시급치  -> 0.67  (한 글자 흔들린 것뿐, 제대로 읽었다고 본다)
  //   마나의 노래 / 슈퍼 소울 -> 0.2 미만 (지어낸 것)
  function similar(a, b) {
    a = String(a || ""); b = String(b || "");
    if (!a || !b) return 0;
    if (a === b) return 1;
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(
          prev[j] + 1,
          cur[j - 1] + 1,
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
      }
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }
  const SIMILAR_ENOUGH = 0.5;

  function isPlaceholder(text) {
    const t = String(text || "").trim();
    return /^<.*>$/.test(t) || /name on card|its description|button label|label of|highlighted/i.test(t);
  }

  function readHp(px) {
    return barFill(px, hpRect, hpColor);
  }

  // 세로줄 하나씩 훑어서, 기준색과 비슷한 픽셀이 하나라도 있으면 "그 칸은 차 있다"로 센다.
  // 게임마다 바 색이 달라도 동작하고, 바가 줄면 비율이 그대로 떨어진다.
  function barFill(px, rect, color) {
    if (!rect || !color) return null;
    const x0 = rect.x * AW, y0 = rect.y * AH;
    const w = rect.w * AW, h = rect.h * AH;
    let filled = 0, total = 0;
    for (let x = 0; x < w; x++) {
      let hit = false;
      for (let y = 0; y < h; y++) {
        const i = (((y0 + y) | 0) * AW + ((x0 + x) | 0)) * 4;
        const d =
          Math.abs(px[i] - color[0]) + Math.abs(px[i + 1] - color[1]) + Math.abs(px[i + 2] - color[2]);
        if (d < 110) { hit = true; break; }
      }
      total++;
      if (hit) filled++;
    }
    return total ? filled / total : null;
  }

  // ---- 판단 ----
  let epsilon = 0.15;
  let lastObs = null, lastAction = null, lastActive = null;
  let prevHp = null;
  let prevHurt = false;
  let prevXp = null;

  // 피격은 프레임마다 판정된다. 그대로 세면 FPS가 곧 피격 횟수가 되고,
  // 보상도 프레임 수에 비례해버린다. 횟수는 쿨다운을 두고 세고,
  // 보상은 dt 를 곱해 "초당 얼마"로 만든다 — FPS가 변해도 같은 값이 나오게.
  const HIT_COOLDOWN = 400; // ms. 이 안에 또 맞아도 한 번으로 센다
  const HURT_PER_SEC = 6;   // 체력바를 못 읽을 때 쓰는 초당 감점
  let lastHitAt = 0;

  function countHit(now) {
    if (now - lastHitAt < HIT_COOLDOWN) return false;
    lastHitAt = now;
    run.hits++;
    return true;
  }

  // 바를 잘못 감싸면(예: 바 색이 배경과 비슷하면) 값이 늘 100%로 읽힌다.
  // 그러면 경험치 항이 영원히 0인데 아무도 눈치채지 못한다. 오래 붙어 있으면 말해준다.
  const STUCK_SEC = 45;
  const stuck = { hp: { at: 0, val: null, warned: false }, xp: { at: 0, val: null, warned: false } };

  function checkStuck(kind, value, now) {
    const st = stuck[kind];
    if (value === null) return;
    if (st.val === null || Math.abs(value - st.val) > 0.005) {
      st.val = value;
      st.at = now;
      return;
    }
    if (st.warned || now - st.at < STUCK_SEC * 1000) return;
    st.warned = true;
    const name = kind === "xp" ? "경험치" : "체력";
    const pct = (value * 100).toFixed(0);
    if (kind === "xp" && !xpRect) {
      logger.push(
        `<span class="bad">경험치가 ${STUCK_SEC}초 내내 ${pct}% 그대로입니다</span> ` +
          '<span class="dim">— 게임 영역 맨 위 한 줄에서 읽고 있습니다(화면 위 초록 선). 선이 경험치 바 위에 ' +
          "있지 않으면 게임 영역을 게임 화면에 딱 맞게 다시 잡거나, 경험치 바를 직접 지정해주세요.</span>"
      );
      return;
    }
    logger.push(
      `<span class="bad">${name} 바가 ${STUCK_SEC}초 내내 ${pct}% 그대로입니다</span> ` +
        '<span class="dim">— 영역을 잘못 잡았을 가능성이 큽니다. 바 색이 배경과 비슷하면 ' +
        "배경까지 세어 늘 100%로 읽힙니다. 색이 뚜렷한 부분만 감싸 다시 지정해보세요.</span>"
    );
  }

  // 나아지고 있는지 볼 수단이 없으면 다음 판단을 못 한다.
  // 생존 시간은 학습에 쓰지 않는다 (한 판에 신호 하나뿐이라 배우기엔 너무 성기다). 점수판 용도다.
  const run = { startedAt: 0, hits: 0, active: false, rewardSum: 0, steps: 0, rw: null };
  let history = load("runs", []);

  const newBreakdown = () => ({ hp: 0, escape: 0, xp: 0, gem: 0, step: 0 });

  // ---- 블라인드 판 ----
  // 화면을 가린 채 돌아다니게 해서, 본 판과 성적을 비교한다.
  // 그냥 무작위로 매 프레임 방향을 바꾸면 제자리에서 떨기만 하므로,
  // 한 방향을 잠깐 유지하다 바꾼다 — 사람이 눈 감고 돌아다니는 것과 비슷하게.
  let blindDir = 0;
  let blindUntil = 0;

  function blindAction(now) {
    if (now >= blindUntil) {
      blindDir = Math.floor(Math.random() * 8);
      blindUntil = now + 400 + Math.random() * 1100;
    }
    return blindDir;
  }

  // 블라인드 판에서도 피격은 똑같이 센다. 그래야 두 쪽을 비교할 수 있다.
  // 학습은 하지 않는다 — 눈 감고 한 행동으로 배우면 뇌가 망가진다.
  function trackHitsOnly(info) {
    const nowMs = performance.now();
    if (info.hp !== null && prevHp !== null && info.hp < prevHp - 0.005) countHit(nowMs);
    else if (info.hurt) countHit(nowMs);
    if (info.hp !== null) prevHp = info.hp;
    prevHurt = info.hurt;
  }

  function nextRunBlind() {
    const mode = el.vsBlindMode.value;
    if (mode === "always") return true;
    if (mode === "alternate") {
      // 번갈아: 직전 판의 반대. 기록이 없으면 본 판부터.
      const last = history[history.length - 1];
      return last ? !last.blind : false;
    }
    return false;
  }

  function renderBlindStats() {
    const seen = history.filter((r) => !r.blind);
    const blind = history.filter((r) => r.blind);
    const summ = (arr) => {
      if (!arr.length) return null;
      const sec = arr.reduce((a, r) => a + r.sec, 0) / arr.length;
      const hpm = arr.reduce((a, r) => a + (r.hpm || 0), 0) / arr.length;
      return { n: arr.length, sec, hpm };
    };
    const a = summ(seen), b = summ(blind);
    const fmt = (x) =>
      x ? `${x.n}판 · 평균 생존 ${Math.floor(x.sec / 60)}분 ${Math.round(x.sec % 60)}초 · 분당 피격 ${x.hpm.toFixed(1)}`
        : "아직 없음";

    let verdict = "";
    if (a && b) {
      if (a.n < 3 || b.n < 3) {
        verdict = '<span class="dim">양쪽 다 3판 이상 모여야 믿을 만합니다</span>';
      } else {
        const ratio = a.sec / Math.max(1, b.sec);
        verdict =
          ratio > 1.3
            ? `<span class="good">본 판이 ${ratio.toFixed(1)}배 오래 삽니다 — 화면을 보는 게 효과가 있습니다</span>`
            : ratio > 1.05
            ? `<span class="dim">본 판이 조금 낫습니다 (${ratio.toFixed(2)}배) — 판을 더 모아보세요</span>`
            : `<span class="bad">본 판과 블라인드 판이 거의 같습니다 (${ratio.toFixed(2)}배) — 지금은 화면을 봐도 도움이 안 되고 있습니다</span>`;
      }
    }
    el.vsBlindStats.innerHTML =
      `<b>화면을 본 판</b> — ${fmt(a)}<br />` +
      `<b>블라인드 판</b> — ${fmt(b)}` +
      (verdict ? `<br />${verdict}` : "");
  }

  function startRun() {
    run.startedAt = performance.now();
    run.blind = nextRunBlind();
    run.hits = 0;
    run.rewardSum = 0;
    run.steps = 0;
    run.rw = newBreakdown();
    for (const k of Object.keys(stuck)) stuck[k] = { at: 0, val: null, warned: false };
    lastHitAt = 0;
    pendingEnd = 0;
    run.active = true;
    pickedThisRun = [];
    save("pickedThisRun", pickedThisRun);
    logger.push(
      run.blind
        ? '<span class="good">판 시작</span> <span class="bad">블라인드 — 화면을 보지 않고 돌아다닙니다</span>'
        : '<span class="good">판 시작</span>'
    );
  }

  // 판을 끝내는 자리. 예전에는 'dead' 로 읽힐 때만 불렸는데, 그 화면을 못 읽거나
  // 너무 빨리 넘어가면 그 판이 통째로 사라졌다. 기록이 안 쌓이면 다음 판 프롬프트에
  // 실을 것이 없어서, 매번 아무것도 모르는 채로 새로 시작하게 된다.
  // 끝났다는 판단은 바로 확정하지 않고 일단 보류한다.
  // 부활 화면을 사망으로 잘못 읽어도, 플레이가 다시 시작되면 없던 일이 된다.
  const RESUME_WINDOW = 15000; // 이 안에 플레이가 돌아오면 같은 판으로 본다
  let pendingEnd = 0;
  let pendingWhy = "";

  function markEnd(why) {
    if (!run.active || pendingEnd) return;
    pendingEnd = performance.now(); // 끝난 시각은 지금으로 잡아둔다
    pendingWhy = why;
  }

  function cancelEnd(why) {
    if (!pendingEnd) return;
    pendingEnd = 0;
    logger.push(
      `<span class="dim">${why} — 끝난 게 아니라 이어지는 판이었습니다. 기록하지 않고 계속합니다</span>`
    );
  }

  function commitEnd() {
    if (!pendingEnd) return;
    const at = pendingEnd, why = pendingWhy;
    pendingEnd = 0;
    endRun(why, at);
  }

  function endRun(why, endedAt) {
    if (!run.active) return;
    run.active = false;
    pendingEnd = 0;
    // 보류하는 동안 흐른 시간은 생존 시간이 아니다. 끝났다고 본 그 시각으로 계산한다.
    const sec = ((endedAt || performance.now()) - run.startedAt) / 1000;
    if (sec < 3) {
      logger.push(
        `<span class="dim">${sec.toFixed(1)}초짜리 판은 기록하지 않습니다 (화면 인식이 튄 것으로 봅니다)</span>`
      );
      return;
    }
    const rec = {
      sec: Math.round(sec),
      hits: run.hits,
      hpm: run.hits / (sec / 60),
      avgReward: run.steps ? run.rewardSum / run.steps : 0,
      rw: run.rw,
      picks: pickedThisRun.slice(),
      blind: !!run.blind,
    };
    history.push(rec);
    if (history.length > 200) history.shift();
    save("runs", history);
    logger.push(
      `<span class="good">판 종료</span> <span class="dim">(${why || "사망"})</span> ` +
        `생존 ${Math.floor(rec.sec / 60)}분 ${rec.sec % 60}초 · ` +
        `피격 ${rec.hits}회 (분당 ${rec.hpm.toFixed(1)}) · ` +
        `<b>기록 ${history.length}판째</b> — 다음 판단에 같이 들어갑니다`
    );
    renderRuns();
    renderBlindStats();
    reportRun(rec);
  }

  // ---- 판이 끝나면: 무엇을 얻었는지 정리하고 목표를 놓는다 ----
  // 목표는 판 단위다. 한 판이 끝나면 그 목표는 거기서 끝이고, 계속 같은 목표로
  // 돌리고 싶을 때만 "목적 계속 반복"을 켠다. 안 켜져 있으면 목표 없이 쭉 진행한다.
  function runSummaryText(rec) {
    const picks = rec.picks?.length ? rec.picks.join(", ") : "고른 것 없음";
    return (
      `생존 ${Math.floor(rec.sec / 60)}분 ${rec.sec % 60}초 · 피격 ${rec.hits}회` +
      ` (분당 ${rec.hpm.toFixed(1)}) · 가져간 것: ${picks}`
    );
  }

  async function reportRun(rec) {
    const goalWas = (el.vsGoal.value || "").trim();
    const summary = runSummaryText(rec);
    const repeat = el.vsGoalRepeat.checked;

    el.vsRunResult.innerHTML =
      `<b>이번 판에서 얻은 것</b> <span class="dim">(기록 ${history.length}판)</span><br />${summary}` +
      (goalWas ? `<br /><span class="dim">목표였던 것: ${goalWas}</span>` : "");

    // 목표가 있었으면 그 목표에 비춰 어땠는지 한 줄로 받아온다. 글자만 보내면 되는 일이다.
    if (goalWas && el.vsModel.value && ws && ws.readyState === WebSocket.OPEN) {
      const prompt = `A run of Vampire Survivors just ended.

The player's goal for this run was (Korean):
${goalWas}

What actually happened:
${summary}

Did the run meet that goal? Answer in ONE short Korean sentence, plainly.

Answer with ONLY a JSON object, nothing else:
{"verdict": "<한국어 한 문장>"}`;
      const res = await askBridge(
        { type: "llm_ask", model: el.vsModel.value, prompt, timeout: 30 },
        35000
      );
      const o = res.error ? null : parseJson(res.text);
      const verdict = String(o?.verdict || "").slice(0, 100);
      if (verdict) {
        el.vsRunResult.innerHTML += `<br /><span class="good">${verdict}</span>`;
        logger.push(`<span class="tag">판 정리</span> <span class="dim">${verdict}</span>`);
      }
    }

    if (repeat) {
      el.vsGoalState.textContent = "목표 유지";
      el.vsRunResult.innerHTML += `<br /><span class="dim">목적 계속 반복이 켜져 있어 목표를 그대로 둡니다</span>`;
    } else if (goalWas) {
      el.vsGoal.value = "";
      save("goal", "");
      el.vsGoalState.textContent = "목표 비움";
      el.vsRunResult.innerHTML += `<br /><span class="dim">목표는 여기서 끝냅니다. 이어서 할 일이 있으면 위에 다시 적어주세요.</span>`;
    }
  }

  function renderRuns() {
    if (!history.length) {
      el.vsRuns.textContent = "기록 없음";
      el.vsReward.textContent = "-";
      return;
    }
    const last5 = history.slice(-5);
    const best = history.reduce((a, b) => (b.sec > a.sec ? b : a));
    const avgHpm = last5.reduce((a, r) => a + r.hpm, 0) / last5.length;
    el.vsRuns.textContent =
      `${history.length}판 · 최고 ${Math.floor(best.sec / 60)}분${best.sec % 60}초 · ` +
      `최근 5판 평균 분당 피격 ${avgHpm.toFixed(1)}회`;
    el.vsReward.innerHTML = rewardDiagnosis();
  }

  // 보상이 "좋은 보상"인지 보는 방법.
  // 1) 무엇으로 이루어져 있나 — 체력 항이 0이면 체력바를 못 읽는 것이고,
  //    그러면 여전히 픽셀 추정치만 보고 배우는 중이다.
  // 2) 보상이 높았던 판이 실제로 오래 버텼나 — 상관이 없으면 보상이 목표를 반영하지 못하는 것이다.
  function rewardDiagnosis() {
    const recent = history.slice(-20).filter((r) => r.rw);
    if (!recent.length) return "보상 기록 없음";

    const sum = newBreakdown();
    for (const r of recent) {
      for (const k of Object.keys(sum)) sum[k] += r.rw[k] || 0;
    }
    const total = Object.values(sum).reduce((a, b) => a + b, 0) || 1;
    const pct = (k) => ((sum[k] / total) * 100).toFixed(0);
    const names = { hp: "피격", escape: "탈출여지", xp: "경험치", gem: "젬근접", step: "시간" };
    const parts = Object.keys(sum).map((k) => `${names[k]} ${pct(k)}%`).join(" · ");

    let verdict = "";
    if (sum.hp === 0) {
      verdict += ' <span class="bad">피격 항이 0 — 맞았는지를 못 읽고 있습니다</span>';
    }
    if (sum.xp === 0) {
      verdict +=
        ' <span class="bad">경험치 항이 0 — 무언가를 얻었다는 신호가 아예 없습니다.' +
        ' 젬근접 항은 방향 분포일 뿐이라 먹었는지는 알려주지 않습니다.' +
        ' 화면 설정에서 경험치 바를 지정해주세요</span>';
    }

    let corr = "";
    if (recent.length >= 5) {
      const c = pearson(recent.map((r) => r.avgReward), recent.map((r) => r.sec));
      const judge =
        c > 0.4 ? '<span class="good">보상이 생존을 잘 반영합니다</span>'
        : c < 0.1 ? '<span class="bad">보상과 생존이 거의 무관합니다 — 보상 설계를 의심해야 합니다</span>'
        : '<span class="dim">약한 관계</span>';
      corr = `<br>보상↔생존 상관 ${c.toFixed(2)} (${recent.length}판) · ${judge}`;
    } else {
      corr = `<br><span class="dim">상관은 5판 이상 쌓이면 표시됩니다 (현재 ${recent.length}판)</span>`;
    }
    return `보상 구성: ${parts}${verdict}${corr}`;
  }

  function pearson(a, b) {
    const n = a.length;
    const ma = a.reduce((x, y) => x + y, 0) / n;
    const mb = b.reduce((x, y) => x + y, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    const den = Math.sqrt(da * db);
    return den < 1e-9 ? 0 : num / den;
  }

  // 규칙 기반 판단: 빠져나갈 여지가 큰 쪽으로, 적 압박은 피해서, 젬은 안전할 때만 욕심낸다.
  // 뱀서는 최적 행동이 거의 이 형태라 학습 없이도 곧잘 움직인다.
  // 학습은 이 위에 얹는다 (아래 blend).
  function rulePolicy(field, lastDir) {
    const wThreat = Number(el.vsAvoid.value) / 50; // 회피 성향 슬라이더
    const wGem = Number(el.vsGreed.value) / 50; // 젬 욕심 슬라이더

    // 위협의 무게중심을 구해서 그 반대쪽을 더 좋게 본다.
    // 이게 없으면 "적 쪽으로 가지 마라"만 있고 "적 반대로 도망쳐라"가 없어서,
    // 적이 없는 방향들이 전부 동점이 된다. 동점이면 첫 번째인 '위'가 뽑히므로
    // 적이 오른쪽에 있든 왼쪽에 있든 위로 가버렸다 (반응 검사에서 드러났다).
    let tx = 0, ty = 0;
    for (let k = 0; k < 8; k++) {
      tx += field.threat[k] * DIRS[k].ux;
      ty += field.threat[k] * DIRS[k].uy;
    }
    const tlen = Math.hypot(tx, ty);
    if (tlen > 1e-6) { tx /= tlen; ty /= tlen; }

    const score = new Float32Array(8);
    for (let d = 0; d < 8; d++) {
      // 적 무게중심 쪽이면 -1, 정반대면 +1
      const away = tlen > 1e-6 ? -(DIRS[d].ux * tx + DIRS[d].uy * ty) : 0;
      // 적이 코앞이면 젬은 눈에 들어오지 않아야 한다
      const safety = Math.min(1, field.escape[d] / 0.5);
      const momentum = lastDir === null ? 0 : (DIRS[d].ux * DIRS[lastDir].ux + DIRS[d].uy * DIRS[lastDir].uy);
      score[d] =
        field.escape[d] * 1.6 -
        field.threat[d] * wThreat +
        away * wThreat * 0.8 + // 적 반대쪽으로 도망치기
        field.gem[d] * wGem * safety +
        momentum * 0.25; // 방향이 매 프레임 튀는 걸 막는다
    }
    return score;
  }

  function normalize(arr) {
    let lo = Infinity, hi = -Infinity;
    for (const v of arr) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    return Array.from(arr, (v) => (v - lo) / span);
  }

  // decide() 와 같은 계산이지만 학습도 하지 않고 무작위 탐험도 하지 않는다.
  // "이 화면이면 어느 쪽을 고르나"만 알고 싶을 때 쓴다 (반응 검사, 시야 모니터).
  function pureChoice(field, lastDir) {
    const alpha = Number(el.vsAlpha.value) / 100;
    const obs = [...field.threat, ...field.escape, ...field.gem];
    const learned = normalize(brain.qValues(brain.encode(obs)));
    const rule = normalize(rulePolicy(field, lastDir));
    const score = rule.map((r, d) => (1 - alpha) * r + alpha * learned[d]);
    let action = 0;
    for (let d = 1; d < 8; d++) if (score[d] > score[action]) action = d;
    return { action, score, rule, learned, alpha };
  }

  function decide(info) {
    const alpha = Number(el.vsAlpha.value) / 100; // 학습에 맡기는 비중
    const obs = [...info.field.threat, ...info.field.escape, ...info.field.gem];
    const activeKC = brain.encode(obs);
    const brainQ = brain.qValues(activeKC);

    const ruleScore = normalize(rulePolicy(info.field, lastAction));
    const learned = normalize(brainQ);
    let action = 0;
    let best = -Infinity;
    for (let d = 0; d < 8; d++) {
      const s = (1 - alpha) * ruleScore[d] + alpha * learned[d];
      if (s > best) { best = s; action = d; }
    }
    const explored = Math.random() < epsilon * alpha; // 학습 비중만큼만 탐험한다
    if (explored) action = Math.floor(Math.random() * 8);

    if (lastObs && lastAction !== null) {
      const nowMs = performance.now();
      let hpTerm = 0;
      if (info.hp !== null && prevHp !== null && info.hp < prevHp - 0.005) {
        // 줄어든 체력만큼 감점한다. 이건 프레임 수와 무관하다 —
        // 같은 양을 잃으면 몇 프레임에 걸쳐 잃든 합계가 같다.
        hpTerm = -(prevHp - info.hp) * 12;
        countHit(nowMs);
      } else if (info.hurt) {
        // 체력바를 못 읽을 때의 대비책. 계속 빨간 상태라면 계속 맞고 있는 것이므로
        // 매 프레임 감점하되, dt 를 곱해 FPS가 달라도 초당 감점이 같게 한다.
        hpTerm = -HURT_PER_SEC * lastDt;
        countHit(nowMs);
      }
      prevHurt = info.hurt;
      // 체력이 읽히면 그게 진짜 신호다. 없으면 "빠져나갈 여지"를 대신 쓴다.
      const escTerm = (avg(info.field.escape) - avg(lastObs.escape)) * 0.5;

      // 경험치가 올랐다 = 젬을 실제로 먹었다. 이건 의심할 여지가 없는 신호다.
      // 레벨업으로 바가 리셋되면 음수가 크게 나오는데, 그건 잘못한 게 아니므로 무시한다.
      let xpTerm = 0;
      if (info.xp !== null && prevXp !== null) {
        const d = info.xp - prevXp;
        if (d > 0.002) xpTerm = Math.min(d, 0.2) * 10; // 인식이 튄 값은 잘라낸다
      }
      prevXp = info.xp;

      // 젬 항은 "젬 쪽으로 가고 있나"에 불과하다. fieldFeatures 가 매 프레임 최대값으로
      // 정규화하므로 양이 아니라 분포의 모양이고, 먹어서 사라지면 오히려 요동친다.
      // 경험치를 읽고 있으면 그쪽이 진짜 신호이므로 이 항은 거의 꺼둔다.
      const gemWeight = info.xp !== null ? 0.05 : 0.2;
      const gemTerm = (avg(info.field.gem) - avg(lastObs.gem)) * gemWeight;
      const stepTerm = -0.01;
      const reward = hpTerm + escTerm + xpTerm + gemTerm + stepTerm;

      // 보상이 실제로 무엇으로 이루어지는지 기록해둔다.
      // 체력 항이 거의 0이면 체력바를 못 읽고 있다는 뜻이고, 그러면 학습은 여전히
      // "픽셀 추정치"만 보고 있는 것이다 — 로그로 드러나야 알 수 있다.
      if (run.rw) {
        run.rw.hp += Math.abs(hpTerm);
        run.rw.escape += Math.abs(escTerm);
        run.rw.xp += Math.abs(xpTerm);
        run.rw.gem += Math.abs(gemTerm);
        run.rw.step += Math.abs(stepTerm);
        run.rewardSum += reward;
        run.steps++;
      }

      const dopamine = brain.learn(lastActive, lastAction, reward, obs, false);
      logStep(DIRS[action].name, brainQ[action], explored, reward, dopamine, info, hpTerm, alpha);
    }

    if (info.hp !== null) prevHp = info.hp;
    lastObs = info.field;
    lastAction = action;
    lastActive = activeKC;
    return action;
  }

  // ---- 몰리 시야 ----
  // 왼쪽: 뇌가 받는 24x24 격자 (빨강 = 적, 파랑 = 젬). 가운데 흰 점이 캐릭터.
  // 오른쪽: 8방향 점수. 선이 길수록 그쪽을 좋게 본 것이고, 노란 굵은 선이 실제로 고른 방향.
  // 아래 표: 방향마다 위협·탈출여지·젬·최종점수를 숫자로.
  let lastTaken = null; // 실제로 누른 방향 (블라인드면 화면과 무관)
  let lastWorldFrozen = false;
  let frozeAt = 0; // 마지막으로 멈춘 순간
  let lastFrozenWhy = "";
  const frozenText = () => (lastWorldFrozen ? "예 (" + lastFrozenWhy + ")" : "아니오");
  let lastTakenBlind = false;

  function sightVisible() {
    return document.querySelector('.vs-sec[data-sec="see"]')?.classList.contains("is-active");
  }

  function drawSight(info) {
    const cv = el.vsSight;
    const g = cv.getContext("2d");
    const W = cv.width, H = cv.height;
    g.fillStyle = "#12141b";
    g.fillRect(0, 0, W, H);

    // --- 왼쪽: 격자 (화면 사각형 전체를 덮는다) ---
    const gh = H - 20;
    const gw = Math.min(gh * geomAspect, W * 0.6);
    const ox = 10, oy = 10, cw = gw / GRID_N, ch = gh / GRID_N;
    const size = gw; // 오른쪽 점수판 위치 계산에 쓴다
    for (let gy = 0; gy < GRID_N; gy++) {
      for (let gx = 0; gx < GRID_N; gx++) {
        const i = gy * GRID_N + gx;
        const e = info.enemyGrid[i], m = info.gemGrid[i];
        const r = Math.round(40 + 215 * Math.min(1, e));
        const b = Math.round(40 + 215 * Math.min(1, m));
        g.fillStyle = `rgb(${r},${Math.round(40 + 40 * Math.min(1, m))},${b})`;
        g.fillRect(ox + gx * cw, oy + gy * ch, cw - 1, ch - 1);
      }
    }
    g.strokeStyle = "rgba(255,255,255,0.25)";
    g.strokeRect(ox - 0.5, oy - 0.5, gw, gh);
    g.fillStyle = "#fff";
    g.fillRect(ox + gw / 2 - 3, oy + gh / 2 - 3, 6, 6);
    g.fillStyle = "#b6b6c0";
    g.font = "14px NeoDunggeunmo, monospace";
    g.fillText("뇌가 받는 격자 (화면 전체)", ox, oy + gh + 8);

    // --- 오른쪽: 8방향 점수 ---
    const choice = pureChoice(info.field, lastTaken);
    const cx = ox + size + 40 + (W - (ox + size + 40)) / 2;
    const cy = H / 2;
    const R = Math.min(H / 2 - 24, (W - (ox + size + 40)) / 2 - 30);

    g.strokeStyle = "rgba(255,255,255,0.12)";
    for (const k of [0.25, 0.5, 0.75, 1]) {
      g.beginPath();
      g.arc(cx, cy, R * k, 0, Math.PI * 2);
      g.stroke();
    }

    for (let d = 0; d < 8; d++) {
      const ux = DIRS[d].ux, uy = DIRS[d].uy;
      const sc = choice.score[d];
      const picked = d === choice.action;
      g.strokeStyle = picked ? "#ffd479" : "rgba(79,216,224,0.75)";
      g.lineWidth = picked ? 6 : 3;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + ux * R * Math.max(0.04, sc), cy + uy * R * Math.max(0.04, sc));
      g.stroke();
      // 위협이 있는 방향은 바깥쪽에 빨간 호로 표시
      const th = info.field.threat[d];
      if (th > 0.05) {
        g.strokeStyle = `rgba(255,90,80,${0.3 + 0.7 * th})`;
        g.lineWidth = 4;
        const a = Math.atan2(uy, ux);
        g.beginPath();
        g.arc(cx, cy, R + 8, a - 0.3, a + 0.3);
        g.stroke();
      }
      g.fillStyle = picked ? "#ffd479" : "#b6b6c0";
      g.fillText(DIRS[d].name, cx + ux * (R + 20) - 14, cy + uy * (R + 20) + 5);
    }
    g.lineWidth = 1;

    // 실제로 누른 방향 (블라인드면 화면과 무관한 방향)
    if (lastTaken !== null && running) {
      const ux = DIRS[lastTaken].ux, uy = DIRS[lastTaken].uy;
      g.strokeStyle = lastTakenBlind ? "#ff7b6b" : "#7fd858";
      g.setLineDash([4, 4]);
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + ux * R, cy + uy * R);
      g.stroke();
      g.setLineDash([]);
      g.lineWidth = 1;
    }

    // --- 아래 표 ---
    const rows = [];
    for (let d = 0; d < 8; d++) {
      const f = info.field;
      const picked = d === choice.action;
      rows.push(
        `<tr${picked ? ' class="picked"' : ""}><td>${DIRS[d].name}</td>` +
          `<td>${f.threat[d].toFixed(2)}</td><td>${f.escape[d].toFixed(2)}</td>` +
          `<td>${f.gem[d].toFixed(2)}</td><td>${choice.score[d].toFixed(2)}</td></tr>`
      );
    }
    el.vsSightTable.innerHTML =
      "<tr><th>방향</th><th>위협</th><th>탈출여지</th><th>젬</th><th>최종점수</th></tr>" + rows.join("");

    // 왜 그쪽인가 — 가장 위협적인 방향과 고른 방향을 한 줄로
    let worst = 0;
    for (let d = 1; d < 8; d++) if (info.field.threat[d] > info.field.threat[worst]) worst = d;
    const f = info.field, a = choice.action;
    const taken =
      lastTaken === null || !running
        ? ""
        : lastTakenBlind
        ? ` · <span class="bad">실제로는 ${DIRS[lastTaken].name} (블라인드 — 화면 무시)</span>`
        : lastTaken === a
        ? ` · <span class="good">실제로도 ${DIRS[lastTaken].name}</span>`
        : ` · <span class="dim">실제로는 ${DIRS[lastTaken].name} (직전 방향 유지·탐험 때문)</span>`;
    el.vsSightWhy.innerHTML =
      `시야로 고를 방향: <b>${DIRS[a].name}</b> ` +
      `<span class="dim">(탈출여지 ${f.escape[a].toFixed(2)} · 위협 ${f.threat[a].toFixed(2)} · 젬 ${f.gem[a].toFixed(2)})</span>` +
      (f.threat[worst] > 0.05
        ? ` · 가장 위험한 쪽은 <b>${DIRS[worst].name}</b> (위협 ${f.threat[worst].toFixed(2)})`
        : " · <span class=\"dim\">주변에 적이 거의 없음</span>") +
      taken +
      `<br /><span class="dim">적 ${info.enemyCount} · 젬 ${info.gemCount} · 인식 흔들림 ${info.jitter.toFixed(3)} · ` +
      `학습 비중 ${Math.round(choice.alpha * 100)}%</span>` +
      `<br /><span class="dim">적 판별: ${
        { color: "색", motion: "움직임", both: "색 + 움직임" }[el.vsEnemyMode.value]
      }${info.usedMotion ? "" : " (이번 프레임은 색으로 대신함)"} · ` +
      `카메라 이동 (${info.shift.dx}, ${info.shift.dy}) · 정렬 오차 ${info.shift.err.toFixed(1)}` +
      `${info.shift.ok ? "" : " — 장면이 바뀜"} · 스스로 움직이는 점 ${info.movingCount}</span>` +
      (regions.length
        ? `<br /><span class="dim">이 화면에서 LLM 에게 알려주는 영역: ${
            regionsNow(stableState).map((r) => r.label).join(", ") || "없음"
          }</span>`
        : "") +
      (lastOcr && !lastOcr.test
        ? `<br /><span class="dim">화면 글자(OCR, ${((performance.now() - lastOcr.at) / 1000).toFixed(0)}초 전): ` +
          `${lastOcr.lines.map((l) => l.text).slice(0, 8).join(" · ") || "(없음)"} → ` +
          (lastOcr.match
            ? "<b>" + STATES[lastOcr.match.state] + '</b> ("' + lastOcr.match.text + '")'
            : "아는 화면 글자 없음") +
          "</span>"
        : "") +
      `<br /><span class="dim">게임 멈춤: <b>${frozenText()}</b>` +
      (el.vsUiBlue.checked
        ? ` — 파란 창 <b>${(info.ui.blue * 100).toFixed(0)}%</b> (${el.vsUiThr.value}% 넘으면 게임 아님) · ` +
          `창이 아닌 파랑(바닥으로 보고 뺌) ${(info.ui.rough * 100).toFixed(0)}% · ` +
          `창 색 ${uiColor ? "기억함" : "모름(파란 계열 전부)"} · ` +
          `카메라 ${performance.now() - lastCamMoveAt >= CAM_STILL_MS ? "멈춤" : "움직임 — 창 아님"} · ` +
          `빨강 ${(info.ui.red * 100).toFixed(1)}% · ` +
          `창 없이 ${LONG_FREEZE / 1000}초 동안 아무것도 안 움직이면 그때도 멈춤`
        : "") +
      (info.outerMove !== null
        ? ` · 바깥 전장 움직임 ${(info.outerMove * 100).toFixed(2)}% (${STILL_RATIO * 100}% 미만이면 정지)`
        : "") +
      `</span>`;
  }

  // ---- 반응 검사: 인공 상황을 넣어 고른 방향이 말이 되는지 ----
  // 방향 d 쪽(과 양옆)의 칸에 값을 채운 격자를 만든다. 실제 격자 기하를 그대로 쓴다.
  function blobGrid(dir, lo = 0.2, hi = 0.65, spread = 1) {
    const g = new Float32Array(CELLS);
    if (dir === null) return g;
    for (let i = 0; i < CELLS; i++) {
      const d = cellDir[i];
      if (d < 0) continue;
      const off = Math.min((d - dir + 8) % 8, (dir - d + 8) % 8);
      if (off <= spread && cellDist[i] >= lo && cellDist[i] <= hi) g[i] = 1;
    }
    return g;
  }

  // 여덟 방향 중 한 쪽만 비워두고 나머지를 다 막은 격자
  function ringExcept(gap) {
    const g = new Float32Array(CELLS);
    for (let i = 0; i < CELLS; i++) {
      const d = cellDir[i];
      if (d < 0 || d === gap) continue;
      if (cellDist[i] >= 0.2 && cellDist[i] <= 0.6) g[i] = 1;
    }
    return g;
  }

  const dot = (a, b) => DIRS[a].ux * DIRS[b].ux + DIRS[a].uy * DIRS[b].uy;

  function runProbe() {
    // [이름, 적 격자, 젬 격자, 채점]
    // 채점: 고른 방향이 "적이 있는 쪽과 반대"거나 "젬이 있는 쪽"이면 통과
    const cases = [
      ["적이 오른쪽에 몰림", blobGrid(2), blobGrid(null), (a) => dot(a, 2) < 0, "왼쪽 계열"],
      ["적이 왼쪽에 몰림", blobGrid(6), blobGrid(null), (a) => dot(a, 6) < 0, "오른쪽 계열"],
      ["적이 위쪽에 몰림", blobGrid(0), blobGrid(null), (a) => dot(a, 0) < 0, "아래쪽 계열"],
      ["적이 아래쪽에 몰림", blobGrid(4), blobGrid(null), (a) => dot(a, 4) < 0, "위쪽 계열"],
      ["적 없음, 젬이 오른쪽", blobGrid(null), blobGrid(2, 0.2, 0.7, 0), (a) => dot(a, 2) > 0.5, "오른쪽 계열"],
      ["적 없음, 젬이 왼쪽", blobGrid(null), blobGrid(6, 0.2, 0.7, 0), (a) => dot(a, 6) > 0.5, "왼쪽 계열"],
      ["사방이 막히고 왼아래만 뚫림", ringExcept(5), blobGrid(null), (a) => dot(a, 5) > 0.5, "왼아래 계열"],
      ["사방이 막히고 오른위만 뚫림", ringExcept(1), blobGrid(null), (a) => dot(a, 1) > 0.5, "오른위 계열"],
    ];

    const rows = [];
    let pass = 0, stable = 0;
    for (const [name, eg, gg, ok, want] of cases) {
      const field = fieldFeatures(eg, gg);
      // 같은 상황을 5번 넣는다. 화면을 보고 정하는 것이라면 매번 같아야 한다.
      const picks = [];
      for (let k = 0; k < 5; k++) picks.push(pureChoice(field, null).action);
      const a = picks[0];
      const same = picks.every((p) => p === a);
      const good = ok(a);
      if (good) pass++;
      if (same) stable++;
      rows.push(
        `<div>${good ? '<span class="good">통과</span>' : '<span class="bad">실패</span>'} ` +
          `${name} → <b>${DIRS[a].name}</b> <span class="dim">(기대: ${want})</span>` +
          (same ? "" : ` <span class="bad">· 5번 중 답이 흔들림: ${picks.map((p) => DIRS[p].name).join(",")}</span>`) +
          "</div>"
      );
    }

    // 텅 빈 화면은 기준선 — 여기서 고르는 방향에는 의미가 없다
    const empty = pureChoice(fieldFeatures(blobGrid(null), blobGrid(null)), null).action;

    const total = cases.length;
    const verdict =
      pass === total && stable === total
        ? '<span class="good">화면에 반응합니다 — 상황을 바꾸면 고르는 방향도 말이 되게 바뀝니다</span>'
        : pass >= total * 0.75
        ? '<span class="dim">대체로 반응하지만 틀리는 상황이 있습니다 — 아래 실패 항목을 보세요</span>'
        : '<span class="bad">화면과 무관하게 움직이는 것에 가깝습니다</span>';

    const alpha = Number(el.vsAlpha.value);
    el.vsProbeResult.innerHTML =
      `<b>${pass}/${total} 통과 · 반복 일관성 ${stable}/${total}</b> — ${verdict}<br />` +
      `<span class="dim">학습 비중 ${alpha}% 기준 (0%면 규칙만, 100%면 학습한 뇌만 시험합니다) · ` +
      `텅 빈 화면에서는 ${DIRS[empty].name} (기준선, 의미 없음)</span>` +
      rows.join("");
    logger.push(`<span class="tag">반응 검사</span> ${pass}/${total} 통과 · 일관성 ${stable}/${total}`);
  }

  const avg = (a) => {
    let s = 0;
    for (const v of a) s += v;
    return s / a.length;
  };

  function logStep(dirName, q, explored, reward, dopamine, info, hpTerm, alpha) {
    if (!el.vsLogOn.checked) return;
    const why = explored
      ? `<span class="dim">무작위 탐험</span>`
      : alpha === 0
      ? `<span class="dim">규칙 기반</span>`
      : `규칙 ${((1 - alpha) * 100) | 0}% + 학습 ${(alpha * 100) | 0}% <span class="dim">(Q ${fmtNum(q)})</span>`;
    const hurt = hpTerm < 0 ? ` <span class="bad">피격 ${fmtNum(hpTerm)}</span>` : "";
    const esc = avg(info.field.escape).toFixed(2);
    logger.push(
      `<span class="pick">${dirName}</span> · ${why} · 탈출여지 ${esc} · ` +
        `적 ${info.enemyCount} 젬 ${info.gemCount}${hurt} · 보상 ${fmtNum(reward)} · DA ${fmtNum(dopamine)}`
    );
  }

  // ---- 메뉴/레벨업 ----
  // 마우스는 쓰지 않는다. 모니터가 여러 대면 창이 어느 모니터에 있는지 알 수 없어서
  // 클릭이 엉뚱한 화면으로 간다. 키보드는 활성화된 창으로 그냥 들어가므로 그 문제가 없다.
  //
  // 메뉴에는 포기·종료처럼 되돌릴 수 없는 항목이 있어서 아무 키나 눌러보게 두지 않는다.
  // 여기서 지정한 키만 누르고, 지정 안 하면 아무것도 하지 않는다. ESC는 절대 자동으로 누르지 않는다.
  let lastActAt = 0;
  let warnedNoLlm = false;
  let warnedCardRect = false;
  let sending = false;

  async function handleMenu(state) {
    if (heldKeys.length) { heldKeys = []; sendKeys([]); }
    if (sending || llmBusy || idBusy) return;

    // 방금 누른 키가 먹었는지 아직 지켜보는 중이면 또 누르지 않는다.
    // 예전에는 1.4초만 지나면 다시 눌러서, 레벨업에서 고르고 난 뒤에
    // 키가 한 번 더 나가 엉뚱한 것이 확정되곤 했다.
    if (pendingMenu) return;

    const now = performance.now();
    if (now - lastActAt < 1400) return; // 화면이 넘어갈 시간을 준다
    if (now < menuStuckUntil) return;   // 같은 화면에서 막혔다 — 계속 두드리지 않는다

    // 멈춘 화면은 전부 LLM이 지시한다. 예전에는 화면마다 누를 키를 미리 정해두고
    // 실패하면 그걸로 떨어졌는데, 화면마다 눌러야 할 것이 달라서 맞을 수가 없었고
    // LLM이 제대로 고른 뒤에도 그 키가 한 번 더 나갔다. 지웠다.
    if (!el.vsLlmOn.checked || !el.vsModel.value) {
      if (!warnedNoLlm) {
        warnedNoLlm = true;
        logger.push(
          '<span class="bad">멈춘 화면인데 LLM이 꺼져 있습니다</span> ' +
            '<span class="dim">— 무엇을 눌러야 할지 정할 수단이 없어 기다립니다. ' +
            "LLM 설정에서 모델을 고르고 켜주세요.</span>"
        );
      }
      el.vsLlmState.textContent = "꺼짐 — 대기";
      return;
    }
    warnedNoLlm = false;

    lastActAt = now;
    llmBusy = true;

    // 레벨업은 "몇 번째 카드"를 고르는 문제라 전용 경로를 쓴다.
    if (state === "levelup") {
      const nCards = Math.max(2, Math.min(5, Number(el.vsCards.value)));
      const choice = await llmPickCard(nCards);
      if (choice && !uiColor) learnColorAsk = "auto"; // 레벨업 창이 확실히 떠 있는 순간이다

      if (!choice) {
        llmBusy = false;
        el.vsLlmState.textContent = "실패 — 누르지 않고 대기";
        return;
      }

      // 예전에는 "커서가 몇 번째 카드에 있다" 를 한 번 읽고 이동 키와 엔터를 한꺼번에 눌렀다.
      // 커서 위치를 한 칸만 잘못 읽어도, 또는 첫 입력이 커서를 잡기만 하고 움직이지 않아도
      // 엉뚱한 카드가 확정됐다. 메뉴와 같은 길로 간다 — 옮기고, 다시 읽어 확인하고, 그때만 엔터.
      const plan = { options: choice.options, sel: choice.si, tgt: choice.ti, layout: "vertical", columns: 1 };
      const nav = await moveCursorTo(state, plan, () => running, () => llmSeeLevel(nCards));
      llmBusy = false;
      const path = nav.trail.length ? nav.trail.join(" → ") : `이미 ${choice.item} 위`;
      noteReadNav(choice.item, nav, path);

      if (!nav.reached) {
        el.vsLlmState.textContent = "커서를 못 옮김 — 엔터 안 누름";
        logger.push(
          `<span class="tag">레벨업</span> <span class="bad">"${choice.item}" 로 못 옮겨서 엔터를 누르지 않았습니다</span> ` +
            `<span class="dim">[읽음: ${choice.options.join(" / ")}] [${path}]</span>`
        );
        return;
      }
      el.vsLlmState.textContent = `${choice.item} (${(choice.took || 0).toFixed(1)}초)`;
      pickedThisRun.push(choice.item);
      save("pickedThisRun", pickedThisRun);
      // 무엇을 보고 어디로 갔는지 남긴다. 고른 것과 누른 게 어긋나면 바로 드러난다.
      logger.push(
        `<span class="tag">레벨업</span> <span class="pick">${choice.item}</span> ` +
          `<span class="dim">[읽음: ${choice.options.join(" / ")}]</span> ` +
          `<span class="dim">[${path} → 엔터] </span>` +
          `<span class="dim">${choice.why}</span>`
      );
      const before = lastThumb; // 엔터 직전 화면 — 넘어갔는지를 이것과 비교한다
      await tapSequence(["enter"]);
      llmBusy = true; // 확정 버튼으로 옮기는 동안 다른 판단이 끼어들지 않게
      const conf = await confirmIfNeeded(state, choice.item, () => running, before);
      llmBusy = false;
      if (conf.needed) {
        logger.push(
          `<span class="tag">레벨업</span> ` +
            (conf.pressed
              ? `<span class="pick">"${conf.button}" 로 확정</span>`
              : `<span class="bad">"${conf.button}" 로 못 옮겨 확정하지 못했습니다</span>`) +
            ` <span class="dim">[${conf.path}]</span>`
        );
        noteReadConfirm(choice.item, conf);
      }
      pendingMenu = { state, keys: [...nav.moved, "enter", ...(conf.moved || [])], at: performance.now(), before };
      return;
    }

    // 나머지 멈춘 화면: 무엇을 고를지는 LLM, 어떻게 가는지는 코드.
    // 예전에는 "지금 커서 위치 → 목표" 를 한 번 읽고 이동 키와 엔터를 한꺼번에 눌렀다.
    // 커서 위치를 잘못 읽거나, 목표가 이동으로 닿지 않는 버튼(확인·시작)이면 엉뚱한 칸에서
    // 엔터가 눌렸고, 다음에 같은 화면을 보면 또 똑같이 눌렀다 (s s s s → 엔터 반복).
    // 이제는 옮긴 뒤 다시 읽어서 커서가 목표 위에 있을 때만 엔터를 누른다.
    const plan = await llmPlanMenu(state);
    if (!plan) {
      llmBusy = false;
      el.vsLlmState.textContent = "실패 — 누르지 않고 대기";
      return;
    }
    if (plan.stuck) {
      llmBusy = false;
      menuStuckUntil = performance.now() + STUCK_WAIT;
      el.vsLlmState.textContent = "막힘 — 잠시 대기";
      if (stuckLogged) return; // 20초마다 같은 말을 되풀이하지 않는다
      stuckLogged = true;
      logger.push(
        `<span class="bad">이 화면에서 막혔습니다</span> ` +
          `<span class="dim">— ${plan.stuck.map((t) => '"' + t + '"').join(", ")} 로 가서 엔터를 눌러봤지만 넘어가지 않았습니다. ` +
          `${STUCK_WAIT / 1000}초 쉬었다가 다시 봅니다. 무엇을 눌러야 하는지 알면 화면 설정에서 이 화면에 메모로 알려주세요.</span>`
      );
      return;
    }
    if (plan.tgt < 0) {
      llmBusy = false;
      el.vsLlmState.textContent = `누르지 않음 (${plan.took.toFixed(1)}초)`;
      logger.push(
        `<span class="tag">${STATES[state] || state}</span> <span class="pick">누르지 않음</span> ` +
          `<span class="dim">${plan.why}</span>`
      );
      return;
    }

    const target = plan.options[plan.tgt];
    const { reached, trail, moved } = await moveCursorTo(state, plan, () => running);
    llmBusy = false;

    stuckLogged = false;
    menuTries.push({ state, options: plan.options, target, at: performance.now() });
    const path = trail.length ? trail.join(" → ") : `이미 ${target} 위`;
    if (!reached) {
      el.vsLlmState.textContent = "커서를 못 옮김 — 엔터 안 누름";
      logger.push(
        `<span class="tag">${STATES[state] || state}</span> <span class="bad">"${target}" 로 못 옮겨서 엔터를 누르지 않았습니다</span> ` +
          `<span class="dim">[${path}] ${plan.why}</span>`
      );
      return;
    }

    el.vsLlmState.textContent = `${target} 에서 엔터 (${plan.took.toFixed(1)}초)`;
    logger.push(
      `<span class="tag">${STATES[state] || state}</span> <span class="pick">${target}</span> ` +
        `<span class="dim">[${path} → 엔터] ${plan.note ? plan.note + " · " : ""}${plan.why}</span>`
    );
    await noteCharacter(target); // 캐릭터를 고르는 거면 기억한다 (시작 무기를 레벨업 공략에 쓴다)
    // 넘어갔는지는 엔터 직전 화면과 비교한다. 커서를 옮기며 바뀐 것은 넘어간 게 아니다.
    const before = lastThumb;
    await tapSequence(["enter"]);
    // 캐릭터 선택처럼 "고르고 → 확인" 하는 화면이면 확인 버튼까지 누른다
    llmBusy = true;
    const conf = await confirmIfNeeded(state, target, () => running, before);
    llmBusy = false;
    if (conf.needed) {
      logger.push(
        `<span class="tag">${STATES[state] || state}</span> ` +
          (conf.pressed
            ? `<span class="pick">"${conf.button}" 로 확정</span>`
            : `<span class="bad">"${conf.button}" 로 못 옮겨 확정하지 못했습니다</span>`) +
          ` <span class="dim">[${conf.path}]</span>`
      );
    }
    pendingMenu = { state, keys: [...moved, "enter", ...(conf.moved || [])], at: performance.now(), before };
  }

  // 커서를 plan.tgt 항목까지 옮긴다. 옮길 때마다 화면을 다시 읽어 커서가 정말 거기 섰는지 본다.
  // 엔터는 누르지 않는다 — 도착했을 때만 부르는 쪽이 누른다.
  // keepGoing: 도중에 그만둬야 하는지 (자동 조작이면 '조작 중인가', 폰 지시면 '지시를 하는 중인가')
  // see: 옮긴 뒤 화면을 다시 읽는 방법 (없으면 메뉴 읽기). 레벨업은 카드만 읽는 걸 넘긴다.
  async function moveCursorTo(state, plan, keepGoing, see) {
    const target = plan.options[plan.tgt];
    const trail = []; // 무엇을 보고 어떻게 옮겼는지. 로그에 그대로 남긴다
    const moved = [];
    let cur = plan;
    let tgt = plan.tgt;
    let still = 0; // 눌렀는데 커서가 그대로였던 횟수
    for (let round = 0; cur.sel !== tgt; round++) {
      if (round >= MENU_ROUNDS || !keepGoing()) break;
      const keys = moveKeys(cur.sel, tgt, cur.layout, cur.columns);
      const grid = cur.layout === "grid" ? ` ${cur.columns}칸 격자` : "";
      trail.push(`${cur.options[cur.sel]}에서 ${keys.join(" ")}${grid}`);
      const beforeMove = lastThumb;
      el.vsLlmState.textContent = `옮기는 중 (${keys.join(" ")})`;
      await tapSequence(keys);
      moved.push(...keys);
      await new Promise((r) => setTimeout(r, 450)); // 커서가 옮겨 그려질 시간
      const diff = beforeMove && lastThumb ? thumbDist(beforeMove, lastThumb) : 0;

      el.vsLlmState.textContent = "옮긴 뒤 다시 읽는 중...";
      const again = see ? await see() : await llmSee(state, el.vsModel.value);
      if (!again) break;
      const t2 = indexOfOption(again.options, target);
      if (t2 < 0) {
        trail.push(`다시 읽으니 "${target}" 가 목록에 없음`);
        cur = null;
        break;
      }
      if (again.sel === cur.sel && again.options[again.sel] === cur.options[cur.sel]) {
        trail.push(
          `커서가 그대로 ${again.options[again.sel]} (화면 차이 ${diff.toFixed(3)}` +
            (diff < 0.002 ? " — 이동 키가 안 먹은 듯" : " — 화면은 바뀜, 커서 위치를 잘못 읽는 듯") + ")"
        );
        // 첫 입력은 커서를 잡기만 하고 움직이지 않는 화면이 있다. 한 번은 더 눌러 본다.
        if (++still >= 2) {
          cur = null;
          break;
        }
        continue;
      }
      still = 0;
      cur = again;
      tgt = t2;
    }
    return { reached: !!cur && cur.sel === tgt, trail, moved };
  }

  // 레벨업 화면을 다시 읽는다 (커서를 옮긴 뒤 확인용). 카드만 — 버튼은 목록에 넣지 않는다.
  async function llmSeeLevel(nCards) {
    const crop = cropRegion(cardRect || gameRect, LEVELUP_MAX_SIDE);
    if (!crop) return null;
    const ocr = await ocrRead(cardRect || gameRect);
    const res = await askBridge(
      {
        type: "llm_ask", model: el.vsModel.value, timeout: 40, image: crop.b64,
        prompt: buildSeeLevelPrompt(nCards, ocr?.lines),
      },
      45000
    );
    if (res.error) return null;
    const seen = parseJson(res.text);
    const raw = (Array.isArray(seen?.options) ? seen.options : [])
      .map((x) => String(x || "").trim().slice(0, 24))
      .filter(Boolean);
    const sel = indexOfOption(raw, seen?.selected);
    if (!raw.length || sel < 0) return null;
    // 처음 읽을 때와 같은 방법으로 이름을 고쳐야 목표 카드를 목록에서 다시 찾을 수 있다
    return { options: fixCardNames(raw, ocr?.lines).names, sel, layout: "vertical", columns: 1 };
  }

  function noteReadConfirm(item, conf) {
    const r = readLog[readLog.length - 1];
    if (!r || r.picked !== item) return;
    r.nav = (r.nav || "") + confirmNote(conf);
    r.keys = [...(r.keys || []), ...(conf.moved || [])];
    save("readLog", readLog);
    renderReadLog();
  }

  // 레벨업에서 읽은 기록에 실제로 어떻게 옮겼고 무엇을 눌렀는지 붙인다
  function noteReadNav(item, nav, path) {
    const r = readLog[readLog.length - 1];
    if (!r || r.picked !== item) return;
    r.keys = nav.reached ? [...nav.moved, "enter"] : nav.moved;
    r.nav = path + (nav.reached ? " → 엔터" : " — 못 옮겨서 엔터 안 누름");
    save("readLog", readLog);
    renderReadLog();
  }

  // ---- 고르고 나서 한 번 더 확정하는 화면 ----
  // 레벨업은 카드에서 엔터를 누르면 "골라 둔" 상태가 될 뿐이고, 아래 "획득하기" 로 커서를 옮겨
  // 엔터를 한 번 더 눌러야 확정된다. 예전에는 카드에서 엔터만 누르고 끝나서 화면이 그대로 멈춰 있었다.
  // 엔터 뒤에도 같은 화면이고 화면 글자에 확정 버튼이 보이면, 그리로 옮겨 한 번 더 누른다.
  const CONFIRM_WORDS = ["획득하기", "획득", "확인", "선택하기", "OBTAIN", "ACQUIRE", "CONFIRM", "TAKE"];
  const CONFIRM_STEPS = 6;

  function findConfirm(lines, chosen) {
    for (const w of CONFIRM_WORDS) {
      const nw = ocrNorm(w);
      const hit = (lines || []).find((l) => {
        const t = ocrNorm(l.text);
        // 방금 고른 게 확정 버튼 자신이면 (예: "확인" 을 눌렀다) 또 누를 게 아니다
        return t && (t === nw || (t.length <= nw.length + 3 && t.includes(nw))) && similar(t, ocrNorm(chosen)) < 0.8;
      });
      if (hit) return hit;
    }
    return null;
  }

  // 화면 글자의 위치로 방향을 잡아 target 글자까지 한 칸씩 옮긴다. 옮길 때마다 다시 읽어
  // 커서가 어디 섰는지 본다. 카드 목록(세로)과 아래 버튼 줄(가로)처럼 배치가 섞여 있어도 된다.
  async function moveToLabel(state, target, keepGoing) {
    const trail = [], moved = [];
    for (let step = 0; step < CONFIRM_STEPS && keepGoing(); step++) {
      const seen = await llmSee(state, el.vsModel.value);
      if (!seen) {
        trail.push("화면을 못 읽음");
        break;
      }
      const cur = seen.options[seen.sel];
      const nc = ocrNorm(cur), nt = ocrNorm(target);
      if (nc === nt || similar(nc, nt) >= SIMILAR_ENOUGH || (nt.length >= 2 && nc.includes(nt))) {
        return { reached: true, trail, moved };
      }
      const b = ocrFind(target, seen.ocrLines);
      if (!b) {
        trail.push(`"${target}" 글자가 화면에서 사라짐`);
        break;
      }
      const a = ocrFind(cur, seen.ocrLines);
      let dir;
      if (a) {
        const dx = b.x + b.w / 2 - (a.x + a.w / 2);
        const dy = b.y + b.h / 2 - (a.y + a.h / 2);
        dir = Math.abs(dy) >= Math.abs(dx) * 0.6 ? (dy > 0 ? "down" : "up") : dx > 0 ? "right" : "left";
      } else {
        // 커서가 있는 곳의 글자를 못 찾으면 위아래로만 가늠한다 (버튼은 보통 카드 아래에 있다)
        dir = b.y + b.h / 2 > 0.5 ? "down" : "up";
      }
      // 그 방향으로 가는 길에 있는 항목 수만큼 한 번에 누른다. 한 칸마다 다시 읽으면
      // 카드 네 장을 지나는 데만 LLM 을 다섯 번 부른다. 지나쳤으면 다음 읽기에서 되돌아온다.
      let n = 1;
      if (a) {
        const boxes = seen.options.map((o) => ocrFind(o, seen.ocrLines)).filter(Boolean);
        const mid = (e) => [e.x + e.w / 2, e.y + e.h / 2];
        const [ax, ay] = mid(a), [bx, by] = mid(b);
        const between = new Set(boxes.filter((e) => {
          if (e === a || e === b) return false;
          const [ex, ey] = mid(e);
          if (dir === "down") return ey > ay + 0.01 && ey < by - 0.01 && Math.abs(ex - ax) < 0.15;
          if (dir === "up") return ey < ay - 0.01 && ey > by + 0.01 && Math.abs(ex - ax) < 0.15;
          if (dir === "right") return ex > ax + 0.01 && ex < bx - 0.01 && Math.abs(ey - ay) < 0.05;
          return ex < ax - 0.01 && ex > bx + 0.01 && Math.abs(ey - ay) < 0.05;
        }));
        n = Math.min(MAX_MOVES, 1 + between.size);
      }
      const keys = Array(n).fill(navKey(dir));
      trail.push(`${cur}에서 ${keys.join(" ")}`);
      await tapSequence(keys);
      moved.push(...keys);
      await new Promise((r) => setTimeout(r, 400));
    }
    return { reached: false, trail, moved };
  }

  // 엔터를 누른 뒤 부른다. 확정 버튼이 필요 없으면 아무것도 안 한다.
  // before: 첫 엔터 직전 화면 — 이것과 거의 같아야 "아직 같은 화면" 이다 (다음 화면의 "확인" 을
  // 잘못 누르지 않게).
  async function confirmIfNeeded(state, chosen, keepGoing, before) {
    await new Promise((r) => setTimeout(r, 500)); // 고른 표시·버튼이 그려질 시간
    if (before && lastThumb && thumbDist(before, lastThumb) > MATCH_THRESHOLD) return { needed: false };
    const ocr = await ocrRead(gameRect);
    const btn = findConfirm(ocr?.lines, chosen);
    if (!btn) return { needed: false };
    el.vsLlmState.textContent = `"${btn.text}" 로 옮기는 중`;
    const nav = await moveToLabel(state, btn.text, keepGoing);
    const path = nav.trail.length ? nav.trail.join(" → ") : `이미 ${btn.text} 위`;
    if (!nav.reached) return { needed: true, pressed: false, button: btn.text, path, moved: nav.moved };
    await tapSequence(["enter"]);
    return { needed: true, pressed: true, button: btn.text, path, moved: [...nav.moved, "enter"] };
  }

  function confirmNote(conf) {
    if (!conf.needed) return "";
    return conf.pressed
      ? ` → 확정 "${conf.button}" [${conf.path} → 엔터]`
      : ` → 확정 "${conf.button}" 로 못 옮김 [${conf.path}]`;
  }

  // ---- 폰에서 온 지시 ----
  // 밖에서 폰으로 보다가 막혀 있으면 말로 시킨다: "중단해", "화면에 있는 초록 버튼 눌러".
  // LLM 이 지금 화면(그림 + 화면 글자)을 보고 할 일 하나를 고르고, 실제로 누르는 건 코드가 한다.
  // 버튼을 고르는 경우엔 메뉴와 같은 길 — 커서를 옮기고, 다시 읽어 확인하고, 그때만 엔터.
  // 누를 수 있는 키는 여전히 목록 안의 것뿐이다 (ESC 없음, 마우스 없음).
  let remoteBusy = false;
  let remoteCmdStatus = null; // { at, text, result, ok } — 폰에 보여준다
  // 폰에서 온 글자를 로그(innerHTML)에 넣기 전에 태그를 무력화한다
  const QUOTE = String.fromCharCode(34); // 큰따옴표 — 그대로 쓰면 정규식 안에서 헷갈린다
  const escHtml = (t) =>
    String(t)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .split(QUOTE)
      .join("&quot;");

  function remoteReport(text, result, ok) {
    remoteCmdStatus = {
      at: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
      text, result, ok,
    };
    logger.push(
      '<span class="tag">폰 지시</span> ' +
        (text ? '"' + escHtml(text) + '" → ' : "") +
        `<span class="${ok ? "good" : "bad"}">${escHtml(result)}</span>`
    );
  }

  function buildCommandPrompt(text, ocrLines) {
    return `This image is a screenshot of the game Vampire Survivors. A bot plays it.
The bot's owner is away from the PC and sent this instruction from their phone:

"${text}"

Right now the bot is ${running ? "RUNNING (moving the character by itself)" : "STOPPED"}.
The bot thinks this screen is: ${STATES[stableState] || stableState || "unknown"}.
${ocrBlock(optionLike(ocrLines))}
Choose exactly ONE action that carries out the instruction:
- "stop"   : stop the bot (it releases all keys and does nothing until started again)
- "start"  : start the bot again
- "select" : choose a button or menu entry that is visible on this screen. Put its label in
             "target", copied exactly as printed (use the OCR spelling when it matches).
             Words about colour or position ("the green button", "the one at the bottom")
             refer to what you see in the image.
- "key"    : press one key. Allowed keys only: enter, space, w, a, s, d, up, down, left, right.
             Put it in "key".
- "none"   : the instruction cannot be done with the actions above, or it is only a question.

${KOREAN_RULE}

Answer with ONLY a JSON object, nothing else:
{"action": "select", "target": "", "key": "", "why": "<무엇을 왜 하는지 한국어로 한 문장>"}`;
  }

  async function remoteSelect(text, target) {
    const state = stableState && stableState !== "play" ? stableState : "menu";
    const seen = await llmSee(state, el.vsModel.value);
    if (!seen) return remoteReport(text, "화면 항목을 읽지 못해 누르지 않았습니다", false);
    let tgt = indexOfOption(seen.options, target);
    if (tgt < 0) {
      // 띄어쓰기·대소문자·한두 글자 차이는 같은 것으로 본다
      let best = -1, bestS = 0;
      seen.options.forEach((o, i) => {
        const sc = similar(ocrNorm(o), ocrNorm(target));
        if (sc > bestS) { bestS = sc; best = i; }
      });
      if (bestS >= SIMILAR_ENOUGH) tgt = best;
    }
    if (tgt < 0) {
      return remoteReport(text, `"${target}" 를 화면 항목에서 못 찾았습니다 (보이는 것: ${seen.options.join(", ")})`, false);
    }
    const name = seen.options[tgt];
    const nav = await moveCursorTo(state, { ...seen, tgt }, () => remoteBusy);
    const path = nav.trail.length ? nav.trail.join(" → ") : `이미 ${name} 위`;
    if (!nav.reached) return remoteReport(text, `"${name}" 로 커서를 못 옮겨 엔터를 누르지 않았습니다 [${path}]`, false);
    await noteCharacter(name);
    const before = lastThumb;
    await tapSequence(["enter"]);
    const conf = await confirmIfNeeded(state, name, () => remoteBusy, before);
    remoteReport(text, `"${name}" 에서 엔터 [${path}]${confirmNote(conf)}`, !conf.needed || conf.pressed);
  }

  async function remoteSay(text) {
    if (remoteBusy) return remoteReport(text, "앞 지시를 처리하는 중이라 건너뜀", false);
    const model = el.vsModel.value;
    if (!model) return remoteReport(text, "LLM 모델이 골라져 있지 않아 지시를 못 합니다", false);
    if (!stream) return remoteReport(text, "화면 공유가 꺼져 있어 화면을 볼 수 없습니다", false);
    remoteBusy = true;
    if (heldKeys.length) { heldKeys = []; sendKeys([]); } // 움직이던 건 멈추고 본다
    try {
      el.vsLlmState.textContent = "폰 지시 읽는 중...";
      const crop = cropRegion(gameRect, 900);
      const ocr = await ocrRead(gameRect);
      const res = await askBridge(
        { type: "llm_ask", model, prompt: buildCommandPrompt(text, ocr?.lines), image: crop.b64, timeout: 40 },
        45000
      );
      if (res.error) return remoteReport(text, `LLM 실패: ${res.error}`, false);
      const o = parseJson(res.text) || {};
      const why = String(o.why || "").slice(0, 100);
      const action = String(o.action || "").toLowerCase();
      if (action === "stop") {
        stop();
        remoteReport(text, `정지했습니다 — ${why}`, true);
      } else if (action === "start") {
        await start();
        remoteReport(text, running ? `시작했습니다 — ${why}` : "시작하지 못했습니다 (PC 페이지 상태를 보세요)", running);
      } else if (action === "key") {
        const k = String(o.key || "").toLowerCase();
        if (!MENU_KEYS.includes(k)) return remoteReport(text, `허용되지 않은 키 "${k}" — 누르지 않았습니다`, false);
        await tapSequence([k]);
        remoteReport(text, `${k} 를 눌렀습니다 — ${why}`, true);
      } else if (action === "select") {
        await remoteSelect(text, String(o.target || ""));
      } else {
        remoteReport(text, `할 수 있는 일이 없다고 봤습니다 — ${why || "(이유 없음)"}`, false);
      }
    } finally {
      remoteBusy = false;
    }
  }

  async function runRemoteCommand(c) {
    if (c.kind === "stop") {
      stop();
      remoteReport("", "폰에서 정지했습니다 (브릿지도 키를 막는 중)", true);
    } else if (c.kind === "start") {
      await start();
      remoteReport("", running ? "폰에서 시작했습니다" : "폰에서 시작을 눌렀지만 시작하지 못했습니다", running);
    } else if (c.kind === "say") {
      await remoteSay(c.text);
    }
  }

  // ---- 레벨업: LLM에게 맡기는 자리 ----
  // 게임이 멈춰 있어서 몇 초 걸려도 되고, 아이템 조합은 학습으로 배우려면 수백 판이 필요한데
  // LLM은 그냥 알고 있다. 반사 루프(초파리 뇌)는 건드리지 않는다.
  let llmBusy = false;
  let pickedThisRun = load("pickedThisRun", []);

  // 분석용 캔버스(480x270)는 글씨를 읽기엔 너무 작다. 필요한 영역만 원본 해상도로 다시 잘라낸다.
  // 무엇을 얼마만 한 크기로 잘라 보냈는지 같이 돌려준다.
  // 글을 못 읽을 때 "이미지가 작아서인가"를 따지려면 이 숫자가 있어야 한다.
  function cropRegion(rect, maxSide) {
    const r = rect || { x: 0, y: 0, w: 1, h: 1 };
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return null;
    const sw = Math.max(1, Math.round(r.w * vw));
    const sh = Math.max(1, Math.round(r.h * vh));
    const scale = Math.min(1, maxSide / Math.max(sw, sh)); // 비율은 유지한 채 줄인다
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    c.getContext("2d").drawImage(video, r.x * vw, r.y * vh, sw, sh, 0, 0, c.width, c.height);
    return {
      b64: c.toDataURL("image/jpeg", 0.9).split(",")[1],
      w: c.width,
      h: c.height,
      srcW: sw,
      srcH: sh,
      scaled: scale < 1,
    };
  }

  function cropCards() {
    return cropRegion(cardRect || gameRect, LEVELUP_MAX_SIDE)?.b64 || null;
  }

  // ---- 지시 · 한국어 응답 ----
  // 사용자가 적어둔 목표. 멈춘 화면에서 무엇을 기준으로 고를지의 근거가 된다.
  const DEFAULT_GOAL = "게임을 시작해서 최대한 오래 살아남아라. 죽으면 바로 다시 시작해라.";

  function goalText() {
    return (el.vsGoal.value || "").trim() || DEFAULT_GOAL;
  }

  // 모델이 영어로 답하면 사용자가 로그를 읽을 수 없다. 기계가 읽는 값(screen, target, keys)은
  // 영어 그대로 두고, 사람이 읽는 설명만 한국어로 받는다.
  const KOREAN_RULE =
    'Write the "why" field in KOREAN (한국어). ' +
    "Keep the other fields exactly as specified in English.";

  // ---- 사용자가 이름 붙인 영역 ----
  // 좌표는 분석 화면(= 공유된 화면 전체) 기준 0~1. screen 이 비어 있으면 모든 화면에서 쓴다.
  let regions = load("regions", []);
  let pendingRegion = null;

  // LLM 에게 보낼 이미지(base 로 잘라낸 부분) 기준으로 좌표를 바꿔서 알려준다.
  // state 가 주어지면 그 화면에 해당하는 영역만, all 이면 전부(어느 화면인지 함께).
  function regionBlock(state, base, all) {
    const b = base || { x: 0, y: 0, w: 1, h: 1 };
    const rows = [];
    for (const r of regions) {
      if (!all && r.screen && r.screen !== state) continue;
      const x0 = (r.x - b.x) / b.w, y0 = (r.y - b.y) / b.h;
      const x1 = (r.x + r.w - b.x) / b.w, y1 = (r.y + r.h - b.y) / b.h;
      if (x1 <= 0 || y1 <= 0 || x0 >= 1 || y0 >= 1) continue; // 보내는 이미지 밖
      const c = (v) => Math.max(0, Math.min(1, v)).toFixed(2);
      const where = all && r.screen ? ` (only on the ${r.screen} screen)` : "";
      rows.push(`- "${r.label}"${where}: x ${c(x0)}~${c(x1)}, y ${c(y0)}~${c(y1)}`);
    }
    if (!rows.length) return "";
    return (
      "\nThe player has marked and named these regions of the image. Positions are fractions of\n" +
      "the image width and height (0 = left/top, 1 = right/bottom). Use them to understand the screen:\n" +
      rows.join("\n") +
      "\n"
    );
  }

  function regionsNow(state) {
    return regions.filter((r) => !r.screen || r.screen === state);
  }

  function renderRegions() {
    if (!regions.length) {
      el.vsRegionList.textContent = "아직 이름 붙인 영역이 없습니다";
      return;
    }
    el.vsRegionList.innerHTML = regions
      .map(
        (r, i) =>
          `<div class="vs-region-row"><b style="color:#ffb35c">${r.label}</b> ` +
          `<span class="dim">${r.screen ? STATES[r.screen] || r.screen : "모든 화면"} · ` +
          `x ${(r.x * 100).toFixed(0)}~${((r.x + r.w) * 100).toFixed(0)}% · ` +
          `y ${(r.y * 100).toFixed(0)}~${((r.y + r.h) * 100).toFixed(0)}%</span>` +
          (r.why ? ` <span class="dim">— ${r.why}</span>` : "") +
          ` <button class="vs-mini" data-del-region="${i}">지우기</button></div>`
      )
      .join("");
  }

  function openRegionForm(rect) {
    pendingRegion = rect;
    el.vsRegionForm.hidden = false;
    el.vsRegionLabel.value = "";
    el.vsRegionState.textContent = "-";
    // 어느 화면에서 보이는지: 지금 알아본 화면이 있으면 그것, 아니면 모든 화면
    el.vsRegionScope.innerHTML =
      '<option value="">모든 화면</option>' +
      Object.entries(STATES).map(([k, ko]) => `<option value="${k}">${ko}</option>`).join("");
    el.vsRegionScope.value = stableState && STATES[stableState] && stableState !== "play" ? stableState : "";
    el.vsRegionLabel.focus();
    // 메뉴가 다른 데 가 있으면 폼이 안 보이므로 화면 설정으로 옮긴다
    showSection("screen");
    el.vsRegionForm.scrollIntoView({ block: "center" });
  }

  function closeRegionForm() {
    pendingRegion = null;
    el.vsRegionForm.hidden = true;
  }

  async function askRegion() {
    if (!pendingRegion) return;
    if (!el.vsModel.value) { el.vsRegionState.textContent = "LLM 메뉴에서 모델을 먼저 고르세요"; return; }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) { el.vsRegionState.textContent = "브릿지에 연결하지 못했습니다"; return; }
    }
    const crop = cropRegion(pendingRegion, 640);
    if (!crop) { el.vsRegionState.textContent = "화면 공유를 먼저 켜주세요"; return; }
    el.vsRegionState.textContent = "묻는 중...";
    const prompt = `This image is ONE PART of a Vampire Survivors screen, cut out by the player.
What is this part? For example: experience bar, health bar, timer, gold counter, kill counter,
level-up card list, reroll/skip/banish buttons, character list, character stats panel,
start button, stage list, results table, treasure chest, the player character, the battlefield.

Answer in KOREAN.

Answer with ONLY a JSON object, nothing else:
{"label": "<짧은 이름, 2~10자>", "why": "<무엇이 보이는지 한 문장>"}`;
    const res = await askBridge(
      { type: "llm_ask", model: el.vsModel.value, prompt, image: crop.b64, timeout: 40 },
      45000
    );
    const o = res.error ? null : parseJson(res.text);
    if (!o || !o.label) {
      el.vsRegionState.textContent = `실패: ${res.error || "답을 해석 못 함"}`;
      return;
    }
    el.vsRegionLabel.value = String(o.label).slice(0, 20);
    el.vsRegionLabel.dataset.why = String(o.why || "").slice(0, 60);
    el.vsRegionState.textContent = `${o.why || ""} (${(res.took || 0).toFixed(1)}초) — 맞으면 저장`;
  }

  function saveRegion() {
    const label = (el.vsRegionLabel.value || "").trim().slice(0, 20);
    if (!pendingRegion || !label) { el.vsRegionState.textContent = "이름을 적어주세요"; return; }
    regions.push({
      ...pendingRegion,
      label,
      screen: el.vsRegionScope.value || "",
      why: el.vsRegionLabel.dataset.why || "",
    });
    el.vsRegionLabel.dataset.why = "";
    save("regions", regions);
    renderRegions();
    logger.push(
      `<span class="tag">영역</span> <span class="pick">${label}</span> ` +
        `<span class="dim">— ${el.vsRegionScope.value ? STATES[el.vsRegionScope.value] : "모든 화면"}에서 LLM 이 이 위치를 알고 판단합니다</span>`
    );
    closeRegionForm();
  }

  // ---- 지금 보고 있는 화면에 붙은 메모 ----
  // 예전에는 메모를 하나의 전역 목록으로 들고 다녔다. 그러면 관계없는 화면을 볼 때도
  // 전부 따라 들어가서, 메모가 쌓일수록 모든 판단이 그 말들에 끌려간다.
  // 메모는 그 화면을 보고 있을 때만 쓴다.
  let lastMatch = null; // 이번 프레임이 어느 기억과 맞았는지

  function noteBlock() {
    const note = lastMatch?.note;
    if (!note) return "";
    return (
      "\nWhat the player told you about THIS screen (Korean). Trust it over your own guess:\n" +
      `- ${note}\n`
    );
  }

  function renderHints() {
    const rows = [];
    for (const [name, samples] of Object.entries(taught)) {
      for (const s of samples) {
        if (s.note) rows.push(`<b>${STATES[name] || name}</b> — ${s.note}`);
      }
    }
    if (!rows.length) {
      el.vsHints.textContent =
        "아직 알려준 것이 없습니다. 메모는 그때 보이던 화면에 붙고, 그 화면일 때만 쓰입니다.";
      return;
    }
    el.vsHints.innerHTML =
      `화면에 붙은 메모 ${rows.length}개 — 그 화면이 뜰 때만 쓰입니다<br />` + rows.join("<br />");
  }

  // 사용자가 만든 종류는 모델이 알 리 없다. 이름과, 그 화면에 붙여둔 메모를 같이 알려준다.
  function customStateBlock() {
    const rows = Object.entries(customStates).map(([k, ko]) => {
      const note = (taught[k] || []).map((x) => x.note).filter(Boolean)[0];
      return k + " - " + ko + (note ? ": " + note : "");
    });
    return rows.length ? rows.join("\n") + "\n" : "";
  }

  // ---- 지금 무슨 화면인가: LLM에게 묻고, 한 번 물으면 기억한다 ----
  // 매 프레임 물을 수는 없다(한 번에 몇 초씩 걸린다). 대신 레벨업·메뉴·사망은 전부
  // 화면이 멈춘다는 점을 쓴다. "멈췄는데 처음 보는 화면"일 때만 한 번 묻고,
  // 답을 받으면 그 썸네일을 기억하니 같은 화면을 두 번 묻지 않는다.
  const idPrompt = (ocrLines) => `This image is a screenshot of the game Vampire Survivors.
Which screen is it? Choose exactly one:

play    - normal gameplay: the character is on the battlefield with monsters, nothing is paused
levelup - a level-up / upgrade screen: a vertical list of option cards to choose from
menu    - title screen, character select, stage select, pause menu or settings
dead    - the run is truly OVER and it is showing the outcome: a results table, score
          summary, time survived, enemies killed, or gold earned
chest   - a treasure chest is opening and showing what was won
revive  - the SAME run can still be saved: the game offers to resurrect the character and
          carry on where they fell, usually with a countdown and a Revive / Continue button
${customStateBlock()}
Tell dead and revive apart by what is on offer, not by the words "you died":
- Revive / Continue / resurrect, keeping the same run going  -> revive
- Retry / Restart / Main Menu / Play Again, which would start a NEW run  -> dead
- A results table with time, kills or gold, and no way to resume  -> dead
${ocrBlock(optionLike(ocrLines))}${regionBlock(null, gameRect, true)}${noteBlock()}
${KOREAN_RULE}

Answer with ONLY a JSON object, nothing else:
{"screen": "<one of the keys listed above>", "why": "<무엇이 보이는지 한국어로 한 문장>"}`;

  const FREEZE_MOTION = 0.6; // 이보다 움직임이 적으면 멈춘 것으로 본다
  const FREEZE_HOLD = 500;   // 그 상태가 이만큼 이어져야 진짜 멈춤
  const ID_COOLDOWN = 8000;  // 실패했을 때 다시 묻기까지
  let frozenSince = 0;
  let lastIdAt = 0;
  let idBusy = false;

  // 모델이 VRAM에 없으면 첫 호출이 수십 초 걸린다. 레벨업 화면은 멈춰 있으니 견딜 만하지만,
  // 플레이 중에 잘못 물으면 그동안 몰리가 가만히 서 있다가 죽는다. 켜는 순간에 미리 올려둔다.
  let warming = false;

  async function warmModel() {
    const model = el.vsModel.value;
    if (!model || warming) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    warming = true;
    el.vsIdState.textContent = "모델 올리는 중...";
    const t0 = performance.now();
    const res = await askBridge({ type: "llm_ask", model, prompt: "ok", timeout: 120 }, 125000);
    warming = false;
    const sec = (performance.now() - t0) / 1000;
    if (res.error) {
      el.vsIdState.textContent = "예열 실패";
      logger.push(`<span class="bad">모델 예열 실패: ${res.error}</span>`);
    } else {
      el.vsIdState.textContent = "준비됨";
      logger.push(`<span class="good">${model} 준비됨 (${sec.toFixed(1)}초) — 이제 판별은 몇 초면 끝납니다</span>`);
    }
  }

  async function identifyScreen() {
    const model = el.vsModel.value;
    if (!model) return { error: "모델이 선택되지 않음" };
    const crop = cropRegion(gameRect, 640);
    if (!crop) return { error: "화면을 잘라내지 못함" };
    const image = crop.b64;

    const res = await askBridge(
      { type: "llm_ask", model, prompt: idPrompt(freshOcrLines()), image, timeout: 40 },
      45000
    );
    if (res.error) return { error: res.error };
    const o = parseJson(res.text);
    if (!o) return { error: "응답을 해석 못 함" };
    const st = String(o.screen || "").trim().toLowerCase();
    if (!STATES[st]) return { error: `모르는 답: ${st || "(빈 값)"}` };
    return { state: st, why: String(o.why || "").slice(0, 80), took: res.took };
  }

  // 방금 읽은 화면 글자 (4초 안, 사진 시험 제외)
  const freshOcrLines = () =>
    lastOcr && !lastOcr.test && performance.now() - lastOcr.at < 4000 ? lastOcr.lines : null;

  const OCR_EVERY = 1500;     // 글자로 판별은 이만큼마다
  const OCR_STILL_MS = 1000;  // "플레이 중" 이라도 카메라가 이만큼 멈춰 있으면 글자를 본다
  let lastOcrIdAt = 0;

  // frozen: 게임이 멈췄나 (바깥 전장 기준, 이미 FREEZE_HOLD 만큼 이어진 것)
  async function maybeIdentify(cls, frozen, now) {
    if (idBusy || llmBusy || sending || warming || remoteBusy) return;
    if (!cls.guessed) return; // 이미 아는 화면이면 물을 이유가 없다

    // 1) 글자로 — 빠르다. 멈춘 화면이거나, "플레이 중" 이라도 카메라가 1초 넘게 멈춰 있으면 본다.
    //    타이틀 화면은 가운데에 큰 파란 판이 없어서 플레이 중으로 보일 수 있다. 그러면 몰리가
    //    시작 버튼 앞에서 WASD 만 누르고 있게 된다 — 그걸 여기서 잡는다.
    if (
      el.vsOcrOn.checked && ws && ws.readyState === WebSocket.OPEN &&
      (frozen || now - lastCamMoveAt >= OCR_STILL_MS) && now - lastOcrIdAt >= OCR_EVERY
    ) {
      lastOcrIdAt = now;
      idBusy = true;
      const snap = lastThumb;
      const o = await ocrRead(gameRect);
      idBusy = false;
      if (o?.match) {
        if (!snap || !lastThumb || thumbDist(snap, lastThumb) > MATCH_THRESHOLD) return; // 읽는 사이 바뀜
        teach(o.match.state, snap);
        el.vsIdState.textContent = `${STATES[o.match.state]} (글자)`;
        logger.push(
          `<span class="tag">글자로 판별</span> <span class="pick">${STATES[o.match.state]}</span> ` +
            `<span class="dim">화면에 "${o.match.text}" — 이제 이 화면은 바로 압니다</span>`
        );
        return;
      }
    }

    // 2) LLM — 느리다. 멈춘 화면에서만 묻는다. 예전에는 화면 전체 변화량으로 봐서, 레벨업 창의
    //    반짝임만으로도 "움직인다" 가 되어 여기서 막혔다.
    if (!el.vsIdOn.checked) return;
    if (!frozen) return;
    if (now - lastIdAt < ID_COOLDOWN) return;

    lastIdAt = now;
    idBusy = true;
    el.vsIdState.textContent = "화면 확인 중...";
    const snap = lastThumb; // 물어본 그 순간의 화면. 답이 와도 기준은 이것이다
    const r = await identifyScreen();
    idBusy = false;

    if (r.error) {
      el.vsIdState.textContent = `실패: ${r.error}`;
      logger.push(`<span class="bad">화면 판별 실패: ${r.error}</span>`);
      return;
    }
    // 묻는 몇 초 사이에 화면이 넘어갔으면 그 답을 지금 화면에 붙이면 안 된다
    if (!snap || !lastThumb || thumbDist(snap, lastThumb) > MATCH_THRESHOLD) {
      el.vsIdState.textContent = "묻는 사이 화면이 바뀜 — 버림";
      return;
    }
    el.vsIdState.textContent = `${STATES[r.state]} (${(r.took || 0).toFixed(1)}초)`;
    teach(r.state, snap);
    logger.push(
      `<span class="tag">화면 판별</span> <span class="pick">${STATES[r.state]}</span> ` +
        `<span class="dim">${r.why} — 이제 이 화면은 묻지 않고 바로 압니다</span>`
    );
  }

  // ---- 멈춘 화면: 무슨 키를 누를지 LLM이 정한다 ----
  // 아무 키나 눌러보게 두면 안 된다. 예전에 그렇게 했다가 ESC를 눌러 게임이 꺼진 적이 있다.
  // 고를 수 있는 키를 아래 목록으로 묶고, 모델이 뭐라고 답하든 목록 밖은 전부 버린다.
  // 애초에 모델은 키를 고르지 않는다 — 항목 이름만 말하고 키는 코드가 만든다.
  // 레벨업 카드는 글씨를 읽어야 해서 다른 화면보다 크게 잘라 보낸다.
  const LEVELUP_MAX_SIDE = 1280;

  // ---- 레벨업에서 무엇을 읽었는지 ----
  // 잘못 읽는 걸 고치려면 무엇을 읽었는지가 남아야 한다. 판을 넘겨도 볼 수 있게 저장한다.
  let readLog = load("readLog", []);
  const MAX_READ_LOG = 12;

  function pushRead(rec) {
    rec.run = runNo();
    rec.runSec = run.active ? Math.round((performance.now() - run.startedAt) / 1000) : null;
    readLog.push(rec);
    while (readLog.length > MAX_READ_LOG) readLog.shift();
    save("readLog", readLog);
    renderReadLog();
  }

  function renderReadLog() {
    if (!readLog.length) {
      el.vsReadLog.textContent =
        "아직 레벨업 화면을 읽은 적이 없습니다. 읽은 카드 이름이 실제와 다르면 여기서 바로 보입니다.";
      return;
    }
    el.vsReadLog.innerHTML = readLog
      .slice()
      .reverse()
      .map((r) => {
        // 카드마다 이름과 설명을 같이 보여준다. 실제 카드와 다르게 읽었으면 여기서 드러난다.
        const opts = (r.options || [])
          .map((o, i) => {
            const d = r.descs?.[i];
            const body = d ? `${o} <span class="dim">(${d})</span>` : o;
            return o === r.picked ? `<b class="good">${body}</b>` : body;
          })
          .join(" / ");
        const sel = r.selected ? ` · 선택돼 있던 것: ${r.selected}` : "";
        const keys = r.nav ? ` · 옮긴 길: ${r.nav}` : r.keys?.length ? ` · 누름: ${r.keys.join(" ")}` : "";
        const btn = r.buttons?.length ? ` · 버튼: ${r.buttons.join(", ")}` : "";
        // 두 번 읽어 달랐으면 둘 다 보여준다. 지어낸 것인지 한눈에 드러난다.
        const second =
          r.options2 && r.options2.join("|") !== (r.options || []).join("|")
            ? `<br /><span class="bad">　2차 판독: ${r.options2.join(" / ") || "(없음)"}</span>`
            : "";
        const when =
          r.runSec === null || r.runSec === undefined
            ? ""
            : ` <span class="dim">${Math.floor(r.runSec / 60)}:${String(r.runSec % 60).padStart(2, "0")}</span>`;
        const ocr = r.ocr?.length
          ? `<br /><span class="dim">　화면 글자(OCR): ${r.ocr.join(" / ")}${r.byOcr ? " — 카드 이름 전부 확인됨" : ""}</span>`
          : "";
        const fixTxt = r.fixes?.length
          ? '<br /><span class="dim">　이름 고침: ' +
            r.fixes.map((f) => f.from + " → <b>" + f.to + "</b> (" + f.by + ")").join(", ") + "</span>"
          : "";
        const guideTxt = r.guide?.length
          ? `<br /><span class="dim">　공략: ${r.guide.map((g) => g.replace(/^- /, "")).join(" / ")}</span>`
          : "";
        return (
          `<div><span class="dim">${r.at}</span> ` +
          (r.test ? '<span class="pick">사진</span> ' : `<span class="tag">${r.run || "?"}판</span>${when} `) +
          `<span class="dim">[${r.imgW}x${r.imgH}${r.test ? "" : r.tight ? " 카드영역" : " 화면전체"}]</span> ` +
          `카드 ${(r.options || []).length}장: ${opts}${sel}${keys}${btn}` +
          second +
          ocr +
          fixTxt +
          guideTxt +
          (r.why ? `<br /><span class="dim">　${r.why}</span>` : "") +
          "</div>"
        );
      })
      .join("");
  }

  const MENU_KEYS = ["enter", "space", "up", "down", "left", "right", "w", "a", "s", "d"];
  // 한 번에 누를 수 있는 이동 키 수. 캐릭터 선택 격자에서는 대각선 끝까지 갈 수 있어야 한다.
  const MAX_MOVES = 8;
  // 옮기고 다시 읽기를 몇 번까지 할지. 한 번 읽는 데 몇 초 걸린다.
  const MENU_ROUNDS = 3;

  // 메뉴 이동 키. 게임 안 이동에 쓰는 WASD 는 잘 먹는 게 확인됐다.
  // 방향키는 확장 키라 NumLock 이 켜져 있으면 브릿지가 0xE0 을 한 번 더 보내는
  // 불안정한 경로를 탄다. 그래서 기본은 WASD, 안 먹는 게임이면 방향키로 바꾼다.
  const NAV = {
    wasd: { up: "w", down: "s", left: "a", right: "d" },
    arrows: { up: "up", down: "down", left: "left", right: "right" },
  };
  const navKey = (dir) => (NAV[el.vsNavKeys?.value] || NAV.wasd)[dir];

  // from -> to 로 가는 키. 목록이면 한 방향, 격자면 위아래와 좌우를 따로 센다.
  function moveKeys(from, to, layout, columns) {
    const keys = [];
    if (layout === "grid" && columns > 1) {
      const dr = Math.floor(to / columns) - Math.floor(from / columns);
      const dc = (to % columns) - (from % columns);
      for (let k = 0; k < Math.abs(dr); k++) keys.push(navKey(dr > 0 ? "down" : "up"));
      for (let k = 0; k < Math.abs(dc); k++) keys.push(navKey(dc > 0 ? "right" : "left"));
    } else {
      const d = to - from;
      const dir = layout === "horizontal" ? (d > 0 ? "right" : "left") : d > 0 ? "down" : "up";
      for (let k = 0; k < Math.abs(d); k++) keys.push(navKey(dir));
    }
    return keys.slice(0, MAX_MOVES);
  }

  // ---- 1단계: 그림을 보고 화면을 읽는다 (판단은 시키지 않는다) ----
  function buildSeePrompt(state, ocrLines) {
    const KIND = {
      levelup: "level-up (pick an upgrade card, then press a confirm button such as 획득하기)",
      dead: "results / game-over",
      chest: "treasure chest reward",
      revive: "revive / continue offer",
    };
    return `This image is a screenshot of Vampire Survivors.
Gameplay is paused on a ${KIND[state] || "title or menu"} screen.
If there is nothing to choose — the screen is just showing a reward and waiting for any
key — then report the single button or prompt that dismisses it as the only option.

Report ONLY what you can see. Do not decide anything, do not choose anything.

1. "options" - every selectable option on this screen, as printed, in reading order
   (left to right, then top to bottom). For characters without a printed name, describe
   each briefly so they can be told apart.
2. "layout" - "vertical" if the options are in one column, "horizontal" if in one row,
   "grid" if they are laid out in several rows AND several columns (like a character
   select screen).
3. "columns" - for a grid, how many options are in each row. Otherwise 1.
4. "selected" - the option the cursor is ON RIGHT NOW, copied word for word from your own
   options list. Exactly one option looks different: brighter fill, thicker or lighter
   border, larger text, an animated or raised portrait, or an arrow/cursor next to it.
   Look carefully — this decides how many steps the cursor has to move.
${ocrBlock(optionLike(ocrLines), "Use these to spell option labels exactly and so you do not miss a button such as START / 시작. Not every line is an option — titles, names in an info panel, numbers and descriptions are not.")}
${regionBlock(state, gameRect)}${noteBlock()}
${KOREAN_RULE.replace('"why"', '"sees"')}

Answer with ONLY a JSON object, nothing else:
{"options": ["<label of option 1>", "<label of option 2>"], "layout": "vertical", "columns": 1, "selected": "<label of the highlighted one>", "sees": "<화면에 무엇이 보이는지 한국어로 한 문장>"}`;
  }

  // ---- 2단계: 글자만 보고 무엇을 고를지 정한다 (그림을 같이 주지 않는다) ----
  // 그림과 함께 물으면 화면에 끌려가서 엉뚱한 항목을 고른다. 목록만 주면 잘 고른다.
  function buildTargetPrompt(options, state, selected, tries = []) {
    const KIND = {
      dead: "results / game-over",
      chest: "treasure chest reward",
      revive: "revive / continue offer",
    };
    const past = history
      .slice(-5)
      .map((r) => `- ${Math.floor(r.sec / 60)}분 ${Math.round(r.sec % 60)}초 생존`)
      .join("\n") || "(기록 없음)";
    const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    const counts = {};
    for (const t of tries) counts[t.target] = (counts[t.target] || 0) + 1;
    const tried = Object.entries(counts)
      .map(([name, n]) => '- moved to "' + name + '" and pressed Enter' + (n > 1 ? " (" + n + " times)" : ""))
      .join("\n");
    const triedBlock = tried
      ? "\nAlready tried on this screen, and the screen did NOT move on:\n" + tried + "\nDo not choose those again.\n"
      : "";
    // 목표가 캐릭터·무기·맵을 말할 때만 붙인다. "그냥 시작해서 오래 버티기" 면 필요 없는 정보다.
    const facts = goalWantsRoster(goalText()) ? rosterFor(options) : [];
    const rosterBlock = facts.length
      ? "\nFacts about these options from a game guide (use them if the instruction mentions a weapon," +
        " a character or a stage):\n" + facts.join("\n") + "\n"
      : "";

    return `You are operating a menu in the game Vampire Survivors.
This is the ${KIND[state] || "title or menu"} screen.

These are the options on screen right now, in order:
${list}
${rosterBlock}
The player's instruction:
${goalText()}

Recent runs:
${past}

The cursor is on "${selected}" right now. Pressing Enter activates that option.

How menus work in this game:
- Pressing Enter on a character or a stage chooses it and moves on. You do NOT have to move
  the cursor to a separate Confirm / Start / OK button first — those come after Enter.
- Move the cursor only when the instruction asks for a DIFFERENT option than the selected
  one. If the instruction does not name a specific character, stage or option, keep the
  selected one: answer "${selected}".
${triedBlock}
Which single option carries out that instruction? Copy it exactly from the list above.
If none of them do, answer "".
Never choose quit, exit, or give up.
${noteBlock()}
${KOREAN_RULE}

Answer with ONLY a JSON object, nothing else:
{"target": "<option, copied exactly>", "why": "<왜 그 항목인지 한국어로 한 문장>"}`;
  }

  function parseJson(text) {
    const m = (text || "").match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e) {
      return null;
    }
  }

  // 모델이 준 이름을 목록에서 찾아 번호로 바꾼다. 번호로 직접 물으면 지금 선택된 번호를
  // 그대로 복사하는 실패가 잦아서, 이름으로 받고 번호는 여기서 찾는다.
  function indexOfOption(options, value) {
    const v = String(value ?? "").trim().toLowerCase();
    if (!v) return -1;
    // 굳이 번호로 답했다면 그것도 받아준다
    const n = parseInt(v, 10);
    if (String(n) === v) return n >= 1 && n <= options.length ? n - 1 : -1;

    const norm = options.map((o) => o.trim().toLowerCase());
    let i = norm.indexOf(v);
    if (i >= 0) return i;
    // "MAIN MENU" 를 "main menu button" 처럼 덧붙여 답하는 경우
    return norm.findIndex((o) => o && (o.includes(v) || v.includes(o)));
  }

  // ---- 지금 화면을 읽는다 (처음 한 번, 그리고 커서를 옮긴 뒤 확인할 때) ----
  async function llmSee(state, model) {
    const crop = cropRegion(gameRect, 900);
    if (!crop) return null;
    const ocr = await ocrRead(gameRect); // 시작 버튼 같은 글자를 빠뜨리지 않게
    const res = await askBridge(
      { type: "llm_ask", model, prompt: buildSeePrompt(state, ocr?.lines), image: crop.b64, timeout: 40 },
      45000
    );
    if (res.error) {
      logger.push(`<span class="bad">LLM 실패: ${res.error} — 누르지 않고 기다립니다</span>`);
      return null;
    }
    const seen = parseJson(res.text);
    const options = (Array.isArray(seen?.options) ? seen.options : [])
      .map((x) => String(x || "").trim().slice(0, 24))
      .filter(Boolean);
    if (!options.length) {
      logger.push('<span class="bad">화면에서 고를 항목을 못 읽었습니다 — 누르지 않고 기다립니다</span>');
      return null;
    }
    const sel = indexOfOption(options, seen.selected);
    if (sel < 0) {
      logger.push('<span class="bad">지금 뭐가 선택돼 있는지 못 읽었습니다 — 누르지 않고 기다립니다</span>');
      return null;
    }
    return {
      options,
      sel,
      layout: String(seen.layout || "").toLowerCase(),
      columns: Math.max(1, parseInt(seen.columns, 10) || 1),
      sees: seen.sees,
      took: res.took || 0,
      ocrLines: ocr?.lines || [],
    };
  }

  // ---- 같은 화면에서 같은 실수를 되풀이하지 않게 ----
  // 무엇으로 가서 엔터를 눌렀는지 남긴다. 같은 화면(읽은 항목이 거의 같은)에서 또 묻게 됐다면
  // 앞서 누른 것으로는 넘어가지 못했다는 뜻이다.
  let menuTries = []; // { state, options, target, at }
  let menuStuckUntil = 0;
  const TRY_MEMORY = 300000; // 플레이로 넘어가면 바로 지운다 (다른 판의 같은 화면은 새로 본다)
  let stuckLogged = false;
  const TRY_LIMIT = 2; // 같은 곳으로 이만큼 가봤으면 그건 답이 아니다
  const STUCK_WAIT = 20000;

  function sameOptions(a, b) {
    const hit = a.filter((x) => b.some((y) => similar(x, y) >= SIMILAR_ENOUGH)).length;
    return hit >= Math.max(1, Math.min(a.length, b.length) * 0.6);
  }

  function triesHere(state, options) {
    const now = performance.now();
    menuTries = menuTries.filter((t) => now - t.at < TRY_MEMORY);
    return menuTries.filter((t) => t.state === state && sameOptions(t.options, options));
  }

  const timesTried = (tries, name) => tries.filter((t) => similar(t.target, name) >= SIMILAR_ENOUGH).length;

  // 무엇을 고를지까지 정한다. 키는 여기서 만들지 않는다 — 옮기면서 확인해야 하기 때문이다.
  async function llmPlanMenu(state) {
    const model = el.vsModel.value;
    if (!model) return null;

    // --- 1단계: 화면 읽기 ---
    el.vsLlmState.textContent = "화면 읽는 중...";
    const seen = await llmSee(state, model);
    if (!seen) return null;
    const tries = triesHere(state, seen.options);

    // --- 2단계: 무엇을 고를지 (그림 없이) ---
    el.vsLlmState.textContent = "고르는 중...";
    const pickRes = await askBridge(
      {
        type: "llm_ask", model, timeout: 40,
        prompt: buildTargetPrompt(seen.options, state, seen.options[seen.sel], tries),
      },
      45000
    );
    if (pickRes.error) {
      logger.push(`<span class="bad">LLM 실패: ${pickRes.error} — 누르지 않고 기다립니다</span>`);
      return null;
    }
    const picked = parseJson(pickRes.text);
    const plan = {
      ...seen,
      tgt: -1,
      why: String(picked?.why || "").slice(0, 80),
      took: seen.took + (pickRes.took || 0),
      note: "",
    };

    // 빈 답 = 이 화면에서는 아직 누를 게 없다는 뜻
    if (!String(picked?.target ?? "").trim()) return plan;
    plan.tgt = indexOfOption(seen.options, picked.target);
    if (plan.tgt < 0) {
      logger.push(
        `<span class="bad">LLM이 말한 "${picked.target}"를 목록에서 못 찾았습니다 — 누르지 않고 기다립니다</span>`
      );
      return null;
    }

    // 이미 두 번 가봤는데도 이 화면이면, 모델이 뭐라 하든 그건 답이 아니다.
    // 지금 선택된 것에서 엔터만 눌러본다. 그것도 해봤으면 멈추고 사람에게 알린다.
    const want = seen.options[plan.tgt];
    const cur = seen.options[seen.sel];
    if (timesTried(tries, want) >= TRY_LIMIT) {
      if (plan.tgt !== seen.sel && timesTried(tries, cur) < TRY_LIMIT) {
        plan.note = `"${want}" 로 ${timesTried(tries, want)}번 가봤지만 넘어가지 않아서, 지금 선택된 "${cur}" 에서 엔터만 누릅니다`;
        plan.tgt = seen.sel;
      } else {
        plan.stuck = [...new Set(tries.map((t) => t.target))];
      }
    }
    return plan;
  }

  async function tapSequence(keys) {
    sending = true;
    for (const k of keys) {
      sendTap(k);
      await new Promise((r) => setTimeout(r, 260));
    }
    sending = false;
  }

  // ---- 레벨업 1단계: 그림을 보고 무엇이 있는지만 읽는다 ----
  // 예전에는 "몇 번째 카드를 고를래?"를 한 번에 물었다. 그랬더니 why 에는 옳은 이름을
  // 써놓고 번호는 엉뚱한 걸 내는 일이 생겼고(= 추론과 다른 아이템 선택),
  // 카드만 세고 있어서 새로고침·건너뛰기·지우기 버튼은 셈에 들어가지도 않았다.
  function buildSeeLevelPrompt(nCards, ocrLines) {
    return `This image is a LEVEL-UP screen from the game Vampire Survivors.

Report ONLY what you can see. Do not decide anything, do not choose anything.

Read the UPGRADE CARDS only. Each card is a row with an icon on the left, a weapon or
item name in larger text, and a description line underneath.

1. "options" - the name printed on each upgrade card, from top to bottom.
   Copy the characters exactly as printed, including spacing and capitalisation.
   The game may be running in Korean — if a name is written in Hangul (한글), copy the
   Hangul exactly, character by character. Never translate it, never romanise it.
   Do NOT include Reroll, Skip, Banish, or any other button — those are not cards.
   Do NOT include the description lines.

   If you cannot actually read a card's text, write "?" for that card.
   Never replace unreadable text with the name of an item you happen to know —
   a wrong name is far worse than "?", because the program will act on it.
2. "descs" - the description line under each card, in the same order, so the list lines up
   with "options". Use an empty string when a card has no description you can read.
3. "selected" - the card that is ALREADY highlighted, copied word for word from your own
   options list. Exactly one looks different: brighter fill, thicker or lighter border,
   larger text, or an arrow/cursor next to it.
4. "buttons" - separately, the labels of any side buttons you can see, such as
   Reroll, Skip or Banish. These are NOT cards and must not appear in "options".

There are usually about ${nCards} upgrade cards, but trust the image over that number.
${ocrBlock(ocrLines, "The card names are among these lines. When a card name matches one of them, copy that spelling.")}
${regionBlock("levelup", cardRect || gameRect)}${noteBlock()}

${KOREAN_RULE.replace('"why"', '"sees"')}

Answer with ONLY a JSON object, nothing else:
{"options": ["<name on card 1>", "<name on card 2>"], "descs": ["<its description>", "<its description>"], "selected": "<name of the highlighted card>", "buttons": ["<button label>"], "sees": "<화면에 무엇이 보이는지 한국어로 한 문장>"}`;
  }

  // ---- 레벨업 2단계: 그림 없이, 목록만 보고 무엇을 고를지 정한다 ----
  // ---- 공략 (진화 조합) ----
  // 나무위키 진화 무기 문서의 조합식을 옮긴 데이터 (game/knowledge/vs_evolutions.json).
  // gemma3 는 뱀서 진화 조합을 잘 모르거나 지어낸다. 레벨업 때 지금 나온 카드와 이번 판에 고른 것에
  // 관련된 조합만 이름으로 정확히 찾아 고르기 프롬프트에 몇 줄 붙인다 (RAG 비슷한 것).
  let guide = null;
  fetch("knowledge/vs_evolutions.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      guide = d && Array.isArray(d.evolutions) ? d : null;
      if (guide) {
        logger.push(
          `<span class="tag">공략</span> 진화 조합 ${guide.evolutions.length}개를 불러왔습니다 ` +
            '<span class="dim">— 레벨업 때 관련된 조합만 골라 LLM 에게 알려줍니다</span>'
        );
      }
    })
    .catch(() => {});

  // 캐릭터·스테이지 목록 (나무위키 캐릭터·스테이지 문서에서 이름, 시작 무기, 체력, 효과, 해금 조건,
  // 스테이지 시간만 옮긴 것). 메뉴에서 고를 때 LLM 에게 알려주고, 고른 캐릭터의 시작 무기를
  // 레벨업 공략의 "이미 가진 것" 에 넣는 데 쓴다.
  const roster = { characters: [], stages: [] };
  for (const [file, key] of [["vs_characters.json", "characters"], ["vs_stages.json", "stages"]]) {
    fetch("knowledge/" + file, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && Array.isArray(d[key])) roster[key] = d[key]; })
      .catch(() => {});
  }

  // 이번에 고른 캐릭터. 새로 고를 때까지 판을 넘어도 유지한다 (보통 같은 캐릭터로 계속 돌린다).
  let runCharacter = load("runCharacter", null);

  // 글자들 중에 아는 캐릭터 이름이 있나. 짧은 이름("이멜다")은 정확히 같을 때만 —
  // 한 글자짜리("포") 는 다른 말과 겹쳐서 보지 않는다.
  function findCharacters(texts) {
    const found = new Map();
    for (const t of texts || []) {
      for (const c of roster.characters) {
        const full = sameName(t, c.name) || ocrNorm(t).includes(ocrNorm(c.name));
        const short = c.short.length >= 2 && ocrNorm(t) === ocrNorm(c.short);
        if (full || short) found.set(c.name, c);
      }
    }
    return [...found.values()];
  }

  function findStage(text) {
    return roster.stages.find((st) => sameName(text, st.name) || (st.en && sameName(text, st.en))) || null;
  }

  // ---- 아이템 사전: 잘못 읽은 카드 이름을 실제 이름으로 바로잡는다 ----
  // gemma3 는 작은 한글 게임 글씨를 흐릿하면 아는 단어로 채우고, OCR 은 픽셀 글씨에서 한두 글자를
  // 틀린다 ("시금치" → "시급치"). 예전에는 "화면 글자에 있나" 만 봤지 이름을 고치지는 않았다.
  // 나무위키 무기·장신구·진화 무기 이름(game/knowledge/vs_items.json)과 비슷한 정도를 재서 고친다.
  let itemDict = [];
  fetch("knowledge/vs_items.json", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && Array.isArray(d.items)) itemDict = d.items.map((it) => ({ ...it, j: jamo(it.name) }));
    })
    .catch(() => {});

  // 한글 음절을 자모로 푼다: "시금치" → ㅅㅣㄱㅡㅁㅊㅣ. 틀린 게 받침 하나면 음절로는 3글자 중 1글자
  // 차이(67%)지만 자모로는 7개 중 1개 차이(86%)다. 한글 이름은 자모로 비교해야 제대로 가깝게 나온다.
  const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
  const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
  const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ",
    "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
  function jamo(text) {
    let out = "";
    for (const ch of ocrNorm(text)) {
      const c = ch.charCodeAt(0) - 0xac00;
      out += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + JONG[c % 28] : ch;
    }
    return out;
  }

  // 카드 이름 옆에 붙어 읽히는 것들 ("마늘 새로운!", "채찍 레벨 3") — 떼고 비교한다
  const NAME_TAILS = /\s*(새로운!?|NEW!?|레벨\s*:?\s*\d+|LV\.?\s*\d+|LEVEL\s*\d+)\s*$/i;

  // 사전에서 가장 비슷한 이름 (자모 비교, 영어 이름도 본다). 두 번째로 비슷한 것과의 차이도 같이 준다.
  function matchItem(text) {
    const tries = [String(text || "").replace(NAME_TAILS, "").trim()];
    const words = tries[0].split(/\s+/);
    for (let k = words.length - 1; k >= 1; k--) tries.push(words.slice(0, k).join(" ")); // 뒤에 붙은 말 떼기
    let best = null, bestS = 0, second = 0;
    for (const it of itemDict) {
      let sc = 0;
      for (const t of tries) {
        if (ocrNorm(t).length < 1) continue;
        sc = Math.max(sc, similar(jamo(t), it.j), it.en ? similar(ocrNorm(t), ocrNorm(it.en)) : 0);
      }
      if (sc > bestS) { second = bestS; bestS = sc; best = it; }
      else if (sc > second) second = sc;
    }
    return best ? { item: best, score: bestS, second } : null;
  }

  const SNAP_MIN = 0.72; // 이만큼은 비슷해야 고친다
  const SNAP_GAP = 0.06; // 두 번째로 비슷한 이름보다 이만큼 앞서야 한다 — 헷갈리면 안 고친다
  function snapItem(text) {
    const m = matchItem(text);
    if (!m) return null;
    if (m.score >= 0.999 || (m.score >= SNAP_MIN && m.score - m.second >= SNAP_GAP)) {
      return { name: m.item.name, score: m.score };
    }
    return null;
  }

  // LLM 이 읽은 카드 이름들을 사전과 화면 글자로 맞춘다.
  //  1) 화면 글자 중 사전 이름과 아주 비슷한 줄 = 화면에 실제로 있는 카드 (위에서부터)
  //  2) LLM 이름이 사전에서 그중 하나로 가면 → 그 이름 (철자만 고침)
  //  3) 아니고 카드 장수가 같으면 → 같은 자리의 화면 카드 이름 (LLM 이 다른 이름을 지어냈다)
  //  4) 그것도 아니면 → 사전에서 헷갈리지 않을 만큼 비슷한 이름, 없으면 그대로
  function fixCardNames(names, ocrLines) {
    const onScreen = [];
    for (const l of [...(ocrLines || [])].sort((a, b) => a.y - b.y)) {
      const sn = snapItem(l.text);
      if (sn && sn.score >= 0.8 && !onScreen.includes(sn.name)) onScreen.push(sn.name);
    }
    const fixes = [];
    const out = names.map((n, i) => {
      const sn = snapItem(n);
      if (sn && onScreen.includes(sn.name)) {
        if (sn.name !== n) fixes.push({ from: n, to: sn.name, by: "화면 글자+사전" });
        return sn.name;
      }
      if (onScreen.length === names.length && onScreen[i]) {
        if (onScreen[i] !== n) fixes.push({ from: n, to: onScreen[i], by: "화면 글자 같은 자리" });
        return onScreen[i];
      }
      if (sn) {
        if (sn.name !== n) fixes.push({ from: n, to: sn.name, by: "사전" });
        return sn.name;
      }
      return n;
    });
    return { names: out, fixes, onScreen };
  }

  // 목표 문장이 캐릭터·무기·맵 이야기를 하나
  function goalWantsRoster(goal) {
    const g = ocrNorm(goal);
    if (!g) return false;
    if (/캐릭터|무기|맵|스테이지|CHARACTER|WEAPON|STAGE|MAP/.test(g)) return true;
    const named = (x) => x && ocrNorm(x).length >= 2 && g.includes(ocrNorm(x));
    return (
      roster.characters.some((c) => named(c.short) || named(c.name)) ||
      roster.stages.some((st) => named(st.name)) ||
      !!guide?.evolutions.some((e) => e.weapons.some(named))
    );
  }

  // 메뉴 항목 중 아는 캐릭터·스테이지에 대한 사실 몇 줄
  function rosterFor(options) {
    const lines = [];
    for (const o of options) {
      const [c] = findCharacters([o]);
      if (c) {
        lines.push(
          `- ${o}: 캐릭터 · 시작 무기 ${c.weapon || c.note || "?"} · 체력 ${c.hp || "?"}` +
            (c.effect ? ` · ${c.effect}` : "")
        );
        continue;
      }
      const st = findStage(o);
      if (st) lines.push(`- ${o}: 스테이지 · ${st.time || "?"}` + (st.group ? ` · ${st.group}` : ""));
    }
    return lines.slice(0, 8);
  }

  // 메뉴에서 엔터를 누르기 직전에 부른다. 고르는 게 캐릭터면(항목 이름이 캐릭터거나, 화면 글자에
  // 캐릭터 이름이 딱 하나 보이면) 기억한다. 캐릭터 선택 화면은 초상화만 있고 이름은 옆 칸에
  // 선택된 캐릭터 하나만 나오기 때문에 화면 글자도 본다.
  async function noteCharacter(target) {
    let hit = findCharacters([target]);
    if (hit.length !== 1) {
      const ocr = await ocrRead(gameRect);
      hit = findCharacters((ocr?.lines || []).map((l) => l.text));
    }
    if (hit.length !== 1) return;
    const c = hit[0];
    if (runCharacter && runCharacter.name === c.name) return;
    runCharacter = { name: c.name, short: c.short, weapon: c.weapon };
    save("runCharacter", runCharacter);
    logger.push(
      `<span class="tag">캐릭터</span> <span class="pick">${c.name}</span> ` +
        `<span class="dim">— 시작 무기 ${c.weapon || c.note || "모름"}. 레벨업 공략에서 이미 가진 것으로 칩니다.</span>`
    );
  }

  // 띄어쓰기·대소문자는 무시. 한 글자 틀림은 긴 이름(6자 이상)에서만 봐준다 —
  // "검은 심장" 과 "붉은 심장" 처럼 짧은 이름은 한 글자 차이가 전혀 다른 아이템이다.
  const sameName = (a, b) => {
    const x = ocrNorm(a), y = ocrNorm(b);
    return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && similar(x, y) >= 0.8));
  };

  // cards: 지금 나온 카드 이름들, owned: 이번 판에 이미 고른 것들
  // 카드가 기본 무기인 조합은 늘 알려주고, 카드가 재료(패시브 등)로 쓰이는 조합은 이미 가진 것과
  // 이어질 때만 알려준다 — 검은 심장처럼 여러 조합에 쓰이는 재료는 다 늘어놓으면 너무 길다.
  function guideFor(cards, owned) {
    if (!guide) return [];
    const has = (n) => owned.some((o) => sameName(o, n));
    const lines = [];
    const used = new Set();
    for (const card of cards) {
      for (const e of guide.evolutions) {
        if (used.has(card + "|" + e.evolved)) continue; // 같은 조합도 카드마다 따로 (그 카드 입장에서 무엇을 가졌는지가 다르다)
        const asWeapon = e.weapons.some((w) => sameName(w, card));
        const asPart = e.needs.some((n) => sameName(n, card));
        if (!asWeapon && !asPart) continue;
        const others = [...e.weapons, ...e.needs].filter((x) => !sameName(x, card));
        const got = others.filter(has);
        if (!asWeapon && got.length === 0) continue;
        used.add(card + "|" + e.evolved);
        const parts = [
          ...e.weapons.map((w) => w + " (최고 레벨)"),
          ...e.needs.map((n) => n + (e.needs_max ? " (최고 레벨)" : "")),
        ];
        lines.push(
          `- ${card}${has(card) ? " (보유 중)" : ""}: ${parts.join(" + ")} → ${e.evolved}` +
            (others.length ? ` · 이미 가진 것: ${got.join(", ") || "없음"}` : "") +
            (e.note ? ` (${e.note})` : "")
        );
      }
    }
    return lines.slice(0, 12);
  }

  function buildPickPrompt(options, descs, guideLines) {
    const have =
      (runCharacter?.weapon ? `${runCharacter.weapon} (시작 무기, 캐릭터 ${runCharacter.name}), ` : "") +
      (pickedThisRun.length ? pickedThisRun.join(", ") : "(레벨업에서 고른 것 아직 없음)");
    const past = history
      .slice(-8)
      .filter((r) => r.picks && r.picks.length)
      .map((r) => `- ${Math.floor(r.sec / 60)}분 생존: ${r.picks.join(", ")}`)
      .join("\n") || "(기록 없음)";
    const list = options
      .map((o, i) => {
        const d = (descs && descs[i]) || "";
        return `${i + 1}. ${o}` + (d ? ` — ${d}` : "");
      })
      .join("\n");
    const guideBlock = guideLines && guideLines.length
      ? "\nEvolution recipes from a game guide (facts — trust these over your own memory)." +
        " An evolution needs the weapon at max level plus the listed items; it makes the weapon far stronger." +
        ' "이미 가진 것" lists what we already hold for that recipe:\n' +
        guideLines.join("\n") + "\n"
      : "";

    return `You are choosing what to take on a level-up screen in Vampire Survivors.

These are the choices on screen right now, in order:
${list}

What the player is going for this run (background only — this is NOT an instruction to
carry out here, and it never means restart, quit or leave this screen. You are only
choosing one upgrade card):
${goalText()}

Already taken this run: ${have}
${guideBlock}
Outcomes of past runs (survival time and what was taken):
${past}

Every entry above is an upgrade card. Reroll, Skip and Banish are not offered here —
do not answer with those.

Pick the single best upgrade for long-term survival. Prefer completing strong
weapon+passive synergies and evolutions over spreading thin — a card that completes or
advances a recipe above with something we already hold is usually the best pick.

Pick exactly one and copy it exactly from the list above.

${KOREAN_RULE}

Answer with ONLY a JSON object, nothing else:
{"target": "<copied exactly from the list>", "why": "<왜 그걸 골랐는지 한국어로 한 문장>"}`;
  }

  // 메뉴 쪽과 같은 흐름이다: 보고 → 고르고 → 코드가 방향키를 센다.
  // testImage 를 주면 화면 대신 그 사진으로 돌린다 (사진 시험 버튼용).
  async function llmPickCard(nCards, testImage) {
    const model = el.vsModel.value;
    if (!model) return null;
    // 카드 영역을 지정했으면 그 부분만, 아니면 게임 화면 전체를 보낸다.
    //
    // 처음에는 "글씨가 작아서 못 읽나" 싶어 좁게 자르는 쪽이 낫다고 생각했는데,
    // 재보니 반대였다. 1920x1080 을 900 으로 줄여 보내도 카드 이름과 옆 버튼을
    // 전부 읽는다. 반면 카드만 좁게 자르면 새로고침·건너뛰기·지우기가 크롭 밖으로
    // 밀려나 아예 안 보인다. 크기보다 범위가 중요하다.
    const crop = testImage
      ? { b64: testImage.b64, w: testImage.w, h: testImage.h }
      : cropRegion(cardRect || gameRect, LEVELUP_MAX_SIDE);
    if (!crop) return null;
    const image = crop.b64;
    if (!testImage && cardRect && !warnedCardRect) {
      warnedCardRect = true;
      logger.push(
        '<span class="tag">레벨업</span> <span class="dim">지정한 레벨업 영역만 잘라 보냅니다. ' +
          "새로고침·건너뛰기·삭제 버튼이 그 밖에 있으면 몰리 눈에 안 보입니다 — " +
          "버튼이 안 읽히면 영역을 조금 넓게 다시 잡아주세요.</span>"
      );
    }

    // --- 0단계: 글자 (OCR) — LLM 이 읽은 이름이 실제로 화면에 있는지 맞춰보는 데 쓴다 ---
    const ocr = testImage ? testImage.ocr : await ocrRead(cardRect || gameRect);
    const ocrLines = ocr?.lines || [];

    // --- 1단계: 화면 읽기 ---
    el.vsLlmState.textContent = "카드 읽는 중...";
    const seenRes = await askBridge(
      { type: "llm_ask", model, prompt: buildSeeLevelPrompt(nCards, ocrLines), image, timeout: 40 },
      45000
    );
    if (seenRes.error) {
      logger.push(`<span class="bad">LLM 실패: ${seenRes.error} — 지정한 키로 갑니다</span>`);
      return null;
    }
    const seen = parseJson(seenRes.text);
    const rawOptions = (Array.isArray(seen?.options) ? seen.options : [])
      .map((x) => String(x || "").trim().slice(0, 24))
      .filter(Boolean);
    if (!rawOptions.length) {
      pushRead({
        at: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
        options: [],
        why: "카드를 하나도 못 읽었습니다",
        imgW: crop.w,
        imgH: crop.h,
        tight: !!cardRect,
      });
      logger.push('<span class="bad">카드를 못 읽었습니다 — 누르지 않고 기다립니다</span>');
      return null;
    }
    // 읽은 이름을 아이템 사전과 화면 글자로 바로잡는다 ("시급치" → "시금치", 지어낸 이름 → 그 자리의 실제 카드)
    const fixed = fixCardNames(rawOptions, ocrLines);
    const options = fixed.names;

    // 읽은 이름이 OCR 글자 중에 있으면 실제로 화면에 있는 이름이다.
    // 전부 있으면 두 번 읽을 필요가 없다 (몇 초 아낀다).
    const ocrHit = options.map((o) => fixed.onScreen.includes(o) || ocrFind(o, ocrLines));
    const byOcr = ocrLines.length > 0 && ocrHit.every(Boolean);

    // 아니면 한 번 더 읽혀 대조한다. 지어낸 이름은 매번 달라지고, 실제로 읽은 이름은 그대로다.
    // 게임이 멈춰 있는 화면이라 몇 초 더 써도 된다.
    let options2 = [];
    if (!byOcr) {
      el.vsLlmState.textContent = "한 번 더 확인 중...";
      const seen2Res = await askBridge(
        { type: "llm_ask", model, prompt: buildSeeLevelPrompt(nCards, ocrLines), image, timeout: 40 },
        45000
      );
      const seen2 = seen2Res.error ? null : parseJson(seen2Res.text);
      options2 = fixCardNames(
        (Array.isArray(seen2?.options) ? seen2.options : []).map((x) => String(x || "").trim().slice(0, 24)).filter(Boolean),
        ocrLines
      ).names;
    }

    // 두 판독이 딴판인 자리는 못 읽은 것으로 본다.
    // 카드 장수부터 다르면 무엇을 봤는지 자체가 어긋난 것이다.
    const unreadable = new Set();
    const countMismatch = options2.length > 0 && options2.length !== options.length;
    for (let i = 0; i < options.length; i++) {
      const a = options[i];
      if (!a || a === "?" || isPlaceholder(a)) { unreadable.add(i); continue; }
      if (ocrHit[i]) continue; // 화면 글자로 확인된 이름
      if (countMismatch) { unreadable.add(i); continue; }
      if (options2.length && similar(a, options2[i]) < SIMILAR_ENOUGH) unreadable.add(i);
    }

    const descs = (Array.isArray(seen?.descs) ? seen.descs : []).map((x) =>
      String(x || "").trim().slice(0, 60)
    );
    // 예시를 베껴 왔으면 읽은 게 아니다
    if (options.some(isPlaceholder)) {
      pushRead({
        at: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
        options,
        why: "예시 문구를 그대로 답했습니다 — 카드를 못 읽은 것입니다",
        imgW: crop.w, imgH: crop.h, tight: !!cardRect,
      });
      logger.push(
        '<span class="bad">카드를 못 읽었습니다 (예시 문구를 그대로 답함) — 누르지 않고 기다립니다</span>'
      );
      return null;
    }
    const buttons = (Array.isArray(seen?.buttons) ? seen.buttons : [])
      .map((x) => String(x || "").trim().slice(0, 20))
      .filter(Boolean);

    let si = indexOfOption(rawOptions, seen.selected);
    if (si < 0) si = indexOfOption(options, seen.selected);
    if (si < 0) {
      logger.push('<span class="bad">지금 뭐가 선택돼 있는지 못 읽었습니다 — 누르지 않고 기다립니다</span>');
      return null;
    }

    // 지금 커서가 있는 카드를 못 읽었으면 몇 칸 움직일지도 믿을 수 없다.
    if (unreadable.size) {
      const bad = [...unreadable].map((i) => `${i + 1}번 "${options[i]}"`).join(", ");
      pushRead({
        at: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
        options,
        options2,
        descs,
        buttons,
        selected: options[si],
        ocr: ocrLines.map((l) => l.text),
        fixes: fixed.fixes,
        why: `두 번 읽은 결과가 달라 믿을 수 없습니다 (${bad})`,
        imgW: crop.w, imgH: crop.h, tight: !!cardRect, test: !!testImage,
      });
      logger.push(
        `<span class="bad">카드를 제대로 못 읽었습니다</span> ` +
          `<span class="dim">1차 [${options.join(" / ")}] · 2차 [${options2.join(" / ")}] ` +
          "— 지어낸 이름일 수 있어 누르지 않고 기다립니다</span>"
      );
      return null;
    }

    // --- 2단계: 무엇을 고를지 (그림 없이, 카드 중에서만) ---
    // 공략에서 지금 카드·가진 것과 관련된 진화 조합만 찾아 같이 준다
    const owned = [...(runCharacter?.weapon ? [runCharacter.weapon] : []), ...pickedThisRun];
    const guideLines = guideFor(options, owned);
    el.vsLlmState.textContent = "고르는 중...";
    const pickRes = await askBridge(
      { type: "llm_ask", model, prompt: buildPickPrompt(options, descs, guideLines), timeout: 40 },
      45000
    );
    if (pickRes.error) {
      logger.push(`<span class="bad">LLM 실패: ${pickRes.error} — 지정한 키로 갑니다</span>`);
      return null;
    }
    const picked = parseJson(pickRes.text);
    const ti = indexOfOption(options, picked?.target);
    if (ti < 0) {
      logger.push(
        `<span class="bad">LLM이 말한 "${picked?.target}"를 카드 목록에서 못 찾았습니다 — 지정한 키로 갑니다</span>`
      );
      return null;
    }

    // --- 3단계: 방향키 개수는 코드가 센다 ---
    // 모델에게 "몇 번째"를 시키면 이름은 맞히면서 번호를 틀린다. 그래서 여기서 뺀다.
    // 카드는 세로로 쌓여 있다. 버튼을 목록에서 뺐으므로 방향이 섞일 일이 없다.
    const keys = [...moveKeys(si, ti, "vertical", 1), "enter"].filter((k) => MENU_KEYS.includes(k));

    const why = String(picked?.why || "").slice(0, 80);
    pushRead({
      at: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
      options,
      options2,
      descs,
      buttons,
      selected: options[si],
      picked: options[ti],
      keys,
      ocr: ocrLines.map((l) => l.text),
      byOcr,
      fixes: fixed.fixes,
      guide: guideLines,
      why,
      imgW: crop.w,
      imgH: crop.h,
      tight: !!cardRect,
    });

    return {
      keys,
      options,
      si,
      ti,
      item: options[ti],
      from: options[si],
      why,
      sees: String(seen.sees || "").slice(0, 80),
      took: (seenRes.took || 0) + (pickRes.took || 0),
    };
  }

  let pendingMenu = null;
  let menuStats = load("menuStats", {}); // 상태 -> { tried, worked }

  // 눌러서 넘어갔는지. 예전에는 '화면 종류 이름'이 바뀌었는지만 봤다. 그러면
  // 캐릭터 선택 -> 스테이지 선택처럼 둘 다 '메뉴' 인 경우 화면은 바뀌었는데도
  // "그대로입니다" 가 됐다. 누르기 직전 화면과 지금 화면을 직접 비교한다.
  // 커서만 옮겨가는 정도(하이라이트 이동)는 차이가 작아서 넘어간 것으로 치지 않는다.
  function checkMenuOutcome(nowState, nowThumb) {
    if (!pendingMenu) return;
    const { state, keys, at, before } = pendingMenu;
    const elapsed = performance.now() - at;
    const diff = before && nowThumb ? thumbDist(before, nowThumb) : 0;
    const changed = nowState !== state || diff > MATCH_THRESHOLD;

    if (changed) {
      bumpMenu(state, true);
      if (el.vsLogOn.checked) {
        const where =
          nowState !== state
            ? `→ ${STATES[nowState] || nowState}`
            : `→ 다른 화면 (같은 종류, 화면 차이 ${diff.toFixed(3)})`;
        logger.push(`<span class="good">${STATES[state]}에서 ${keys.join(" → ")} 통함</span> ${where}`);
      }
      pendingMenu = null;
    } else if (elapsed > 4000) {
      bumpMenu(state, false);
      logger.push(
        `<span class="bad">${STATES[state]}에서 ${keys.join(" → ")} 눌렀지만 화면이 그대로입니다</span> ` +
          `<span class="dim">(화면 차이 ${diff.toFixed(3)} — 키가 게임에 안 들어갔거나, 커서 위치를 잘못 읽었을 수 있습니다. ` +
          `대상 창과 메뉴 이동 키 설정을 확인하세요)</span>`
      );
      pendingMenu = null;
    }
  }

  function bumpMenu(state, ok) {
    const s = (menuStats[state] = menuStats[state] || { tried: 0, worked: 0 });
    s.tried++;
    if (ok) s.worked++;
    save("menuStats", menuStats);
    renderMenuStats();
  }

  function renderMenuStats() {
    const rows = pausedStates()
      .filter((k) => menuStats[k])
      .map((k) => {
        const s = menuStats[k];
        const rate = ((s.worked / s.tried) * 100) | 0;
        const cls = rate >= 70 ? "good" : rate >= 30 ? "dim" : "bad";
        return `${STATES[k]} <span class="${cls}">${rate}%</span> (${s.worked}/${s.tried})`;
      });
    el.vsMenuStats.innerHTML = rows.length
      ? "LLM이 누른 키로 화면이 넘어간 비율 — " + rows.join(" · ")
      : "아직 멈춘 화면에서 키를 누른 기록이 없습니다";
  }

  // ---- 마킹 ----
  let markMode = null;
  let dragStart = null;
  let dragNow = null;
  const DRAG_MODES = ["game", "hp", "xp", "cards", "region"];

  function viewToNorm(e) {
    const r = view.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }

  view.addEventListener("mousedown", (e) => {
    if (!markMode) return;
    // 예전에는 여기서 레벨업 영역(cards)이 빠져 있어서, 그 버튼으로는 드래그가 시작되지 않았다
    if (DRAG_MODES.includes(markMode)) dragStart = viewToNorm(e);
  });
  view.addEventListener("mousemove", (e) => {
    if (dragStart) dragNow = viewToNorm(e);
  });
  view.addEventListener("mouseup", (e) => {
    if (!markMode) return;
    const p = viewToNorm(e);
    if (DRAG_MODES.includes(markMode)) {
      if (!dragStart) return;
      const rect = {
        x: Math.min(dragStart.x, p.x), y: Math.min(dragStart.y, p.y),
        w: Math.abs(p.x - dragStart.x), h: Math.abs(p.y - dragStart.y),
      };
      dragStart = dragNow = null;
      if (rect.w < 0.01 || rect.h < 0.005) return;
      if (markMode === "region") {
        openRegionForm(rect);
      } else if (markMode === "game") {
        gameRect = rect; save("game", rect);
        logger.push('<span class="good">게임 영역을 지정했습니다</span>');
      } else if (markMode === "cards") {
        cardRect = rect; save("cards", rect);
        warnedCardRect = false;
        logger.push(
          '<span class="good">레벨업 영역을 지정했습니다</span>' +
            '<span class="dim"> — 카드를 읽을 때 이 부분만 크게 잘라 보내고, ' +
            "게임이 멈췄는지 볼 때는 이 부분을 빼고 봅니다</span>"
        );
      } else if (markMode === "xp") {
        xpRect = rect; save("xp", rect);
        // 경험치는 색을 기억해두지 않는다. 레벨업 때 번쩍이면 그 색과 안 맞게 되기 때문에,
        // 매 프레임 바 양끝에서 기준을 새로 뽑는다.
        logger.push(
          '<span class="good">경험치 바를 지정했습니다</span>' +
            '<span class="dim"> — 색이 아니라 채워진 위치로 읽으므로 레벨업 때 번쩍여도 괜찮습니다. ' +
            "이제 젬을 먹으면 그게 보상으로 들어갑니다</span>"
        );
      } else {
        hpRect = rect; save("hp", rect);
        hpColor = sampleColor(rect); save("hpColor", hpColor);
        logger.push(`<span class="good">체력바를 지정했습니다 (기준색 rgb(${hpColor.join(",")}))</span>`);
      }
    }
    setMarkMode(null);
    renderMarks();
  });

  // 체력바의 왼쪽 끝 색을 기준색으로 삼는다 (바는 보통 오른쪽부터 줄어든다)
  function sampleColor(rect) {
    const img = wctx.getImageData(
      Math.floor(rect.x * AW), Math.floor(rect.y * AH),
      Math.max(2, Math.floor(rect.w * AW * 0.15)), Math.max(1, Math.floor(rect.h * AH))
    );
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  function setMarkMode(mode) {
    markMode = mode;
    document.querySelectorAll("[data-mark]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.mark === mode)
    );
    view.style.cursor = mode ? "crosshair" : "default";
    if (mode) {
      setStatus(
        mode === "game" ? "게임 화면 영역을 드래그하세요"
          : mode === "cards" ? "레벨업 창 전체를 드래그하세요 (카드 + 새로고침·건너뛰기·삭제 버튼까지)"
          : mode === "xp" ? "화면 맨 위 경험치 바를 드래그하세요"
          : mode === "region" ? "이름을 붙일 부분을 드래그하세요"
          : "체력바를 드래그하세요 (가득 찬 상태에서)",
        "ok"
      );
    }
  }

  function renderMarks() {
    const counts = Object.keys(STATES)
      .map((k) => `${STATES[k]} 기억 ${(taught[k] || []).length}`)
      .join(" · ");
    el.vsMarks.textContent =
      `게임영역 ${gameRect ? "지정됨" : "없음"} · 체력바 ${hpRect ? "지정됨" : "없음"} · 경험치바 ${xpRect ? "지정됨" : "없음"} · 레벨업영역 ${cardRect ? "지정됨" : "없음"} · ${counts}`;
  }

  // ---- 그리기 ----
  function drawView(info) {
    vctx.drawImage(work, 0, 0, view.width, view.height);
    const sx = view.width / AW, sy = view.height / AH;

    if (el.vsDebug.checked && info) {
      const d = info.dots;
      for (let i = 0; i < d.length; i += 3) {
        vctx.fillStyle = d[i + 2] ? "rgba(90,220,255,0.85)" : "rgba(255,70,70,0.5)";
        vctx.fillRect(d[i] * sx, d[i + 1] * sy, 2, 2);
      }
    }

    const box = (r, color, label) => {
      if (!r) return;
      vctx.strokeStyle = color;
      vctx.lineWidth = 2;
      vctx.strokeRect(r.x * view.width, r.y * view.height, r.w * view.width, r.h * view.height);
      if (label) {
        vctx.fillStyle = color;
        vctx.font = "14px NeoDunggeunmo, monospace";
        vctx.fillText(label, r.x * view.width + 3, r.y * view.height - 4);
      }
    };
    box(gameRect, "#7fd858", "게임");
    box(cardRect, "#c39bff", "레벨업");
    box(xpRect, "#8ef5a0", "경험치");
    if (xpLine) {
      vctx.strokeStyle = "#8ef5a0";
      vctx.lineWidth = 1;
      vctx.beginPath();
      vctx.moveTo(xpLine.x * view.width, xpLine.y * view.height);
      vctx.lineTo((xpLine.x + xpLine.w) * view.width, xpLine.y * view.height);
      vctx.stroke();
      if (info && info.xp !== null) {
        const ex = (xpLine.x + xpLine.w * info.xp) * view.width;
        vctx.fillStyle = "#8ef5a0";
        vctx.fillRect(ex - 2, xpLine.y * view.height - 5, 4, 10); // 읽은 경계
      }
    }
    // 이름 붙인 영역: 지금 화면에서 쓰는 것은 진하게, 다른 화면용은 흐리게
    for (const r of regions) {
      const on = !r.screen || r.screen === stableState;
      vctx.setLineDash([5, 4]);
      box(r, on ? "#ffb35c" : "rgba(255,179,92,0.35)", r.label + (r.screen && !on ? " (다른 화면)" : ""));
      vctx.setLineDash([]);
    }
    if (pendingRegion) box(pendingRegion, "#ffffff", "이름 붙일 영역");
    // 방금 읽은 글자 (몇 초만 보여준다)
    if (lastOcr && !lastOcr.test && performance.now() - lastOcr.at < 4000) {
      for (const l of lastOcr.lines) box(l, "rgba(94,230,255,0.9)", l.text);
    }
    if (el.vsUiBlue.checked && !cardRect) {
      vctx.setLineDash([2, 5]);
      box(uiCheckRect(), uiShown ? "#5aa9ff" : "rgba(90,169,255,0.45)", uiShown ? "파란 창 보임" : "파란 창 확인");
      vctx.setLineDash([]);
    }
    box(hpRect, "#ff7b6b", "체력");
    if (dragStart && dragNow) {
      box({
        x: Math.min(dragStart.x, dragNow.x), y: Math.min(dragStart.y, dragNow.y),
        w: Math.abs(dragNow.x - dragStart.x), h: Math.abs(dragNow.y - dragStart.y),
      }, "#ffd479");
    }


    // 게임 영역 중앙 = 캐릭터 위치
    const r = gameRect || { x: 0, y: 0, w: 1, h: 1 };
    const cx = (r.x + r.w / 2) * view.width;
    const cy = (r.y + r.h / 2) * view.height;
    const reach = (Math.min(r.w * view.width, r.h * view.height) / 2) * 0.9;

    // 방향마다 얼마나 달아날 수 있는지를 선 길이로 보여준다.
    // 짧고 빨간 쪽이 막힌 방향, 길고 파란 쪽이 열린 방향이다.
    if (info && info.field) {
      for (let d = 0; d < 8; d++) {
        const len = info.field.escape[d] * reach;
        const t = info.field.escape[d];
        vctx.strokeStyle = `rgba(${Math.round(255 * (1 - t))}, ${Math.round(200 * t + 40)}, 120, 0.75)`;
        vctx.lineWidth = 3;
        vctx.beginPath();
        vctx.moveTo(cx, cy);
        vctx.lineTo(cx + DIRS[d].ux * len, cy + DIRS[d].uy * len);
        vctx.stroke();
      }
    }

    vctx.strokeStyle = "#7fd858";
    vctx.lineWidth = 2;
    vctx.strokeRect(cx - 6, cy - 6, 12, 12);
    if (lastAction !== null && running) {
      const d = DIRS[lastAction];
      vctx.strokeStyle = "#ffd479";
      vctx.lineWidth = 4;
      vctx.beginPath();
      vctx.moveTo(cx, cy);
      vctx.lineTo(cx + d.ux * reach, cy + d.uy * reach);
      vctx.stroke();
    }
  }

  // ---- 루프 ----
  // rAF는 창이 가려지면 멈춘다. 게임 창을 클릭해야 하는 구조라 타이머를 쓴다.
  let loopTimer = null;
  let running = false;
  let heldKeys = [];
  let lastFrame = 0;
  let lastDt = 0.066;
  let fps = 0;
  let lastThumb = null;

  // 화면이 바뀌는 순간에는 한 프레임짜리 오판이 섞인다. 레벨업이 막 떴는데 아직
  // "플레이 중"으로 읽히거나 그 반대인 찰나가 있고, 그때 키가 나가면 추론도 하기 전에
  // 카드가 골라져 버린다. 같은 판정이 이만큼 이어져야 비로소 행동한다.
  const SETTLE_MS = 450;
  let stableState = null;
  let stableSince = 0;

  function startLoop() {
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, 66);
  }

  function loop() {
    if (!stream || video.readyState < 2) return;
    const now = performance.now();
    const dt = Math.max(0.001, (now - lastFrame) / 1000);
    lastDt = Math.min(dt, 0.5); // 탭이 잠깐 멈췄다 돌아온 프레임이 한 번에 크게 먹지 않도록
    lastFrame = now;
    fps = fps * 0.8 + (1 / dt) * 0.2;

    const info = analyze();
    lastThumb = info.thumb;
    // 게임이 멈췄나. 카메라가 안 움직이고 바깥 전장도 안 움직이면 멈춘 것.
    // 카메라 이동을 아직 못 잰 프레임은 예전처럼 화면 전체 변화량으로 대신한다.
    const stillNow =
      info.outerMove !== null
        ? info.outerMove < STILL_RATIO && info.shift.dx === 0 && info.shift.dy === 0
        : info.motion < FREEZE_MOTION;
    if (stillNow) { if (!stillSince) stillSince = now; } else stillSince = 0;
    // 파란 창을 보기로 했으면 그게 먼저다. 창이 떠 있으면 멈춘 화면, 없으면 플레이 —
    // 아무것도 안 움직여도. 창 없이 멈추는 화면(상자·게임 오버)은 오래 멈춰 있을 때만 인정한다.
    const uiOn = el.vsUiBlue.checked;
    const uiThr = Number(el.vsUiThr.value) / 100;
    // 한 번 창으로 봤으면 조금 덜 파래져도 유지한다 (창 안 글씨·아이콘이 바뀌며 흔들린다)
    // 카메라가 움직이고 있으면 게임이 돌아가는 중이다. 파란 바닥이 아무리 넓어도 창이 아니다.
    if (info.shift.ok && (info.shift.dx || info.shift.dy)) lastCamMoveAt = now;
    const camStill = now - lastCamMoveAt >= CAM_STILL_MS;
    const blueNow = camStill && info.ui.blue >= (uiShown ? uiThr * 0.7 : uiThr);
    if (blueNow) { if (!blueSince) blueSince = now; } else blueSince = 0;
    uiShown = !!blueSince && now - blueSince >= UI_HOLD;
    const stillFrozen = !!stillSince && now - stillSince >= (uiOn ? LONG_FREEZE : FREEZE_HOLD);
    const worldFrozen = uiOn ? uiShown || stillFrozen : stillFrozen;
    if (worldFrozen && !lastWorldFrozen) frozeAt = now;
    lastWorldFrozen = worldFrozen;
    lastFrozenWhy = !worldFrozen ? "" : uiOn && uiShown ? "파란 창" : "움직임 없음";

    const cls = classify(info.thumb, worldFrozen);

    // 멈춘 화면인데 뭔지 모르고, 알아볼 수단(LLM 화면 판별)도 꺼져 있으면 알려준다.
    // 글자 읽기가 켜져 있으면 그게 먼저 보고 나서 말한다 — 안 그러면 글자로 금방 알아볼
    // 화면에서도 "모릅니다" 가 먼저 찍힌다.
    // 멈추기 전에 읽은 글자(플레이 화면)로 판단하면 안 된다 — 멈춘 뒤에 읽은 것만 친다.
    const ocrGaveUp =
      !el.vsOcrOn.checked ||
      (lastOcr && !lastOcr.test && !lastOcr.match && lastOcr.at >= frozeAt);
    if (worldFrozen && cls.guessed && !el.vsIdOn.checked && ocrGaveUp && !hintedIdOff) {
      hintedIdOff = true;
      logger.push(
        '<span class="bad">게임이 멈췄는데 무슨 화면인지 모릅니다</span> ' +
          '<span class="dim">— 가르쳐준 화면과 안 맞고, ' +
          (el.vsOcrOn.checked ? "화면 글자로도 못 알아봤고, " : "") +
          "LLM 화면 판별도 꺼져 있어서 레벨업인지 알 수단이 없습니다. " +
          "LLM 메뉴에서 \"화면 종류도 LLM이 판별\" 을 켜거나, 화면 설정에서 레벨업을 가르쳐주세요.</span>"
      );
    }
    lastMatch = cls.sample; // 이 화면에 붙은 메모만 프롬프트에 들어간다

    if (cls.state !== stableState) {
      stableState = cls.state;
      stableSince = now;
    }
    const settled = now - stableSince >= SETTLE_MS;

    // 가르쳐준 화면이 아닌데 멈춰 있으면 "메뉴" 라고 단정하지 않는다 — 레벨업일 수도 있다.
    el.vsState.textContent =
      (cls.guessed
        ? cls.state === "play" ? "플레이 중 (추정)" : "멈춘 화면 (종류 모름)"
        : STATES[cls.state] || cls.state) +
      (settled ? "" : " · 확인 중");
    el.vsState.className = cls.guessed || !settled ? "dim" : "";
    el.vsFeat.textContent =
      `게임 멈춤 ${frozenText()}` +
      (uiOn ? ` · 파란 창 ${(info.ui.blue * 100).toFixed(0)}% (${el.vsUiThr.value}% 넘으면 게임 아님)` : "") +
      (info.outerMove !== null
        ? ` (바깥 전장 움직임 ${(info.outerMove * 100).toFixed(2)}%, 카메라 ${info.shift.dx},${info.shift.dy})`
        : ` (화면 변화 ${info.motion.toFixed(1)} — 카메라를 아직 못 잼)`) +
      ` · 가장 비슷한 가르친 화면 ${cls.nearest ? STATES[cls.nearest] || cls.nearest : "없음"}` +
      ` 차이 ${isFinite(cls.dist) ? cls.dist.toFixed(3) : "-"} (${MATCH_THRESHOLD} 미만이면 같은 화면) · ` +
      `중앙빨강 ${info.red.toFixed(3)} (평소 ${info.redBase.toFixed(3)}, +${HURT_JUMP} 넘으면 피격) · ` +
      `인식 흔들림 ${info.jitter.toFixed(3)}` +
      (info.jitter > 0.08 ? " (큼 — 이펙트를 적으로 세는 중일 수 있습니다)" : "");
    el.vsHp.textContent =
      (info.hp === null ? "체력바 미지정" : `${(info.hp * 100).toFixed(0)}%`) +
      (info.hurt ? " · 피격!" : "");
    el.vsXp.textContent =
      info.xp === null ? "못 읽음" : `${(info.xp * 100).toFixed(0)}%${xpRect ? "" : " (맨 위 한 줄)"}`;
    el.vsHp.className = info.hurt ? "bad" : "";
    checkMenuOutcome(cls.state, info.thumb);
    maybeIdentify(cls, worldFrozen, now);

    // 폰 지시를 처리하는 동안에는 자동 조작을 쉰다 (키가 섞이지 않게)
    if (running && !remoteBusy) {
      if (cls.state === "play") {
        menuTries = []; // 메뉴를 빠져나왔다. 다음에 만나는 메뉴는 새로 본다
        // 끝났다고 보류해둔 게 있으면, 플레이가 얼마 만에 돌아왔는지로 판단한다.
        // 금방 돌아왔다면 부활이다 — 같은 판이므로 없던 일로 한다.
        if (pendingEnd) {
          if (now - pendingEnd < RESUME_WINDOW) cancelEnd("플레이가 다시 시작됨");
          else commitEnd();
        }
        // 앞 판을 닫지 못한 채 새 판이 시작되는 경우가 있다 (결과 화면을 못 읽고 넘어간 경우).
        // 그때라도 기록은 남겨야 한다.
        if (!run.active) {
          if (run.startedAt) endRun("다음 판 시작");
          startRun();
        }
        const action = run.blind
          ? (trackHitsOnly(info), blindAction(now))
          : decide(info);
        lastTaken = action;
        lastTakenBlind = !!run.blind;
        heldKeys = DIRS[action].keys;
        sendKeys(heldKeys); // 매 틱 보내 워치독이 키를 떼지 않게 한다
        el.vsDir.textContent = DIRS[action].name;
        el.vsRunNow.textContent =
          `${((performance.now() - run.startedAt) / 1000).toFixed(0)}초 · 피격 ${run.hits}`;
        checkStuck("xp", info.xp, now);
        checkStuck("hp", info.hp, now);
      } else {
        // 플레이가 아니면 잡고 있던 키부터 놓는다. 이건 확정을 기다리지 않는다 —
        // 메뉴가 떴는데 계속 움직이고 있으면 곤란하다.
        if (heldKeys.length) { heldKeys = []; sendKeys([]); }
        // 부활 화면은 판이 이어진다는 뜻이다. 앞서 사망으로 읽었더라도 여기서 되돌린다.
        if (cls.state === "revive") {
          cancelEnd("부활 화면");
        } else if (cls.state === "menu") {
          // 시작 메뉴까지 갔으면 되돌릴 여지가 없다. 바로 확정한다.
          markEnd("메뉴로 나감");
          commitEnd();
        } else if (cls.state === "dead") {
          // 사망으로 보이지만 아직 확정하지 않는다 — 부활로 이어질 수 있다.
          markEnd("사망");
        }
        // 보류한 채로 오래 멈춰 있으면 진짜 끝난 것이다.
        if (pendingEnd && now - pendingEnd > RESUME_WINDOW) commitEnd();
        // 누르는 건 화면이 확정된 뒤에만.
        if (settled) handleMenu(cls.state);
        el.vsDir.textContent = "-";
        lastObs = null;
        lastAction = null;
        prevHp = null; // 판이 바뀌면 체력·경험치 비교를 끊는다
        prevXp = null;
      }
    }

    el.vsEnemies.textContent = info.enemyCount;
    el.vsGems.textContent = info.gemCount;
    el.vsFps.textContent = fps.toFixed(0);
    el.vsEnemyThrVal.textContent = el.vsEnemyThr.value;
    el.vsMoveThrVal.textContent = el.vsMoveThr.value;
    el.vsUiThrVal.textContent = el.vsUiThr.value + "%";
    el.vsGemThrVal.textContent = el.vsGemThr.value;
    drawView(info);
    if (sightVisible() || remoteWatching) drawSight(info);
    pushRemote(info, now);
  }

  // ---- 폰으로 보기 ----
  // 폰이 이 페이지를 그냥 열면 빈 페이지다 — 화면 공유와 몰리의 상태는 이 탭 안에만 있다.
  // 그래서 2초마다 상태를 브릿지로 보내고, 폰은 브릿지가 여는 페이지에서 본다.
  // 폰에서 온 지시(정지·시작·말)도 이때 답장으로 받아온다.
  // 그림(화면·시야)은 폰이 실제로 보고 있을 때만 보낸다.
  let remoteOn = false;       // 브릿지를 --remote 로 띄웠나 (연결될 때 브릿지가 알려준다)
  let remoteWatching = false; // 등록한 폰이 최근 10초 안에 가져갔나
  let lastRemoteAt = 0;
  let remoteCode = null;      // 마지막으로 만든 연결 코드 — 어느 응답이 화면을 다시 그려도 남긴다
  let remoteCodeUntil = 0;
  const REMOTE_EVERY = 2000;

  function snapJpeg(canvas, width, quality) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = Math.round((canvas.height * width) / canvas.width);
    c.getContext("2d").drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", quality).split(",")[1];
  }

  function remoteState(info) {
    return {
      at: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
      running,
      screen: el.vsState.textContent,
      run: el.vsRunNow.textContent,
      dir: el.vsDir.textContent,
      hp: el.vsHp.textContent,
      xp: el.vsXp.textContent,
      enemies: info.enemyCount,
      gems: info.gemCount,
      live: el.vsLive.textContent,
      frozen: frozenText(),
      llm: el.vsLlmState.textContent,
      char: runCharacter ? `${runCharacter.name} (시작 무기 ${runCharacter.weapon || "?"})` : "",
      cmd: remoteCmdStatus,
      cmdBusy: remoteBusy,
      logs: [...document.querySelectorAll("#vsLog > *")].slice(0, 30).map((e) => e.textContent),
      reads: readLog.slice(-3).reverse().map((r) => ({
        at: r.at, options: r.options, picked: r.picked, why: r.why,
        selected: r.selected, nav: r.nav, keys: r.keys, byOcr: r.byOcr, fixes: r.fixes,
      })),
    };
  }

  function pushRemote(info, now) {
    if (!remoteOn || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (now - lastRemoteAt < REMOTE_EVERY) return;
    lastRemoteAt = now;
    const msg = { type: "remote_push", state: remoteState(info) };
    if (remoteWatching) {
      msg.view = snapJpeg(view, 480, 0.6);
      msg.sight = snapJpeg(el.vsSight, 480, 0.6);
    }
    askBridge(msg, 5000).then((r) => {
      if (r.watching !== undefined) remoteWatching = !!r.watching;
      for (const c of r.commands || []) runRemoteCommand(c);
      // '폰으로 보기' 메뉴를 보고 있으면 연결 상태도 같이 새로 그린다 (코드가 쓰였는지, 누가 보는지)
      if (document.querySelector('.vs-sec[data-sec="remote"]')?.classList.contains("is-active")) renderRemote();
    });
  }

  function showRemote(r) {
    if (!r || r.error) {
      el.vsRemoteState.textContent = r?.error ? `브릿지에 묻지 못했습니다: ${r.error}` : "브릿지에 연결되면 확인할 수 있습니다";
      return;
    }
    if (!r.on) {
      el.vsRemoteState.innerHTML =
        '<span class="bad">꺼져 있습니다</span> — 브릿지를 <code>.\\start.ps1 -Remote</code> ' +
        "(또는 <code>bridge.py --remote</code>) 로 띄워야 합니다.";
      return;
    }
    // 어느 주소를 언제 쓰는지 붙인다. 이름 없는 주소(도커·WSL 가상 주소)는 폰이 못 쓰니 뺀다.
    const kinds = r.kinds || {};
    const usable = (r.addrs || []).filter((a) => kinds[a] !== "");
    const addrs =
      usable.map((a) => `<b>http://${a}:${r.port}</b>${kinds[a] ? ` <span class="dim">(${kinds[a]})</span>` : ""}`).join("<br />") ||
      `(이 PC 주소):${r.port}`;
    const outside = usable.some((a) => (kinds[a] || "").startsWith("밖에서"))
      ? ""
      : '<br /><span class="bad">밖(모바일 데이터)에서는 안 열립니다</span> ' +
        '<span class="dim">— 집 와이파이 주소는 집 안에서만 통합니다. 밖에서 보려면 PC 와 폰에 Tailscale 을 켜세요 ' +
        "(켜고 브릿지를 다시 띄우면 여기에 밖에서 쓰는 주소가 생깁니다).</span>";
    const devices = (r.devices || []).length
      ? r.devices.map((d) => `${d.since} 연결 — <span class="dim">${d.name.replace(/[<>&]/g, "")}</span>`).join("<br />")
      : '<span class="dim">아직 없음</span>';
    if (r.code_active === false) remoteCode = null; // 폰이 썼거나 시간이 지났다
    const left = Math.round((remoteCodeUntil - performance.now()) / 1000);
    const code =
      remoteCode && left > 0
        ? `<div class="vs-code">${remoteCode}</div><span class="dim">폰에서 아래 주소를 열고 이 숫자를 넣으세요. ` +
          `${left}초 안에, 한 번만 쓸 수 있습니다.</span><br />`
        : "";
    el.vsRemoteState.innerHTML =
      code +
      `<span class="good">켜짐</span> · 폰에서 열 주소:<br />${addrs}${outside}` +
      `<br />${r.watching ? '<span class="good">지금 폰이 보고 있습니다</span>' : '<span class="dim">지금 보는 폰 없음</span>'}` +
      `<br />연결한 기기:<br />${devices}`;
  }

  async function renderRemote(action) {
    if (!el.vsRemoteState) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!action) return showRemote(null);
      if (!(await connectBridge())) return showRemote({ error: "브릿지 미연결" });
    }
    const r = await askBridge({ type: action || "remote_info" }, 5000);
    if (r.code) {
      remoteCode = r.code;
      remoteCodeUntil = performance.now() + (r.ttl || 120) * 1000;
    }
    showRemote(r);
  }

  function setStatus(text, kind) {
    el.vsStatus.textContent = text;
    el.vsStatus.className = "vs-status" + (kind ? " " + kind : "");
  }

  async function start() {
    if (!stream) return setStatus("먼저 화면 공유를 해주세요", "bad");
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) return setStatus("브릿지에 연결하지 못했습니다", "bad");
    }
    if (!gameRect) logger.push('<span class="dim">게임 영역이 지정되지 않아 화면 전체를 게임으로 봅니다</span>');
    if (remoteOn) await askBridge({ type: "remote_unhold" }, 3000); // 폰에서 걸어둔 정지를 푼다
    await askBridge({ type: "resume" }, 3000); // ESC 로 걸린 정지를 푼다
    running = true;
    setStatus("조작 중 — 게임 창을 클릭해서 활성화하세요 (ESC 로 정지)", "ok");
  }

  function stop() {
    running = false;
    heldKeys = [];
    sendStop();
    el.vsDir.textContent = "-";
    setStatus("정지됨", "");
  }

  el.vsShare.addEventListener("click", share);
  el.vsDemo.addEventListener("click", useDemo);
  el.vsRun.addEventListener("click", start);
  el.vsStop.addEventListener("click", stop);
  el.vsLogOn.addEventListener("change", () => logger.setEnabled(el.vsLogOn.checked));

  // ---- 이 화면이 뭔지 직접 물어보기 ----
  // 자동 판별은 "멈췄고 + 처음 보는 화면"일 때만 돈다. 보상 상자처럼 잠깐 스쳐가거나
  // 사람이 먼저 확인하고 싶은 화면은 그 조건에 안 걸린다. 그래서 손으로 부를 수단을 둔다.
  let askedState = null;
  let askedThumb = null;

  el.vsAskScreen.addEventListener("click", async () => {
    if (!stream) {
      el.vsAskResult.textContent = "먼저 화면 공유를 해주세요";
      return;
    }
    if (!el.vsModel.value) {
      el.vsAskResult.textContent = "먼저 모델을 고르세요 (모델 목록 버튼)";
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) {
        el.vsAskResult.textContent = "브릿지에 연결하지 못했습니다";
        return;
      }
    }
    el.vsAskScreen.disabled = true;
    el.vsAskRemember.disabled = true;
    el.vsAskResult.textContent = "묻는 중...";

    // 지금 이 순간의 화면을 붙잡아 둔다. 답이 오는 사이 화면이 바뀌어도
    // 기억시킬 때는 물어본 그 화면을 써야 한다.
    const snap = lastThumb;
    const r = await identifyScreen();
    el.vsAskScreen.disabled = false;

    if (r.error) {
      askedState = null;
      el.vsAskResult.textContent = `실패: ${r.error}`;
      return;
    }
    askedState = r.state;
    askedThumb = snap;
    el.vsAskRemember.disabled = !snap;
    el.vsAskResult.innerHTML =
      `<b>${STATES[r.state]}</b> 라고 합니다 (${(r.took || 0).toFixed(1)}초) — ${r.why}` +
      (snap ? "" : " <span class=\"bad\">(화면을 못 붙잡아 기억은 못 시킵니다)</span>");
  });

  // 사람이 적어준 말이 아는 화면 중 무엇인지 정한다. 그림은 주지 않는다 —
  // 그림을 같이 주면 화면에 끌려가서 엉뚱하게 답하는 게 이미 확인됐다.
  function buildTellPrompt(text) {
    const list = Object.entries(STATES)
      .map(([k, ko]) => `- ${k} (${ko})`)
      .join("\n");
    return `The player is telling you what a screen in the game Vampire Survivors is.
They wrote this in Korean:

"${text}"

Screen kinds that are already known:
${list}

If they mean one of those, put its key in "known" and leave "key" and "label" empty.

If they mean a kind that is NOT in that list, invent a new one instead:
- "key"   : a short lowercase English identifier, letters and underscores only,
            for example character_select or stage_select
- "label" : a short Korean name for it, 2 to 6 characters, for example 캐릭터 선택
Leave "known" empty in that case.

Do not force it into an existing kind when it is really something else.

${KOREAN_RULE}

Answer with ONLY a JSON object, nothing else:
{"known": "<existing key, or empty>", "key": "<new key, or empty>", "label": "<new Korean label, or empty>", "why": "<왜 그렇게 봤는지 한국어로 한 문장>"}`;
  }

  el.vsTellBtn.addEventListener("click", async () => {
    const text = (el.vsTellText.value || "").trim();
    if (!text) {
      el.vsHints.textContent = "무엇인지 적어주세요";
      return;
    }
    const snap = lastThumb; // 메모는 지금 이 화면에 붙는다
    if (!snap) {
      el.vsHints.innerHTML =
        '<span class="bad">지금 보이는 화면이 없습니다 — 화면 공유를 먼저 해주세요.</span>' +
        '<br /><span class="dim">메모는 화면 사진에 붙는 것이라, 붙일 화면이 있어야 합니다.</span>';
      return;
    }
    if (!el.vsModel.value || !ws || ws.readyState !== WebSocket.OPEN) {
      el.vsHints.innerHTML =
        '<span class="bad">모델과 브릿지가 필요합니다 (모델 목록 버튼)</span>';
      return;
    }
    el.vsTellText.value = "";
    el.vsTellBtn.disabled = true;
    el.vsHints.innerHTML += '<br /><span class="dim">어떤 화면인지 맞춰보는 중...</span>';

    const res = await askBridge(
      { type: "llm_ask", model: el.vsModel.value, prompt: buildTellPrompt(text), timeout: 40 },
      45000
    );
    el.vsTellBtn.disabled = false;
    renderHints();

    const o = res.error ? null : parseJson(res.text);
    let st = String(o?.known || "").trim().toLowerCase();
    let made = false;

    // 아는 종류가 아니면 새로 만든다. 예전에는 억지로 여섯 개 중 하나에 밀어넣었는데,
    // 그러면 "카드 선택 화면"처럼 목록에 없는 화면을 영영 말해줄 수 없었다.
    if (!STATES[st]) {
      const k = addState(o?.key, o?.label);
      if (k) {
        st = k;
        made = true;
      }
    }
    if (!STATES[st]) {
      // 새 종류도 못 만들었으면 지금 화면으로 읽히던 종류에 붙인다.
      st = stableState && STATES[stableState] ? stableState : "menu";
      const why = res.error || "무슨 화면인지 정하지 못했습니다";
      teach(st, snap, text);
      renderHints();
      el.vsHints.innerHTML =
        `<span class="dim">${why} — 지금 화면("${STATES[st]}")에 메모만 붙였습니다.</span>`;
      return;
    }

    teach(st, snap, text);
    renderHints();
    if (made) {
      el.vsHints.innerHTML =
        `<span class="good">"${STATES[st]}" 라는 화면 종류를 새로 만들었습니다</span>` +
        `<span class="dim"> — 가르치기 버튼과 키 지정 목록에도 올라갔습니다. ${o?.why || ""}</span>`;
    }
    logger.push(
      `<span class="tag">알려줌</span> <span class="pick">${STATES[st]}${made ? " (새 종류)" : ""}</span> ` +
        `<span class="dim">${text}</span>`
    );
  });

  el.vsAskRemember.addEventListener("click", () => {
    if (!askedState || !askedThumb) return;
    teach(askedState, askedThumb);
    el.vsAskRemember.disabled = true;
    el.vsAskResult.innerHTML += ` <b class="good">→ 기억했습니다</b>`;
  });

  // 화면 종류는 늘어날 수 있으므로 버튼도 그때그때 다시 만든다.
  function renderTeachButtons() {
    el.vsTeachBtns.innerHTML = Object.entries(STATES)
      .map(([k, ko]) => {
        const mine = !BUILTIN_STATES.includes(k);
        return `<button data-teach="${k}"${mine ? ' class="is-mine"' : ""}>${ko}${mine ? " ✎" : ""}</button>`;
      })
      .join("");
  }
  // 버튼이 다시 만들어져도 동작하도록 컨테이너에서 한 번만 받는다
  el.vsTeachBtns.addEventListener("click", (e) => {
    const b = e.target.closest("[data-teach]");
    if (b) teach(b.dataset.teach);
  });
  document.querySelectorAll("[data-mark]").forEach((b) =>
    b.addEventListener("click", () => setMarkMode(markMode === b.dataset.mark ? null : b.dataset.mark))
  );
  document.getElementById("vsForget").addEventListener("click", () => {
    taught = {};
    // 만들어둔 화면 종류도 같이 지운다. 기억이 없으면 그 종류만 남아봐야 쓸모가 없다.
    for (const k of Object.keys(customStates)) delete STATES[k];
    customStates = {};
    gameRect = null; hpRect = null; hpColor = null; cardRect = null;
    regions = [];
    runCharacter = null;
    renderRegions();
    xpRect = null;
    // 키 지정이 바뀌면 그 성공률 기록도 의미가 없어지므로 같이 지운다
    menuStats = {};
    ["taught", "plan", "game", "hp", "hpColor", "xp", "menuStats", "cards", "customStates", "regions", "uiColor", "runCharacter"].forEach((k) =>
      localStorage.removeItem(STORE + "." + k)
    );
    renderMenuStats();
    renderMarks();
    renderTeachButtons();
      renderHints();
    logger.push('<span class="dim">지정한 영역과 기억을 모두 지웠습니다</span>');
  });

  document.addEventListener("visibilitychange", () => {
    if (!running) return;
    if (document.hidden) {
      setStatus("브라우저 창이 가려져 봇이 멈췄습니다 — 창을 나란히 두세요", "bad");
    } else {
      setStatus("조작 중", "ok");
    }
  });

  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      if (tab.dataset.tab !== "vamp" && running) stop();
    })
  );
  window.addEventListener("beforeunload", sendStop);

  el.vsAlpha.addEventListener("input", () => {
    el.vsAlphaVal.textContent = `${el.vsAlpha.value}%`;
  });

  document.getElementById("vsLoadModels").addEventListener("click", async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) {
        logger.push('<span class="bad">브릿지에 먼저 연결해야 합니다</span>');
        return;
      }
    }
    const res = await askBridge({ type: "llm_models" }, 8000);
    if (res.error || !res.models) {
      logger.push(`<span class="bad">모델 목록을 못 받았습니다: ${res.error || "응답 없음"}</span>`);
      return;
    }
    if (!res.models.length) {
      logger.push('<span class="bad">Ollama에 설치된 모델이 없습니다</span>');
      return;
    }
    // 실측 비교 결과 기본값. gemma3:12b는 카드를 정확히 읽고 warm 5.6초.
    // qwen3-vl은 thinking 모델이라 답을 못 내고, llama3.2-vision은 Ollama가 아키텍처를 지원하지 않는다.
    const saved = load("model", "gemma3:12b");
    el.vsModel.innerHTML = res.models.map((m) => `<option${m === saved ? " selected" : ""}>${m}</option>`).join("");
    logger.push(`<span class="good">모델 ${res.models.length}개 — ${res.models.join(", ")}</span>`);
  });

  el.vsModel.addEventListener("change", () => {
    save("model", el.vsModel.value);
    if (el.vsIdOn.checked || el.vsLlmOn.checked) warmModel();
  });

  el.vsWindow.value = load("window", "");

  el.vsRegionAsk.addEventListener("click", askRegion);
  el.vsRegionSave.addEventListener("click", saveRegion);
  el.vsRegionCancel.addEventListener("click", closeRegionForm);
  el.vsRegionLabel.addEventListener("keydown", (e) => { if (e.key === "Enter") saveRegion(); });
  el.vsRegionList.addEventListener("click", (e) => {
    const b = e.target.closest("[data-del-region]");
    if (!b) return;
    const i = Number(b.dataset.delRegion);
    const [gone] = regions.splice(i, 1);
    save("regions", regions);
    renderRegions();
    if (gone) logger.push(`<span class="dim">영역 "${gone.label}" 을 지웠습니다</span>`);
  });

  el.vsNavKeys.value = load("navKeys", "wasd");
  el.vsNavKeys.addEventListener("change", () => {
    save("navKeys", el.vsNavKeys.value);
    logger.push(`<span class="tag">메뉴 이동 키</span> ${el.vsNavKeys.selectedOptions[0].textContent}`);
  });

  el.vsEnemyMode.value = load("enemyMode", "motion");
  el.vsEnemyMode.addEventListener("change", () => save("enemyMode", el.vsEnemyMode.value));
  el.vsMoveThr.value = load("moveThr", 22);
  el.vsMoveThr.addEventListener("change", () => save("moveThr", Number(el.vsMoveThr.value)));
  el.vsUiBlue.checked = load("uiBlue", true);
  el.vsUiBlue.addEventListener("change", () => {
    save("uiBlue", el.vsUiBlue.checked);
    logger.push(
      `<span class="tag">게임 중인지 판단</span> ` +
        (el.vsUiBlue.checked ? "파란 창이 보이면 게임 아님" : "움직임만 보고 판단 (예전 방식)")
    );
  });
  el.vsUiThr.value = load("uiThr", 15);
  el.vsUiThr.addEventListener("change", () => save("uiThr", Number(el.vsUiThr.value)));
  el.vsUiLearn.addEventListener("click", () => {
    if (!stream) {
      logger.push('<span class="bad">화면 공유(또는 테스트 영상)를 먼저 켜주세요</span>');
      return;
    }
    learnColorAsk = "manual";
  });
  el.vsUiForget.addEventListener("click", () => {
    uiColor = null;
    save("uiColor", null);
    renderUiColor();
    logger.push('<span class="tag">창 색</span> 잊었습니다 — 다시 파란 계열 전부를 창 후보로 봅니다');
  });
  renderUiColor();

  el.vsBlindMode.value = load("blindMode", "off");
  el.vsBlindMode.addEventListener("change", () => {
    save("blindMode", el.vsBlindMode.value);
    logger.push(`<span class="tag">블라인드</span> ${el.vsBlindMode.selectedOptions[0].textContent} — 다음 판부터 적용됩니다`);
  });
  el.vsProbeBtn.addEventListener("click", runProbe);
  el.vsDemoPause.addEventListener("click", () => {
    demoPaused = !demoPaused;
    el.vsDemoPause.textContent = demoPaused ? "테스트 영상 다시 움직이기" : "테스트 영상 멈추기 (레벨업처럼)";
  });

  el.vsGoal.value = load("goal", "");
  el.vsGoal.addEventListener("change", () => {
    save("goal", el.vsGoal.value);
    el.vsGoalState.textContent = el.vsGoal.value.trim() ? "목표 있음" : "목표 없음";
  });
  el.vsGoalRepeat.checked = load("goalRepeat", false);
  el.vsGoalRepeat.addEventListener("change", () => save("goalRepeat", el.vsGoalRepeat.checked));
  el.vsGoalState.textContent = el.vsGoal.value.trim() ? "목표 있음" : "목표 없음";

  el.vsRemoteCode.addEventListener("click", () => renderRemote("remote_code"));
  el.vsRemoteRevoke.addEventListener("click", () => {
    if (confirm("연결한 기기를 모두 끊을까요? 폰에서 다시 보려면 연결 코드를 새로 넣어야 합니다.")) {
      renderRemote("remote_revoke");
    }
  });
  // 메뉴를 열 때마다 새로 묻는다 (지금 보는 폰이 있는지 등)
  document.querySelector('.vs-menu-btn[data-sec="remote"]')?.addEventListener("click", () => renderRemote());

  el.vsOcrOn.checked = load("ocrOn", true);
  el.vsOcrOn.addEventListener("change", () => save("ocrOn", el.vsOcrOn.checked));
  el.vsOcrWords.value = load("ocrWords", OCR_WORDS_DEFAULT);
  el.vsOcrWords.addEventListener("change", () => save("ocrWords", el.vsOcrWords.value));
  el.vsOcrNow.addEventListener("click", async () => {
    if (!stream) {
      el.vsOcrResult.textContent = "화면 공유(또는 테스트 영상)를 먼저 켜주세요";
      return;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) {
        el.vsOcrResult.textContent = "브릿지에 연결하지 못했습니다";
        return;
      }
    }
    el.vsOcrResult.textContent = "읽는 중...";
    showOcr(await ocrRead(gameRect), "지금 화면");
  });

  el.vsIdOn.checked = load("idOn", false);
  el.vsIdOn.addEventListener("change", () => {
    save("idOn", el.vsIdOn.checked);
    if (el.vsIdOn.checked) warmModel();
  });
  el.vsLlmOn.addEventListener("change", () => {
    if (el.vsLlmOn.checked) warmModel();
  });

  // 설정을 바꾸면 그 전 판 기록과는 비교가 안 되므로 따로 지울 수 있게 둔다
  document.getElementById("vsClearRuns").addEventListener("click", () => {
    history = [];
    save("runs", history);
    readLog = [];
    save("readLog", readLog);
    renderReadLog();
    renderRuns();
    logger.push('<span class="dim">판 기록을 지웠습니다</span>');
  });

  el.vsRun.disabled = true;
  setStatus("화면 공유를 먼저 시작하세요", "");
  renderMarks();
  renderHints();
  renderReadLog();
  renderRegions();
  renderBlindStats();
  showSection(load("menu", "monitor"));
  renderTeachButtons();
  renderRuns();
  renderMenuStats();
  el.vsAlphaVal.textContent = `${el.vsAlpha.value}%`;
})();
