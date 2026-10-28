// 농부는 대체되었다 (The Farmer Was Replaced)
// 이 게임은 뉴런 학습을 쓰지 않는다. 화면을 읽고(OCR) LLM 이 추론하는 것이 전부다.
//
// 화면 확인 순서
//   1. 공유 화면에서 한 장 뜬다
//   2. 브릿지의 윈도우 내장 OCR 로 글자를 읽는다
//   3. 글자에서 화면별 단서 단어를 세어 규칙으로 먼저 추정한다 (LLM 이 없거나 실패해도 답이 있게)
//   4. LLM 에게 그림 + OCR 글자 + 아래 화면 목록을 주고 JSON 으로 판단을 받는다
//   5. LLM 답이 멀쩡하면 그것을, 아니면 규칙 추정을 최종으로 쓴다. 둘이 다르면 로그에 표시한다
//
// 문법 사전 (매뉴얼 메뉴)
//   이 게임은 파이썬 비슷한 자기만의 언어로 드론을 움직인다. 몰리는 화면(특히 설명서·코드 창)을 볼 때마다
//   함수·상수·아이템·문법을 주워서 사전에 쌓는다. 바깥 지식이 아니라 '화면에서 본 것'만 담는다.
//   - OCR 규칙: 코드에서 name( 꼴은 함수, Entities.X 같은 것은 상수로 줍는다. 뜻은 모른다
//   - LLM: 이름·종류·형태·뜻·예시와 '어디서 봤는지'를 받는다
//   사전은 브릿지가 game/knowledge/farm_dict.json 에 저장한다.
//   배운 단어와 마지막으로 본 화면 정보는 다음 추론 때 프롬프트에 그대로 밀어 넣는다 (배운 것을 바로 쓴다).
//
// 자율 플레이
//   보기(캡처+OCR) → LLM 이 상황 판단 + 행동 하나 고르기 → 브릿지가 실행 → 다시 보기 … 를 되풀이한다.
//   LLM 은 화면 좌표를 정확히 찍지 못하므로, OCR 이 찾은 글자 줄에 번호를 붙여 '몇 번을 누를지'로 고르게 한다.
//   글자가 없는 아이콘만 비율 좌표(click_at)로 누른다. ESC 를 누르면 브릿지가 막고 루프도 멈춘다.
//
// 마우스 클릭: 좌표는 공유 화면 안의 비율(0~1)로 보내고, 브릿지가 대상 창에 맞춰 화면 좌표로 바꾼다.
// ESC 는 브릿지가 전역으로 감시한다. 눌리면 입력을 막고 { halted: true } 를 보낸다.

// 화면 목록. 규칙 추정, LLM 프롬프트, 매뉴얼 페이지가 모두 이 표 하나를 쓴다.
// 단서(cues)는 OCR 이 한글/영어 어느 쪽으로 읽어도 걸리도록 둘 다 적는다. 소문자로 비교한다.
const FARM_SCREENS = [
  {
    id: "title",
    name: "타이틀 메뉴",
    look: "게임 제목과 시작·계속·설정·종료 같은 큰 메뉴 버튼만 있다. 밭이나 코드 창은 없다.",
    cues: ["the farmer was replaced", "농부는 대체되었다", "continue", "new game", "quit", "계속하기", "새 게임", "게임 종료"],
  },
  {
    id: "play",
    name: "농장 (플레이)",
    look: "격자 모양 밭과 드론이 보이고, 코드가 적힌 창(편집기)이 하나 이상 떠 있다. 위쪽에 자원 수량이 보인다.",
    cues: ["harvest", "move(", "while", "plant(", "till(", "can_harvest", "north", "east", "south", "west", "def ", "수확"],
  },
  {
    id: "unlock",
    name: "해금 · 업그레이드",
    look: "해금할 항목이 나무/목록 모양으로 늘어서 있고, 항목마다 필요한 자원과 비용이 적혀 있다.",
    cues: ["unlock", "upgrade", "잠금 해제", "해금", "업그레이드", "cost", "비용", "speed", "expand", "확장"],
  },
  {
    id: "docs",
    name: "게임 내 설명서",
    look: "정보 창(설명서). '일반 정보 / 프로그래밍 / 해금 / 내장 함수 / 아이템' 같은 제목 아래 밑줄 친 항목(링크)이 늘어서 있거나, 항목 하나를 설명하는 글이 보인다. 밭과 코드 창이 뒤에 같이 보일 수 있다.",
    // 실제 게임 정보 창의 제목들 (2026-10-28 화면에서 확인)
    cues: ["일반 정보", "프로그래밍", "내장 함수", "아이템", "첫 번째 프로그램", "외부 에디터", "주석",
      "general info", "built-in functions", "getting started", "first program", "external editor", "comments", "credits",
      "documentation", "returns", "parameters", "반환", "예시"],
  },
  {
    id: "menu",
    name: "일시정지 · 설정",
    look: "게임 위에 어두운 막이 깔리고 재개·설정·저장·메인 메뉴 같은 버튼이 있다.",
    cues: ["resume", "settings", "options", "save", "main menu", "재개", "설정", "저장", "메인 메뉴", "volume", "음량"],
  },
  {
    id: "loading",
    name: "로딩",
    look: "거의 빈 화면이거나 로딩 표시만 있다.",
    cues: ["loading", "로딩", "불러오는 중"],
  },
  {
    id: "other",
    name: "모름",
    look: "위 어느 것에도 맞지 않는다. 게임 창이 아닌 다른 화면일 수도 있다.",
    cues: [],
  },
];

// 화면에서 뽑으려는 정보. LLM 에게 이 키로 답하라고 시키고, 매뉴얼에도 그대로 보여준다.
const FARM_FACTS = [
  ["resources", "자원", "위쪽에 보이는 자원 이름과 수량 (건초, 나무, 당근 …)"],
  ["code_windows", "코드 창", "열려 있는 코드 창의 이름과 대략 무슨 코드인지"],
  ["running", "실행 중?", "코드가 지금 돌고 있는지 (실행/정지 버튼 상태, 드론이 움직이는 중인지)"],
  ["farm_size", "밭 크기", "밭 격자의 칸 수 (예: 3x3)"],
  ["errors", "오류", "화면에 보이는 오류 메시지"],
  ["choices", "고를 수 있는 것", "누를 수 있는 버튼·해금 항목 이름"],
];

// 사전 항목 종류
const TERM_KINDS = {
  function: "함수",
  constant: "상수",
  entity: "개체",
  item: "아이템",
  ground: "땅",
  keyword: "키워드",
  syntax: "문법",
  ui: "화면 조작",
  unlock: "해금",
  topic: "설명서 주제",
  other: "기타",
};

// 사용자가 직접 알려준 화면 조작. 매 판단마다 LLM 에 넘기고, 매뉴얼(사전)에도 '사용자가 알려줌'으로 넣어 둔다.
// 아이콘이라 OCR 로는 안 읽히므로 대략의 위치(where)를 같이 적는다.
const FARM_UI_HINTS = [
  {
    name: "+ 버튼",
    where: "화면 오른쪽 위",
    meaning: "누르면 새 코드 창이 추가된다",
    button: "add",
    prompt: '"add": the "+" icon at the top-right — adds a new code window.',
  },
  {
    name: "i 버튼",
    where: "화면 오른쪽 위",
    meaning: "누르면 정보 창(게임 설명서)이 뜬다. 함수·문법을 배우기 좋다",
    button: "info",
    prompt: '"info": the "i" icon at the top-right — opens the info window (in-game documentation). If the info window is ALREADY open, do not press it again; click a topic link inside it instead.',
  },
];
// 절대 누르지 않는 글자. 10-28 에 봇이 메인 메뉴로 나간 뒤 Quit 을 눌러 게임을 꺼버렸다.
// 프롬프트에서는 번호를 지우고, 골라도 실행하지 않는다.
const FORBIDDEN_TEXT = /\b(quit|exit|main menu|back to menu|title screen|close game|log ?out)\b|종료|나가기|메인 ?메뉴|타이틀로|끝내기/i;

// Entities.Bush 의 앞부분으로 종류를 짐작한다
const PREFIX_KIND = { entities: "entity", items: "item", grounds: "ground" };
const PY_KEYWORDS = ["while", "for", "if", "elif", "else", "def", "return", "break", "continue", "import", "and", "or", "not", "in", "pass", "global"];
const DIRECTIONS = ["North", "East", "South", "West"];

(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    view: $("fmView"), status: $("fmStatus"), share: $("fmShare"), run: $("fmRun"), stop: $("fmStop"),
    window: $("fmWindow"), bridge: $("fmBridge"), live: $("fmLive"), last: $("fmLast"),
    check: $("fmCheck"), auto: $("fmAuto"), every: $("fmEvery"), model: $("fmModel"),
    screen: $("fmScreen"), conf: $("fmConf"), source: $("fmSource"), took: $("fmTook"),
    lang: $("fmLang"),
    info: $("fmInfo"), ocr: $("fmOcr"), manual: $("fmManual"),
    agentBar: $("fmAgentBar"), agentStepEl: $("fmAgentStep"), agentPhase: $("fmAgentPhase"), agentGoal: $("fmAgentGoal"), agentStop2: $("fmAgentStop2"),
    goal: $("fmGoal"), agentRun: $("fmAgentRun"), agentStop: $("fmAgentStop"), maxSteps: $("fmMaxSteps"), agentState: $("fmAgentState"),
  };
  if (!el.view) return;
  const ctx = el.view.getContext("2d");
  const video = document.createElement("video");
  video.muted = true;
  const logger = createLogger("fmLog", { max: 120 });
  const dictEl = {};
  const byId = Object.fromEntries(FARM_SCREENS.map((s) => [s.id, s]));
  const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  let stream = null;
  let ws = null;
  let running = false;
  let checking = false;
  let checkNo = 0;
  let lastScreen = null;
  // 누른 자리를 공유 화면 위에 잠깐 표시한다 (좌표가 맞는지 눈으로 보려고)
  const marks = [];
  let showLayout = null; // 자율 중 공유 화면 위에 그릴 창·밭 상자 (1초마다 다시 잰다)
  setInterval(() => {
    if (agentOn && stream && video.videoWidth) showLayout = analyzeLayout();
  }, 1000);
  function mark(fx, fy, ok, label) {
    // 같은 자리에 이름표가 겹치지 않게, 같은 자리 표시는 새 것으로 바꾼다
    for (let i = marks.length - 1; i >= 0; i--) if (Math.abs(marks[i].fx - fx) < 0.005 && Math.abs(marks[i].fy - fy) < 0.005) marks.splice(i, 1);
    marks.push({ fx, fy, ok, label, until: performance.now() + 4000 });
    if (marks.length > 12) marks.shift();
  }
  // 자율 플레이 상태
  // phase: 지금 무엇을 하는 중인지. 화면 위 띠와 공유 화면 테두리에 보인다.
  let phase = { text: "", since: 0 };
  function setPhase(text) {
    phase = { text, since: performance.now() };
    showPhase();
  }
  function showPhase() {
    if (!agentOn) return;
    const sec = Math.floor((performance.now() - phase.since) / 1000);
    el.agentPhase.textContent = phase.text + (sec >= 1 ? ` ${sec}초째` : "");
  }
  setInterval(showPhase, 250);
  let agentOn = false;
  let agentStep = 0;
  let history = [];
  let reqId = 0;
  const pending = new Map();

  const load = (k, d) => {
    try {
      return localStorage.getItem("molli.farm." + k) ?? d;
    } catch (e) {
      return d;
    }
  };
  const save = (k, v) => {
    try {
      localStorage.setItem("molli.farm." + k, v);
    } catch (e) {}
  };

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = "vs-status" + (kind ? " " + kind : "");
  }

  // ---- 브릿지 ----
  function connectBridge() {
    return new Promise((resolve) => {
      try {
        ws = new WebSocket(`ws://${location.hostname}:8744`);
      } catch (e) {
        el.bridge.textContent = "연결 실패";
        return resolve(false);
      }
      ws.onopen = () => {
        el.bridge.textContent = "연결됨";
        loadModels();
        loadDict();
        resolve(true);
      };
      ws.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch (e) {
          return;
        }
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
        if (m.live !== undefined) el.live.textContent = m.live ? "실제 입력" : "안전모드";
        if (m.halted && (running || agentOn)) {
          running = false;
          agentStop("ESC");
          setStatus("ESC 로 정지됨 — 다시 하려면 시작을 누르세요", "bad");
        }
      };
      ws.onclose = () => {
        el.bridge.textContent = "끊김";
        el.live.textContent = "-";
        ws = null;
        running = false;
        agentStop("브릿지 연결이 끊김");
      };
      ws.onerror = () => {
        el.bridge.textContent = "연결 실패 (브릿지 확인)";
        resolve(false);
      };
      setTimeout(() => resolve(false), 2500);
    });
  }

  const connected = () => ws && ws.readyState === WebSocket.OPEN;
  const ensureBridge = async () => connected() || (await connectBridge());

  // 실제 입력(클릭·끌기·스크롤·키·글자)이 나갈 때마다 '무엇을 왜' 와 그 자리 사진을 로그에 남긴다.
  // 10-28: "지금 대체 뭘 클릭하는 건지 모르겠다". 호출하는 쪽이 payload.why 에 이름표를 단다 (브릿지는 무시한다).
  const INPUT_KINDS = { click: "🖱", drag: "✋", scroll: "🖱", key: "⌨", type: "⌨", paste: "📋" };
  function snapshot(fx, fy) {
    const W = video.videoWidth, H = video.videoHeight;
    if (!W) return "";
    const cw = Math.round(W * 0.14), ch = Math.round(H * 0.1);
    const c = document.createElement("canvas");
    c.width = 224;
    c.height = Math.round((224 * ch) / cw);
    const g = c.getContext("2d");
    g.drawImage(video, fx * W - cw / 2, fy * H - ch / 2, cw, ch, 0, 0, c.width, c.height);
    g.strokeStyle = "#ff3b30";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(c.width / 2 - 14, c.height / 2); g.lineTo(c.width / 2 + 14, c.height / 2);
    g.moveTo(c.width / 2, c.height / 2 - 14); g.lineTo(c.width / 2, c.height / 2 + 14);
    g.stroke();
    return c.toDataURL("image/jpeg", 0.7);
  }
  function logInput(payload) {
    const icon = INPUT_KINDS[payload.type];
    if (!icon) return;
    const label = payload.why || payload.type;
    const fx = payload.x ?? payload.x1, fy = payload.y ?? payload.y1;
    const where = fx != null ? ` <span class="dim">(${Math.round(fx * 100)}%, ${Math.round(fy * 100)}%)</span>` : "";
    const extra = payload.type === "paste" || payload.type === "type" ? ` <span class="dim">${esc(String(payload.text).slice(0, 80).replace(/\n/g, " ⏎ "))}</span>` : "";
    const shot = fx != null && stream ? `<br /><img class="click-shot" src="${snapshot(fx, fy)}" alt="" />` : "";
    logger.push(`<span class="tag">${icon} ${stamp()}</span> <b>${esc(label)}</b>${where}${extra}${shot}`);
    if (fx != null) mark(fx, fy, null, label);
  }

  function ask(payload, timeoutMs = 3000) {
    logInput(payload);
    return new Promise((resolve) => {
      if (!connected()) return resolve({ error: "브릿지 미연결" });
      const id = `f${++reqId}`;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ ...payload, id }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({ error: "응답 시간 초과" });
        }
      }, timeoutMs);
    });
  }

  async function loadModels() {
    const res = await ask({ type: "llm_models" }, 8000);
    if (res.error || !res.models?.length) {
      el.model.innerHTML = '<option value="">모델 없음 — 규칙 추정만 씁니다</option>';
      logger.push(`<span class="bad">LLM 모델 목록을 못 받았습니다: ${esc(res.error || "설치된 모델 없음")}</span> <span class="dim">— 화면 확인은 OCR 규칙만으로 합니다</span>`);
      return;
    }
    const saved = load("model", "gemma3:12b");
    el.model.innerHTML =
      '<option value="">쓰지 않음 (규칙만)</option>' +
      res.models.map((m) => `<option${m === saved ? " selected" : ""}>${esc(m)}</option>`).join("");
  }

  // ---- 화면 ----
  async function share() {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch (e) {
      return setStatus("화면 공유가 취소됐습니다", "bad");
    }
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      stream = null;
      running = false;
      setStatus("화면 공유가 끝났습니다", "");
    });
    setStatus("공유 중 — '화면 확인'을 누르세요", "");
    ensureBridge();
  }

  function draw() {
    if (stream && video.videoWidth) {
      if (el.view.width !== video.videoWidth) {
        el.view.width = video.videoWidth;
        el.view.height = video.videoHeight;
      }
      ctx.drawImage(video, 0, 0);
    }
    const now = performance.now();
    if (agentOn) {
      // 자율 중에는 화면 둘레에 깜빡이는 테두리와 지금 하는 일을 띄운다
      const t = Math.max(4, el.view.width / 200);
      ctx.strokeStyle = `rgba(240,180,41,${0.55 + 0.45 * Math.sin(now / 250)})`;
      ctx.lineWidth = t;
      ctx.strokeRect(t / 2, t / 2, el.view.width - t, el.view.height - t);
      const fs = Math.max(16, el.view.width / 60);
      ctx.font = `${fs}px NeoDunggeunmo, monospace`;
      const label = `● 자율 ${agentStep}걸음 · ${el.agentPhase.textContent}`;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(t, t, ctx.measureText(label).width + fs, fs * 1.6);
      ctx.fillStyle = "#f0b429";
      ctx.fillText(label, t + fs / 2, t + fs * 1.15);
    }
    if (agentOn && showLayout) {
      ctx.lineWidth = Math.max(2, el.view.width / 600);
      ctx.setLineDash([8, 6]);
      if (showLayout.field) {
        const f = showLayout.field;
        ctx.strokeStyle = "#8fd16a";
        ctx.strokeRect(f.x * el.view.width, f.y * el.view.height, f.w * el.view.width, f.h * el.view.height);
      }
      ctx.strokeStyle = "#7fb2ff";
      showLayout.windows.forEach((r, i) => {
        ctx.strokeRect(r.x * el.view.width, r.y * el.view.height, r.w * el.view.width, r.h * el.view.height);
        ctx.fillStyle = "#7fb2ff";
        ctx.fillText(r.name || "?", r.x * el.view.width + 6, (r.y + r.barH) * el.view.height + 22);
      });
      ctx.setLineDash([]);
    }
    while (marks.length && marks[0].until < now) marks.shift();
    for (const m of marks) {
      const x = m.fx * el.view.width, y = m.fy * el.view.height;
      const r = Math.max(10, el.view.width / 80);
      ctx.strokeStyle = m.ok === true ? "#8fd16a" : m.ok === false ? "#ef6a5a" : "#f0b429";
      ctx.lineWidth = Math.max(2, el.view.width / 480);
      ctx.beginPath();
      ctx.moveTo(x - r, y); ctx.lineTo(x + r, y);
      ctx.moveTo(x, y - r); ctx.lineTo(x, y + r);
      ctx.stroke();
      ctx.strokeRect(x - r / 2, y - r / 2, r, r);
      if (m.label) {
        // 이름표는 검은 바탕 위에 크게 — 무엇을 누르는지 멀리서도 읽히게
        const fs = Math.max(18, el.view.width / 70);
        ctx.font = `${fs}px NeoDunggeunmo, monospace`;
        const tw = ctx.measureText(m.label).width;
        const lx = Math.min(x + r + 6, el.view.width - tw - 10), ly = Math.max(fs + 6, y - 6);
        ctx.fillStyle = "rgba(0,0,0,0.8)";
        ctx.fillRect(lx - 4, ly - fs, tw + 8, fs * 1.3);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(m.label, lx, ly);
      }
    }
    requestAnimationFrame(draw);
  }

  // 지금 프레임을 JPEG base64 로. LLM 에 보낼 것은 가로 1280 으로 줄인다 (보내는 양·추론 시간).
  // scale 을 주면 그 배율로 키운다 (OCR 은 2배로 키운 것이 코드 글꼴을 훨씬 잘 읽는다)
  function grab(maxW, scale = 1) {
    const w = video.videoWidth, h = video.videoHeight;
    const k = maxW && w > maxW ? maxW / w : scale;
    const c = document.createElement("canvas");
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9).split(",")[1];
  }

  // ---- 판단 ----
  // OCR 글자에서 화면별 단서를 센다. 가장 많이 걸린 화면이 규칙 추정.
  function ruleGuess(lines) {
    const text = lines.map((l) => l.text).join("\n").toLowerCase();
    let best = { id: lines.length ? "other" : "loading", hits: [], score: 0 };
    for (const s of FARM_SCREENS) {
      const hits = s.cues.filter((c) => text.includes(c));
      if (hits.length > best.score) best = { id: s.id, hits, score: hits.length };
    }
    // 단서 하나는 우연히 걸리기 쉽다 (예: 'save' 는 코드 주석에도 나온다)
    best.conf = best.score >= 3 ? 0.7 : best.score === 2 ? 0.5 : best.score === 1 ? 0.3 : 0.1;
    return best;
  }

  // 지금까지 배운 것. 많이 본 단어부터 80개까지만 (프롬프트가 너무 길어지지 않게)
  // 지금 정보 창이 열려 있나 (check 가 OCR 규칙으로 정해 둔다). 열려 있으면 info 버튼은 선택지에서 뺀다.
  let docsOpenNow = false;
  const hintsNow = () => FARM_UI_HINTS.filter((h) => !(docsOpenNow && h.button === "info"));

  function knowledgeBlock() {
    const terms = Object.values(dict.entries)
      .sort((a, b) => !!b.meaning - !!a.meaning || b.seen - a.seen)
      .slice(0, 80)
      .map((e) => `- ${e.signature && !e.signature.endsWith("(…)") ? e.signature : e.name} [${e.kind}]${e.meaning ? ": " + e.meaning : ""}${e.example ? "  e.g. " + e.example.replace(/\n/g, " ⏎ ") : ""}`);
    const st = dict.state;
    const done = (dict.pagesRead || []).slice(-30);
    const facts = st?.facts?.length ? st.facts.map((f) => `- ${f.key}: ${f.value}`).join("\n") : "(none yet)";
    const ui = hintsNow().map((h) => `- ${h.prompt}`).join("\n");
    const names = hintsNow().map((h) => h.button).join("|");
    return `${stream && video.videoWidth ? layoutBlock() + "\n\n" : ""}Screen controls the user told you (always true):
${ui}
These are icons without text. Press them with {"type": "button", "name": "<${names}>"} — the program knows where they are.
${docsOpenNow ? `THE INFO WINDOW IS OPEN RIGHT NOW. Do not open it again. To learn, click one of its underlined link names
(use its OCR line number), read the page, then use the back arrow at the window's top-left to return to the index.
Section HEADINGS (General Info, Programming, Unlocks, Built-in Functions, Items) are NOT links — click a name UNDER a heading,
e.g. a function name under Built-in Functions.
` : ""}

${done.length ? `Docs pages you have ALREADY READ to the end (do not open them again, pick another link): ${done.join(", ")}\n\n` : ""}What you have learned so far from earlier screens (trust it, but the current screen wins if they differ):
Vocabulary (${terms.length} of ${Object.keys(dict.entries).length}):
${terms.join("\n") || "(nothing yet)"}
Last known state (${st ? st.screen + ", " + st.at : "none"}):
${facts}`;
  }

  function agentBlock(n) {
    const steps = history.length
      ? history.map((h) => `${h.step}. [${h.screen}] ${h.plan} -> ${h.action} -> ${h.result}`).join("\n")
      : "(this is the first step)";
    return `
You are also PLAYING the game autonomously. Goal (from the user, in Korean): ${el.goal.value.trim() || "게임을 진행한다"}
This is step ${n}. Your recent steps, oldest first:
${steps}

Choose exactly ONE next action:
- {"type": "click", "target": <number of an OCR line above>, "button": "left"}   ← prefer this, it is precise
- {"type": "button", "name": "<${hintsNow().map((h) => h.button).join(" or ")}>"}   ← the known top-right icons (see screen controls above)
- {"type": "click_at", "x": <0..1>, "y": <0..1>, "button": "left"}   ← only for other icons with no text, OUTSIDE window bodies; fraction of the screenshot
- {"type": "move_window", "window": "<window name>"}   ← moves that window off the field
- {"type": "close_window", "window": "<window name>"}   ← presses that window's ✕ (for windows you do not need)
- {"type": "back"}   ← presses the back arrow at the top-left of the info window (return to the docs index)
- {"type": "code", "window": "<code window name, e.g. f0>", "text": "<the WHOLE code for that window>"}   ← replaces the window's code, checks it was written correctly, then presses ▶ to run it and reports what happened. Write a little, run, look at the result, then improve
- {"type": "run", "window": "<code window name>"}   ← presses ▶ on that window without changing its code   ← clicks INTO that code window's editor area (below its top bar) and types the code. Use \n for new lines
- {"type": "scroll", "target": <OCR line number inside the list/window to scroll>, "direction": "down" or "up", "amount": <1..10>}
   ← to see more of a long list, documentation or code. The mouse must be over the thing to scroll, so pick a line inside it
     (or use "x"/"y" fractions instead of "target"). If scrolling did not change anything, you reached the end
- {"type": "type", "text": "<text>"}   ← types into whatever has keyboard focus; click into the editor first. Use \\n for new lines
- {"type": "key", "key": "<one of: enter, tab, backspace, delete, up, down, left, right, home, end, pageup, pagedown, ctrl+a, ctrl+c, ctrl+v, ctrl+x, ctrl+z, ctrl+s>"}
- {"type": "wait", "seconds": <1..10>}   ← when the drone is running and you just need to watch
- {"type": "done", "why": "<Korean>"}   ← only when the goal is reached or impossible
NEVER leave the game: do not quit, exit, go to the main menu, or close the game window. Lines marked [XX] are forbidden.
Rules: if the previous action did not change the screen, do something different. Never repeat the same failing action 3 times.
In code, only use functions and names you have seen on screen or in your vocabulary. Reading the in-game documentation is a good way to learn.
The JSON answer MUST start with "plan", "action" and "expect" (see the JSON format above).`;
  }

  // 단어 수집은 코드·설명서가 보일 때만 시킨다. 답이 길수록 느려서, 평소에는 판단·행동만 받는다.
  function wantTerms(lines) {
    const g = ruleGuess(lines).id;
    return g === "docs" || g === "play" || ruleTerms(lines).length > 0 || lines.some((l) => /[a-z]+_[a-z_]+/.test(l.text));
  }

  function buildPrompt(lines, agentN, terms) {
    const screens = FARM_SCREENS.map((s) => `- ${s.id}: ${s.look}`).join("\n");
    const facts = FARM_FACTS.map(([k, , d]) => `  "${k}": ${d}`).join("\n");
    // 정보 창이 열려 있으면 섹션 제목은 번호를 지운다. 제목은 링크가 아닌데 모델이 자꾸 제목을 누르려 해서.
    const ocr = lines.length
      ? lines
          .map((l, i) =>
            FORBIDDEN_TEXT.test(l.text)
              ? `[XX] ${l.text}   (FORBIDDEN — never click)`
              : docsOpenNow && isDocHeading(l.text)
                ? `[--] ${l.text}   (section heading — not clickable)`
                : l.inPicture
                  ? `[--] ${l.text}   (text inside a PICTURE in the docs — not a real window, not clickable)`
                  : l.windowName
                  ? `[--] ${l.text}   (a window's NAME on its top bar — clicking it renames the file. To write code, use the "code" action)`
                  : plainInWindow(l)
                  ? `[--] ${l.text}   (plain text in a window — not clickable)`
                  : `[${i}] ${l.text}${l.inBody && l.link ? "   (green link)" : ""}`
          )
          .join("\n")
      : "(no text found)";
    return `You are looking at a screenshot of the game "The Farmer Was Replaced" (Korean title: 농부는 대체되었다).
In this game the player writes Python-like code in editor windows to control a drone that farms a grid.

Decide which screen this is. Choose exactly one id:
${screens}

Text read from the screen by OCR, one numbered line each (may contain mistakes):
"""
${ocr}
"""

${knowledgeBlock()}

Then list what you can actually see — at most 5 items, each value under 40 characters. Use these keys when they apply:
${facts}
${terms ? `
Also collect vocabulary of the game's programming language that is VISIBLE on this screen:
functions, constants, entities, items, ground types, keywords and syntax rules.
Read documentation / info windows and code windows carefully. If the info window's index is visible, list EVERY name
shown under "Built-in Functions" (kind function), "Items" (kind item) and "Unlocks" (kind other), exactly as written.
Do NOT add anything from your own knowledge
of the game or of Python — only what this screen shows. If the screen shows no such terms, return an empty list.
kind must be one of: ${Object.keys(TERM_KINDS).join(", ")}.
List at most 8 terms, and ONLY terms that are new or where this screen tells you more than your vocabulary above.
` : `
Do not list vocabulary this time ("terms": []).
`}
Keep every sentence short. No explanations outside the JSON.

Answer with JSON only, no other text:
{${agentN ? `"plan": "<Korean, one short sentence: what is going on and why this action>",
 "action": {"type": "...", ...one of the actions listed below...},
 "expect": "<Korean, a few words: what should change on screen>",
 ` : ""}"screen": "<id>", "confidence": <0..1>, "reason": "<one short sentence in Korean: what on screen made you decide>",
 "facts": [{"key": "<key>", "value": "<what you saw, in Korean>", "from": "<the OCR line you used, or \\"그림\\" if you saw it in the image>"}],
 "terms": [{"name": "<exactly as written, e.g. move or Entities.Bush>", "kind": "<kind>",
            "signature": "<how it is written/called, e.g. move(direction), or empty>",
            "meaning": "<what it does, in Korean, only if the screen explains it, else empty>",
            "example": "<a short code example shown on screen, or empty>",
            "from": "<the OCR line you used, or \\"그림\\">"}]}
${agentN ? agentBlock(agentN) : ""}`;
  }

  function parseJson(text) {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const o = JSON.parse(m[0]);
      return byId[o.screen] ? o : null;
    } catch (e) {
      return null;
    }
  }

  // ---- 문법 사전 ----
  let dict = { game: "The Farmer Was Replaced", updated: null, entries: {} };
  const keyOf = (name) => String(name).trim().toLowerCase();

  // LLM 없이 OCR 글자만으로 줍는 것. 뜻은 모르고 '이런 이름이 이렇게 쓰였다'까지만.
  function ruleTerms(lines) {
    const out = new Map();
    const add = (name, kind, from, signature = "") => {
      if (!out.has(keyOf(name))) out.set(keyOf(name), { name, kind, signature, meaning: "", example: "", from });
    };
    for (const { text } of lines) {
      for (const m of text.matchAll(/\b(Entities|Items|Grounds|Unlocks|Hats|Leaderboards)\.([A-Z][A-Za-z0-9_]+)/g)) {
        add(`${m[1]}.${m[2]}`, PREFIX_KIND[m[1].toLowerCase()] || "constant", text);
      }
      for (const m of text.matchAll(/\b([a-z_][a-z0-9_]{2,})\s*\(/g)) {
        // def 로 만든 것은 플레이어 코드라 게임 문법이 아니다
        if (PY_KEYWORDS.includes(m[1]) || new RegExp(`def\\s+${m[1]}\\b`).test(text)) continue;
        add(m[1], "function", text, `${m[1]}(…)`);
      }
      for (const d of DIRECTIONS) if (new RegExp(`\\b${d}\\b`).test(text)) add(d, "constant", text);
      for (const k of ["while", "for", "if", "def"]) {
        if (new RegExp(`^\\s*${k}\\b.*:\\s*$`).test(text)) add(k, "keyword", text);
      }
    }
    return [...out.values()];
  }

  // 한 번의 확인에서 주운 단어들을 사전에 합친다. 무엇이 새로 들어오고 바뀌었는지 돌려준다.
  function learn(terms, how, ctx) {
    const report = { added: [], filled: [], changed: [] };
    for (const t of terms) {
      if (!t || !t.name || String(t.name).length > 60) continue;
      const k = keyOf(t.name);
      const kind = TERM_KINDS[t.kind] ? t.kind : "other";
      const src = { at: ctx.at, check: ctx.n, screen: ctx.screen, how, from: String(t.from || "").slice(0, 200) };
      let e = dict.entries[k];
      if (!e) {
        e = dict.entries[k] = {
          name: String(t.name).trim(), kind, kindGuess: how !== "LLM",
          signature: t.signature || "", meaning: t.meaning || "", example: t.example || "",
          seen: 0, first: ctx.at, last: ctx.at, sources: [], changes: [],
        };
        report.added.push(e);
      } else {
        // OCR 규칙으로 짐작한 종류는 LLM 이 말하면 조용히 고친다
        if (how === "LLM" && e.kindGuess && kind !== "other") {
          e.kind = kind;
          e.kindGuess = false;
        }
        for (const f of ["signature", "meaning", "example"]) {
          const v = String(t[f] || "").trim();
          if (!v || v === e[f]) continue;
          // 규칙이 만든 'name(…)' 형태는 진짜 형태가 오면 그냥 덮는다
          const placeholder = f === "signature" && e[f].endsWith("(…)");
          if (!e[f] || placeholder) {
            e[f] = v;
            if (!report.filled.includes(e)) report.filled.push(e);
          } else if (how === "LLM") {
            e.changes.unshift({ at: ctx.at, check: ctx.n, field: f, old: e[f], now: v });
            e.changes.length = Math.min(e.changes.length, 10);
            e[f] = v;
            report.changed.push({ e, f });
          }
        }
      }
      e.seen++;
      e.last = ctx.at;
      // 같은 줄을 반복해서 본 기록은 쌓지 않는다
      if (!e.sources.some((x) => x.from === src.from && x.how === how)) {
        e.sources.unshift(src);
        e.sources.length = Math.min(e.sources.length, 8);
      }
    }
    if (report.added.length || report.filled.length || report.changed.length) {
      dict.updated = ctx.at;
      saveDict();
    }
    return report;
  }

  let saveTimer = null;
  function saveDict() {
    save("dict", JSON.stringify(dict));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!connected()) return;
      const r = await ask({ type: "kb_save", dict }, 5000);
      if (r.error) logger.push(`<span class="bad">사전을 파일에 저장하지 못했습니다: ${esc(r.error)}</span> <span class="dim">(브라우저에는 남아 있습니다)</span>`);
    }, 1000);
    renderDict();
  }

  // 브릿지 파일과 브라우저에 남은 것 중 더 최근 것을 쓴다
  async function loadDict() {
    let local = null;
    try {
      local = JSON.parse(load("dict", "null"));
    } catch (e) {}
    const r = connected() ? await ask({ type: "kb_load" }, 5000) : {};
    const file = r.dict?.entries ? r.dict : null;
    const pick = [file, local].filter((d) => d && d.entries).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0];
    if (pick) dict = pick;
    seedUiHints();
    renderDict();
  }

  // 사용자가 알려준 조작을 사전에 넣는다. 이미 있으면 뜻만 맞춰 둔다 (사용자 말이 화면 추측보다 우선).
  function seedUiHints() {
    const at = new Date().toISOString();
    let changed = false;
    for (const h of FARM_UI_HINTS) {
      const k = keyOf(h.name);
      const e = dict.entries[k];
      const meaning = `${h.where}에 있음 — ${h.meaning}`;
      if (e && e.meaning === meaning) continue;
      dict.entries[k] = {
        ...(e || { seen: 0, first: at, changes: [] }),
        name: h.name, kind: "ui", kindGuess: false,
        signature: "", meaning, example: "",
        last: at,
        sources: [{ at, check: 0, screen: "play", how: "사용자가 알려줌", from: `${h.where}의 ${h.name}` }],
      };
      changed = true;
    }
    if (changed) {
      dict.updated = at;
      saveDict();
    }
  }

  // ---- 설명서 읽기 ----
  // 한 번에 여러 가지를 시키면 gemma 는 앞의 일부만 한다. 그래서 정보 창이 보이면 단어 읽기는 짧은 전용 질문으로 따로 한다.
  // 목차(제목 아래 링크 이름들)와 주제 한 쪽(함수 하나 설명) 두 모양이 있다. 같은 화면은 다시 읽지 않는다.
  const DOC_HEADINGS = [
    [/built-?in functions|내장 함수/i, "function"],
    [/^items$|아이템/i, "item"],
    [/unlocks|해금/i, "unlock"],
    [/entities|개체/i, "entity"],
    [/grounds|땅/i, "ground"],
    [/programming|프로그래밍/i, "topic"],
  ];
  const isDocHeading = (t) =>
    /^\s*(general info|일반 정보)\s*$/i.test(t) || DOC_HEADINGS.some(([re]) => re.test(t.trim()) && t.trim().split(/\s+/).length <= 3);
  const INDEX_CUES = /built-?in functions|내장 함수|general info|일반 정보/i;
  let lastDocsKey = "";

  async function readDocs(lines, model) {
    const text = lines.map((l) => l.text).join("\n");
    const key = text.replace(/\s+/g, "").toLowerCase();
    if (key === lastDocsKey) return { skipped: true, terms: [] };
    lastDocsKey = key;
    const ocr = `OCR text (may drop underscores — "do a flip" is really "do_a_flip"):\n"""\n${text}\n"""`;
    const isIndex = INDEX_CUES.test(text);
    const prompt = isIndex
      ? `This is the in-game documentation INDEX of a programming game: section headings with underlined link names under each.
Read the IMAGE carefully. ${ocr}
For every heading, list the link names under it exactly as written in the image (keep underscores).
Answer JSON only: {"sections": [{"heading": "<heading>", "names": ["<name>", ...]}]}`
      : `This is one page of the in-game documentation of a programming game (it explains one topic or function).
Read the IMAGE carefully. ${ocr}
Answer JSON only, describing only what this page says:
{"name": "<the function/topic name exactly as written>", "kind": "<${Object.keys(TERM_KINDS).join("|")}>",
 "signature": "<how it is called, e.g. harvest(), or empty>", "meaning": "<what it does, in Korean, 1-2 sentences>",
 "example": "<a short code example shown on the page, or empty>"}`;
    const res = await ask({ type: "llm_ask", model, prompt, image: grab(1280), timeout: 60, json: true, max_tokens: 400 }, 65000);
    if (res.error) return { error: res.error, terms: [] };
    let o;
    try {
      o = JSON.parse(String(res.text).match(/\{[\s\S]*\}/)?.[0] || "null");
    } catch (e) {}
    if (!o) return { error: "답을 못 읽음", terms: [], took: res.took };
    if (!isIndex) {
      return o.name ? { page: true, took: res.took, terms: [{ ...o, from: "그림 (설명서 한 쪽)" }] } : { terms: [], took: res.took };
    }
    const terms = [];
    for (const sec of o.sections || []) {
      const kind = DOC_HEADINGS.find(([re]) => re.test(String(sec.heading || "")))?.[1];
      if (!kind) continue; // '일반 정보' 같은 도움말 목차는 문법이 아니다
      for (let name of sec.names || []) {
        name = String(name).trim();
        if (!name) continue;
        // 함수 이름은 공백이 없다 — OCR·모델이 밑줄을 공백으로 읽은 것을 되돌린다
        if (kind === "function") name = name.replace(/\s+/g, "_");
        terms.push({ name, kind, from: `설명서 목차의 '${sec.heading}'` });
      }
    }
    return { index: true, took: res.took, terms };
  }

  const stamp = () => new Date().toLocaleTimeString("ko-KR", { hour12: false });
  const why = (html) => `<span class="why">${html}</span>`;

  // agentN 이 있으면 자율 플레이의 한 걸음: 같은 LLM 호출에서 다음 행동까지 받는다
  async function check(agentN) {
    if (checking) return null;
    if (!stream || !video.videoWidth) return setStatus("먼저 화면 공유를 해주세요", "bad"), null;
    if (!(await ensureBridge())) return setStatus("브릿지에 연결하지 못했습니다", "bad"), null;
    checking = true;
    el.check.disabled = true;
    const t0 = performance.now();
    const n = ++checkNo;
    setStatus("화면 읽는 중…", "");
    if (agentN) setPhase("👁 화면 글자 읽는 중");
    try {
      // 1·2. OCR
      // 2026-10-28 실제 게임 화면으로 비교: 영어 화면은 en-US 엔진 + 2배 확대가 제일 정확했다
      // (ko 엔진은 pet_the_piggy 를 pet—the—piggy, Hay 를 터하y 로 읽었다). 좌표는 ocr.w/h 기준이라 확대해도 맞는다.
      const ocr = await ask({ type: "ocr", image: grab(0, 2), lang: el.lang.value }, 20000);
      // 링크 여러 개가 한 줄로 읽힌 것은 쪼개진다 — 그래서 번호는 이 배열 기준이다
      const lines = classifyLines(ocr.lines || [], ocr.w || video.videoWidth * 2, ocr.h || video.videoHeight * 2);
      nameWindows(lines, ocr.w || video.videoWidth * 2, ocr.h || video.videoHeight * 2);
      await nameUntitled();
      el.ocr.textContent = ocr.error ? `OCR 실패: ${ocr.error}` : lines.map((l) => l.text).join("\n") || "(글자 없음)";

      // 3. 규칙
      const rule = ruleGuess(lines);
      const rows = [
        `<span class="tag">#${n} ${stamp()}</span> ${agentN ? `자율 ${agentN}걸음 — 화면 보기` : "화면 확인 시작"}`,
        why(ocr.error
          ? `<span class="bad">OCR 실패</span> — ${esc(ocr.error)}`
          : `OCR ${lines.length}줄 (${ocr.ms ?? "?"}ms)`),
        why(rule.hits.length
          ? `규칙 추정 <b>${byId[rule.id].name}</b> — 걸린 단서: ${rule.hits.map((h) => `<code>${esc(h)}</code>`).join(" ")}`
          : `규칙 추정 <b>${byId[rule.id].name}</b> — 걸린 단서 없음`),
      ];

      // 4. LLM
      let llm = null;
      const model = el.model.value;
      if (model) {
        setStatus("LLM 이 판단하는 중…", "");
        if (agentN) setPhase("💭 생각하는 중");
        docsOpenNow = rule.id === "docs";
        // 정보 창이면 단어는 아래 전용 질문으로 읽으므로 여기선 판단·행동만 짧게 받는다
        const terms = !docsOpenNow && wantTerms(lines);
        const res = await ask(
          { type: "llm_ask", model, prompt: buildPrompt(lines, agentN, terms), image: grab(1280), timeout: 90,
            json: true, max_tokens: terms ? 700 : agentN ? 350 : 250 },
          95000
        );
        if (!terms && !docsOpenNow) rows.push(why('<span class="dim">코드·설명서가 안 보여 단어 수집은 건너뜀 (답을 짧게)</span>'));
        if (res.error) {
          rows.push(why(`<span class="bad">LLM 실패</span> — ${esc(res.error)} → 규칙 추정을 씁니다`));
        } else {
          llm = parseJson(res.text);
          rows.push(llm
            ? why(`LLM(${esc(model)}, ${res.took?.toFixed(1) ?? "?"}초${res.stats ? ` = 올리기 ${res.stats.load}초 · 읽기 ${res.stats.read}초 · 답 쓰기 ${res.stats.write}초, ${res.stats.out_tokens}토큰` : ""}) <b>${byId[llm.screen].name}</b> — ${esc(llm.reason || "근거 없음")}`)
            : why(`<span class="bad">LLM 답을 못 읽었습니다</span> — <span class="dim">${esc(String(res.text).slice(0, 120))}</span> → 규칙 추정을 씁니다`));
        }
      } else {
        rows.push(why('<span class="dim">LLM 모델을 고르지 않아 규칙 추정만 씁니다</span>'));
      }

      // 5. 최종
      const final = llm
        ? { id: llm.screen, conf: Number(llm.confidence) || 0, source: "LLM" }
        : { id: rule.id, conf: rule.conf, source: "OCR 규칙" };
      const disagree = llm && llm.screen !== rule.id && rule.score > 0;
      if (disagree) rows.push(why(`<span class="pick">규칙(${byId[rule.id].name})과 LLM 판단이 다릅니다 — LLM 을 따릅니다</span>`));
      if (lastScreen && lastScreen !== final.id) {
        rows.push(why(`<span class="good">화면이 바뀌었습니다: ${byId[lastScreen].name} → ${byId[final.id].name}</span>`));
      }
      const facts = (llm?.facts || []).filter((f) => f && f.value);
      for (const f of facts) {
        const label = FARM_FACTS.find(([k]) => k === f.key)?.[1] || f.key;
        rows.push(why(`알아낸 것 · ${esc(label)}: ${esc(f.value)} <span class="dim">← ${esc(f.from || "출처 없음")}</span>`));
      }
      // 사전에 합친다. 같은 단어는 LLM 쪽을 먼저 넣어야 종류·뜻이 제대로 잡힌다.
      const ctx = { at: new Date().toISOString(), n, screen: final.id };
      let docTerms = [];
      if (docsOpenNow && el.model.value) {
        if (agentN) setPhase("📖 설명서 읽는 중");
        const d = await readDocs(lines, el.model.value);
        if (d.skipped) rows.push(why('<span class="dim">설명서: 지난번과 같은 쪽이라 다시 읽지 않음</span>'));
        else if (d.error) rows.push(why(`<span class="bad">설명서 읽기 실패</span> — ${esc(d.error)}`));
        else rows.push(why(`설명서 ${d.index ? "목차" : "한 쪽"} 읽음 (${d.took?.toFixed(1) ?? "?"}초) — ${d.terms.length}개`));
        docTerms = d.terms;
      }
      const fromLlm = learn([...docTerms, ...(llm?.terms || [])], "LLM", ctx);
      const fromRule = learn(ruleTerms(lines), "OCR 규칙", ctx);
      const added = [...fromLlm.added, ...fromRule.added];
      const filled = [...new Set([...fromLlm.filled, ...fromRule.filled])];
      const names = (list) => list.slice(0, 12).map((e) => `<code>${esc(e.name)}</code>`).join(" ") + (list.length > 12 ? ` 외 ${list.length - 12}개` : "");
      if (added.length) rows.push(why(`<span class="good">사전에 새 단어 ${added.length}개</span> — ${names(added)}`));
      if (filled.length) rows.push(why(`사전 보충 ${filled.length}개 (형태·뜻·예시를 새로 알게 됨) — ${names(filled)}`));
      for (const { e, f } of fromLlm.changed) {
        const label = { signature: "형태", meaning: "뜻", example: "예시" }[f];
        rows.push(why(`<span class="pick">사전 내용이 바뀜</span> <code>${esc(e.name)}</code> ${label}: <span class="dim">${esc(e.changes[0].old)}</span> → ${esc(e.changes[0].now)}`));
      }
      if (!added.length && !filled.length && !fromLlm.changed.length) rows.push(why('<span class="dim">사전에 새로 배운 것 없음</span>'));
      // 알아낸 정보도 데이터에 밀어 넣는다. 다음 추론의 '마지막으로 본 상태'가 된다.
      if (facts.length || dict.state?.screen !== final.id) {
        dict.state = { at: ctx.at, check: n, screen: final.id, facts: facts.map(({ key, value, from }) => ({ key, value, from })) };
        dict.updated = ctx.at;
        saveDict();
        rows.push(why(`데이터에 반영 — 화면 ${byId[final.id].name}${facts.length ? `, 정보 ${facts.length}개` : ""} (다음 추론 때 같이 넘깁니다)`));
      }
      rows.push(why(`결론 <b>${byId[final.id].name}</b> (${final.source}, 확신 ${Math.round(final.conf * 100)}%)`));
      logger.push(rows.join(""), disagree || fromLlm.changed.length ? "warn" : added.length ? "win" : "");

      lastScreen = final.id;
      el.screen.textContent = byId[final.id].name;
      el.conf.textContent = `${Math.round(final.conf * 100)}%`;
      el.source.textContent = final.source;
      el.took.textContent = `${((performance.now() - t0) / 1000).toFixed(1)}초`;
      showFacts(facts, final.source);
      setStatus(`지금 화면: ${byId[final.id].name}`, "ok");
      return { n, llm, lines, w: ocr.w || video.videoWidth, h: ocr.h || video.videoHeight, screen: final.id };
    } finally {
      checking = false;
      el.check.disabled = agentOn;
    }
  }

  function showFacts(facts, source) {
    if (!facts.length) {
      el.info.innerHTML = `<p class="dim">${source === "LLM" ? "LLM 이 보고한 정보가 없습니다" : "정보 추출은 LLM 이 있어야 합니다 — 지금은 화면 종류만 압니다"}</p>`;
      return;
    }
    el.info.innerHTML =
      "<table>" +
      facts
        .map((f) => {
          const label = FARM_FACTS.find(([k]) => k === f.key)?.[1] || f.key;
          return `<tr><td>${esc(label)}</td><td>${esc(f.value)}<span class="src">← ${esc(f.from || "출처 없음")}</span></td></tr>`;
        })
        .join("") +
      "</table>";
  }

  // 자동 확인: 이전 확인이 끝난 뒤에 다음 간격을 잰다 (LLM 이 느려도 요청이 쌓이지 않게)
  let autoTimer = null;
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!el.auto.checked) return;
    autoTimer = setTimeout(async () => {
      if (stream) await check();
      scheduleAuto();
    }, Number(el.every.value) * 1000);
  }

  // ---- 자율 플레이 ----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 화면이 바뀌었는지 보려고 작게 줄인 흑백 프레임을 뜬다
  function tinyFrame() {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 90;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, 0, 0, c.width, c.height);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const out = new Float32Array(c.width * c.height);
    for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    return out;
  }
  const frameDiff = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  };

  // 오른쪽 위 아이콘 버튼 찾기. 버튼은 모두 올리브색 네모(rgb 96,115,13)라서 색으로 찾는다.
  // 화면 오른쪽 40%·위 20% 안에서 그 색이 있는 세로줄을 모아 덩어리로 나누고, 오른쪽부터 ⇈, i, + 로 본다.
  // (2026-10-28 1922×1112 창 캡처에서 + (1759,68), i (1820,68), ⇈ (1882,68) 으로 확인)
  const BUTTON_ORDER = ["up", "info", "add"]; // 오른쪽에서 왼쪽 순서
  function findTopButtons() {
    const W = video.videoWidth, H = video.videoHeight;
    const x0 = Math.floor(W * 0.6), w = W - x0, h = Math.floor(H * 0.2);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, x0, 0, w, h, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const olive = (i) => Math.abs(d[i] - 96) < 22 && Math.abs(d[i + 1] - 115) < 22 && d[i + 2] < 45;
    const cols = new Array(w).fill(null); // 세로줄마다 올리브색이 나온 y 범위
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        if (!olive((y * w + x) * 4)) continue;
        const r = cols[x] || (cols[x] = { y0: y, y1: y, n: 0 });
        r.y1 = y;
        r.n++;
      }
    }
    // 이웃한 세로줄끼리 묶는다. 너무 얇은 것(글자 밑줄 등)은 버린다.
    const blobs = [];
    let cur = null;
    for (let x = 0; x <= w; x++) {
      const col = x < w && cols[x] && cols[x].n >= 4 ? cols[x] : null;
      if (col) {
        if (!cur) cur = { xa: x, xb: x, y0: col.y0, y1: col.y1 };
        cur.xb = x;
        cur.y0 = Math.min(cur.y0, col.y0);
        cur.y1 = Math.max(cur.y1, col.y1);
      } else if (cur) {
        const bw = cur.xb - cur.xa, bh = cur.y1 - cur.y0;
        if (bw > 12 && bh > 12 && bw / bh > 0.6 && bw / bh < 1.6) blobs.push(cur);
        cur = null;
      }
    }
    blobs.sort((a, b) => b.xb - a.xb);
    const out = {};
    blobs.slice(0, BUTTON_ORDER.length).forEach((b, i) => {
      out[BUTTON_ORDER[i]] = [(x0 + (b.xa + b.xb) / 2) / W, (b.y0 + b.y1) / 2 / H];
    });
    return out;
  }

  // 브릿지에 클릭 하나. 공유 화면 크기를 같이 보내서 브릿지가 기준 영역(창 전체/내용 영역)을 고르게 한다.
  const sendClick = (fx, fy, button, why) =>
    ask({ type: "click", x: fx, y: fy, button, why, cw: video.videoWidth, ch: video.videoHeight });

  // 글자 상자 안에서 눌러볼 자리들. 가운데부터, 안 되면 조금씩 옮긴다.
  function nudges(box, W, H) {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    const dx = Math.max(4, box.w / 4), dy = Math.max(3, box.h / 2);
    return [
      [cx, cy], [box.x + Math.min(box.w / 4, 20), cy], [cx, cy - dy], [cx, cy + dy], [cx + dx, cy], [cx - dx, cy + dy * 1.5],
    ].map(([x, y]) => [Math.min(1, Math.max(0, x / W)), Math.min(1, Math.max(0, y / H))]);
  }

  // ---- 화면 배치: 창과 밭 ----
  // 게임 색이 평평해서 색으로 나뉜다 (2026-10-28 스크린샷 실측):
  //   창 제목줄·테두리 (86,86,86) / 창 본문 (46,46,46) / 배경 푸른 회색 / 밭·드론 주황·황토 (빨강 ≫ 파랑)
  // 제목줄과 테두리가 같은 색으로 이어져 있어서, 그 색 덩어리 하나의 상자가 곧 창 하나다.
  const LW = 480; // 분석용으로 줄인 폭
  // 창 이름·종류. 이름은 제목줄 위 OCR 글자(f0, main …), 종류는 제목줄 버튼 모양으로 정한다.
  //   ↩ 가 맨 왼쪽에 있으면 정보 창(info), ▶ ▷ 가 왼쪽에 둘 있으면 코드 창(code).
  let windowNames = [];
  let lastField = null; // 창에 다 가려져도 기억해 둔 밭 자리

  function analyzeLayout() {
    const W = video.videoWidth, H = video.videoHeight;
    if (!W) return { windows: [], field: lastField };
    const w = LW, h = Math.round((H / W) * LW);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const px = (x, y) => (y * w + x) * 4;
    const isBar = (i) => Math.abs(d[i] - 86) < 7 && Math.abs(d[i + 1] - 86) < 7 && Math.abs(d[i + 2] - 86) < 7;

    // 1. 창 = 회색 제목줄 띠 하나 (사용자 확인: 회색 칸에 적힌 글자가 그 창의 이름, 그 아래 진한 회색을 누르면 코드 입력).
    //    창은 앞뒤로 겹쳐 쌓이거나 위아래로 붙는다(f0 밑에 f1). 회색이 이어진 덩어리로 보면 여러 창이 한 덩어리가 된다 (10-28 실측).
    //    그래서 높이가 화면의 2~6% 인 가로 띠를 하나씩 찾는다. 테두리 세로선은 가로로 짧아서 안 걸린다.
    //    띠 안의 버튼(올리브)·이름 글자(흰색) 때문에 끊긴 구간은 이어 붙인다.
    const isBody = (i) => Math.abs(d[i] - 46) < 10 && Math.abs(d[i + 1] - 46) < 10 && Math.abs(d[i + 2] - 46) < 10;
    const rowRuns = (y) => {
      const runs = [];
      let a = -1;
      for (let x = 0; x <= w; x++) {
        const on = x < w && isBar(px(x, y));
        if (on && a < 0) a = x;
        if (!on && a >= 0) {
          if (x - a >= 3) runs.push([a, x]);
          a = -1;
        }
      }
      // 버튼·글자로 끊긴 틈(폭의 6% 이하)은 잇는다. 틈이 본문·배경 색이면 다른 창이라 잇지 않는다.
      const merged = [];
      for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last && r[0] - last[1] <= w * 0.06) {
          let foreign = 0;
          for (let x = last[1]; x < r[0]; x++) {
            const i = px(x, y);
            if (isBody(i) || d[i + 2] > d[i] + 15) foreign++; // 본문 또는 푸른 배경
          }
          if (foreign <= (r[0] - last[1]) * 0.3) { last[1] = r[1]; continue; }
        }
        merged.push([...r]);
      }
      return merged.filter(([p, q]) => q - p >= w * 0.03);
    };
    const bands = [];
    let open = [];
    for (let y = 0; y <= h; y++) {
      const runs = y < h ? rowRuns(y) : [];
      const next = [];
      for (const r of runs) {
        const o = open.find((b) => Math.min(b.x1, r[1]) - Math.max(b.x0, r[0]) >= 0.6 * Math.min(b.x1 - b.x0, r[1] - r[0]));
        if (o) {
          o.x0 = Math.min(o.x0, r[0]);
          o.x1 = Math.max(o.x1, r[1]);
          o.y1 = y;
          open.splice(open.indexOf(o), 1);
          next.push(o);
        } else next.push({ x0: r[0], x1: r[1], y0: y, y1: y });
      }
      for (const b of open) bands.push(b);
      open = next;
    }
    const bandsOk = bands.filter((b) => b.y1 - b.y0 + 1 >= h * 0.02 && b.y1 - b.y0 + 1 <= h * 0.06 && b.x1 - b.x0 >= w * 0.03);
    // 띠 바로 왼쪽과 오른쪽이 둘 다 진한 회색 본문이면 남의 창 본문 안에 있는 띠 = 설명서 속 그림이다.
    // 창 안에 창은 있을 수 없다 (사용자 확인). 그림 띠는 창으로 치지 않고, 본문 재기를 끊지도 않는다.
    // 그림 왼쪽 끝엔 ▶ 버튼과 얇은 배경색 테두리가 붙어 있다 (실측 First Program). 그래서 바깥으로 조금씩 훑다가
    // 배경이 길게(3칸 넘게) 나오기 전에 본문을 만나면 본문 안으로 본다.
    const sideBody = (b) => {
      const ym = Math.round((b.y0 + b.y1) / 2);
      const side = (x0, dir) => {
        let bg = 0;
        for (let k = 1; k <= w * 0.05; k++) {
          const x = x0 + dir * k;
          if (x < 0 || x >= w) return false;
          const i = px(x, ym);
          if (isBody(i)) return true;
          if (d[i + 2] > d[i] + 15 && ++bg > 3) return false;
        }
        return false;
      };
      return side(b.x0, -1) && side(b.x1, 1);
    };
    const picBands = bandsOk.filter(sideBody);
    const bars = bandsOk.filter((b) => !picBands.includes(b));

    // 2. 띠마다 그 아래 진한 회색 본문이 이어지는 데까지가 창. 다음 제목줄이 나오면 거기서 끊는다 (붙은 창 나누기).
    const windows = [];
    const maxMiss = Math.max(3, Math.round(h * 0.025));
    for (const b of bars) {
      const startsBar = (yy) => bars.some((o) => o !== b && o.y0 === yy && Math.min(o.x1, b.x1) - Math.max(o.x0, b.x0) > (b.x1 - b.x0) * 0.3);
      let bodyB = b.y1, miss = 0;
      for (let yy = b.y1 + 1; yy < h && miss < maxMiss; yy++) {
        if (startsBar(yy)) break;
        let cnt = 0;
        for (let xx = b.x0; xx <= b.x1; xx++) if (isBody(px(xx, yy)) || isBar(px(xx, yy))) cnt++;
        if (cnt >= (b.x1 - b.x0 + 1) * 0.4) { bodyB = yy; miss = 0; } else miss++;
      }
      // 끄는 손잡이: 제목줄 안에서 좌우 4칸이 모두 제목줄 색인 곳 (버튼·이름 글자를 피한다). 가운데부터 찾는다.
      const hy = Math.round((b.y0 + b.y1) / 2);
      let hx = null;
      const mid = Math.round((b.x0 + b.x1) / 2);
      for (let off = 0; off < (b.x1 - b.x0) / 2 && hx == null; off += 2) {
        for (const cx of [mid + off, mid - off]) {
          let ok = cx - 4 > b.x0 && cx + 4 < b.x1;
          for (let t = -4; ok && t <= 4; t++) ok = isBar(px(cx + t, hy));
          if (ok) { hx = cx; break; }
        }
      }
      windows.push({
        x: b.x0 / w, y: b.y0 / h, w: (b.x1 - b.x0) / w, h: (bodyB - b.y0 + 1) / h,
        barH: (b.y1 - b.y0 + 1) / h,
        handle: hx != null ? [hx / w, hy / h] : null,
      });
    }

    // 3. 게임에서 창 안에 창은 있을 수 없다 (사용자 확인). 다른 창 본문 안의 띠는 설명서 속 그림이다.
    //    예: 정보 창 'First Program' 쪽에 코드 창 제목줄(▶ ▷ main ─ ✕)을 찍은 그림이 있다.
    const inBodyOf = (a, o) => a !== o && a.x >= o.x - 0.005 && a.x + a.w <= o.x + o.w + 0.005 && a.y >= o.y + o.barH && a.y < o.y + o.h;
    const pictures = windows.filter((a) => windows.some((o) => inBodyOf(a, o)));
    for (const b of picBands) pictures.push({ x: b.x0 / w, y: b.y0 / h, w: (b.x1 - b.x0) / w, h: (b.y1 - b.y0 + 1) / h + 0.01, barH: (b.y1 - b.y0 + 1) / h });
    for (const pic of pictures) {
      const i = windows.indexOf(pic);
      if (i < 0) continue;
      windows.splice(i, 1);
      pic.h = pic.barH + 0.01; // 그림 아래 어두운 색은 바깥 창 본문이다
    }
    windows.sort((a, b2) => a.y - b2.y || a.x - b2.x);
    // 이름·종류는 OCR 을 한 check() 가 붙여 둔 것을 위치로 맞춰 쓴다
    for (const win of windows) {
      const k = windowNames.find((n) => Math.abs(n.x - win.x) < 0.02 && Math.abs(n.y - win.y) < 0.02);
      win.name = k ? k.name : null;
      win.kind = k ? k.kind : null;
    }
    const inWin = (x, y) => windows.some((r) => x >= r.x * w && x <= (r.x + r.w) * w && y >= r.y * h && y <= (r.y + r.h) * h);

    // 2. 밭: 창 밖, 위쪽 버튼 줄(12%) 아래에서 따뜻한 색(빨강이 파랑보다 확실히 큼)
    // 따뜻한 색 점 중 가장 큰 덩어리 하나만 밭으로 친다 (풀잎이 가늘어서 2칸 떨어진 것까지 이어 본다)
    const warm = new Uint8Array(w * h);
    for (let y = Math.round(h * 0.12); y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = px(x, y);
        if (d[i] - d[i + 2] > 50 && d[i] > 100 && !inWin(x, y)) warm[y * w + x] = 1;
      }
    }
    let best = null;
    const done = new Uint8Array(w * h);
    for (let k0 = 0; k0 < w * h; k0++) {
      if (!warm[k0] || done[k0]) continue;
      const blob = { x0: w, y0: h, x1: -1, y1: -1, n: 0 };
      const st = [k0];
      done[k0] = 1;
      while (st.length) {
        const q = st.pop();
        const qx = q % w, qy = (q - qx) / w;
        blob.n++;
        if (qx < blob.x0) blob.x0 = qx; if (qx > blob.x1) blob.x1 = qx; if (qy < blob.y0) blob.y0 = qy; if (qy > blob.y1) blob.y1 = qy;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = qx + dx, ny = qy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nk = ny * w + nx;
            if (warm[nk] && !done[nk]) { done[nk] = 1; st.push(nk); }
          }
        }
      }
      if (!best || blob.n > best.n) best = blob;
    }
    const fn = best ? best.n : 0;
    const [fx0, fy0, fx1, fy1] = best ? [best.x0, best.y0, best.x1, best.y1] : [0, 0, 0, 0];
    if (fn > 40) {
      const pad = 0.04;
      const found = {
        x: Math.max(0, fx0 / w - pad), y: Math.max(0, fy0 / h - pad),
        w: Math.min(1, (fx1 - fx0) / w + pad * 2), h: Math.min(1, (fy1 - fy0) / h + pad * 2),
      };
      // 창이 밭을 거의 다 가리면 삐져나온 드론 날개 같은 조각만 보인다. 기억해 둔 밭보다 절반 넘게 작으면 가려진 것으로 보고 기억을 쓴다.
      if (!lastField || found.w * found.h >= lastField.w * lastField.h * 0.5) lastField = found;
    }
    return { windows, pictures, field: lastField };
  }

  const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const pct = (v) => Math.round(v * 100);

  // 창을 밭에서 비켜 놓을 자리. 밭 왼쪽·오른쪽·위·아래 중 화면 안에 들어가고 다른 창과 덜 겹치며 덜 움직이는 곳.
  // 창을 밭에서 비켜 놓을 자리.
  // 게임은 창끼리 겹치게 놓지 못한다 — 다른 창 위에 내려놓으면 안 옮겨진다. 그래서 다른 창과 겹치는 자리는 아예 후보에서 뺀다.
  // 밭 옆 네 자리를 먼저 보고, 화면 전체를 2% 간격으로 훑어 빈자리를 찾는다. 밭을 덜 가리고 덜 움직이는 곳이 좋다.
  // 놓을 데가 없으면 null.
  function placeAway(win, field, others) {
    const m = 0.01, top = 0.12; // 위쪽 12% 는 아이콘 줄이라 비워 둔다
    const gap = 0.006; // 다른 창과 이만큼은 띄운다
    const fits = (p) => p.x >= m && p.y >= top && p.x + win.w <= 1 - m && p.y + win.h <= 1 - m;
    const hitsWindow = (r) => others.some((o) => overlap({ x: r.x - gap, y: r.y - gap, w: r.w + gap * 2, h: r.h + gap * 2 }, o) > 0);
    const cands = [
      { x: field.x - win.w - m, y: win.y },
      { x: field.x + field.w + m, y: win.y },
      { x: win.x, y: field.y - win.h - m },
      { x: win.x, y: field.y + field.h + m },
    ].map((p) => ({ x: Math.min(1 - win.w - m, Math.max(m, p.x)), y: Math.min(1 - win.h - m, Math.max(top, p.y)) }));
    for (let y = top; y + win.h <= 1 - m; y += 0.02) {
      for (let x = m; x + win.w <= 1 - m; x += 0.02) cands.push({ x, y });
    }
    let best = null;
    for (const p of cands) {
      if (!fits(p)) continue;
      const r = { ...win, ...p };
      if (hitsWindow(r)) continue;
      const score = overlap(r, field) * 100 + Math.hypot(p.x - win.x, p.y - win.y);
      if (!best || score < best.score) best = { ...p, score, coversField: overlap(r, field) > 0.002 };
    }
    return best;
  }

  // 창이 밭을 가리면 제목줄을 잡고 끌어서 옮긴다. LLM 에게 맡기지 않는다 — 밭을 보는 게 우선이라는 걸 모른다.
  // 하나 옮길 때마다 다시 잰다 (옮긴 창이 다음 창의 빈자리를 바꾼다). 끈 뒤에는 실제로 옮겨졌는지 확인한다.
  async function clearField() {
    const notes = [];
    const tried = new Set();
    for (let round = 0; round < 4; round++) {
      const lay = analyzeLayout();
      if (!lay.field) return notes;
      const win = lay.windows.find((w2) => overlap(w2, lay.field) >= 0.002 && !tried.has(`${pct(w2.x)},${pct(w2.y)}`));
      if (!win) return notes;
      const id = `${pct(win.x)},${pct(win.y)}`;
      tried.add(id);
      const others = lay.windows.filter((o) => o !== win);
      const to = placeAway(win, lay.field, others);
      const desc = `창 (${pct(win.x)}%,${pct(win.y)}% 크기 ${pct(win.w)}×${pct(win.h)})`;
      if (!win.handle) {
        notes.push(`${desc} 이 밭을 가리지만 제목줄에서 잡을 곳을 못 찾음`);
        continue;
      }
      if (!to || overlap({ ...win, ...to }, lay.field) >= overlap(win, lay.field)) {
        notes.push(`${desc} 이 밭을 가리지만 다른 창과 안 겹치게 놓을 빈자리가 없음 — 그대로 둠 (창을 줄이거나 닫아야 함)`);
        continue;
      }
      const [hx, hy] = win.handle;
      const x2 = hx + (to.x - win.x), y2 = hy + (to.y - win.y);
      const r = await ask({ type: "drag", x1: hx, y1: hy, x2, y2, why: `창 '${win.name || "?"}' 옮기기 — 밭을 가림`, cw: video.videoWidth, ch: video.videoHeight });
      mark(hx, hy, r.from ? null : false, "✋");
      mark(x2, y2, r.from ? true : false, "↘");
      if (r.halted) return notes;
      if (!r.from) {
        notes.push(`${desc} 을 옮기려 했지만 실패: ${r.error || "?"}`);
        continue;
      }
      if (!r.live) {
        notes.push(`${desc} 이 밭을 가려서 (${pct(to.x)}%,${pct(to.y)}%) 로 옮기려 함 — 안전모드라 실제로 끌진 않음`);
        return notes; // 화면이 안 바뀌니 더 해 봐야 같은 결과
      }
      await sleep(500);
      // 옮겨졌나: 목표 자리 근처에 같은 크기 창이 생겼는지 본다
      const after = analyzeLayout().windows.some(
        (w2) => Math.abs(w2.x - to.x) < 0.03 && Math.abs(w2.y - to.y) < 0.03 && Math.abs(w2.w - win.w) < 0.03
      );
      notes.push(`${desc} 이 밭을 가려서 (${pct(to.x)}%,${pct(to.y)}%) 로 끌었음 — ${after ? "옮겨진 것 확인" : "옮겨지지 않음 (게임이 거부했거나 잡은 곳이 제목줄이 아님)"}${to.coversField ? " · 밭을 조금 덜 가리는 자리밖에 없었음" : ""}`);
    }
    return notes;
  }

  // LLM 에게 줄 배치 설명
  function layoutBlock() {
    const lay = analyzeLayout();
    const f = lay.field;
    const KIND = { code: "code window", info: "info window (docs)", window: "window" };
    const wins = lay.windows.map((r) => `- "${r.name || "?"}" — ${KIND[r.kind] || "window"} at x ${pct(r.x)}-${pct(r.x + r.w)}%, y ${pct(r.y)}-${pct(r.y + r.h)}%${f && overlap(r, f) > 0.002 ? " — COVERS THE FIELD" : ""}`);
    const codeWins = lay.windows.filter((r) => r.kind === "code").map((r) => `"${r.name}"`);
    return `Screen layout (measured by the program):
- FIELD (the farm with the drone — the most important thing to keep visible): ${f ? `x ${pct(f.x)}-${pct(f.x + f.w)}%, y ${pct(f.y)}-${pct(f.y + f.h)}%` : "not found"}
${wins.join("\n") || "- no windows"}
Windows are named by the text on their grey top bar. Refer to a window by that name.
${codeWins.length ? `Code windows already exist (${codeWins.join(", ")}). Do NOT press "add" to make more — write into an existing one with the "code" action.` : `There is no code window yet. Press "add" ONCE to make one.`}
Close windows you do not need with {"type": "close_window", "window": "<name>"}.
Windows can be moved with {"type": "move_window", "window": "<name>"} — the program drags it off the field.
Scrolling on the background (not on a window) moves/zooms the view. Window edges can be dragged to resize.
Windows can NOT overlap each other in this game; if there is no free space, a window can be minimized with the "−" button on its top bar.
Inside windows, only UNDERLINED green links (marked "(green link)") and the small buttons on a window's top bar are clickable.
Green words WITHOUT an underline (like True, False, numbers in the docs) are just highlighted code, not links.
Pictures inside windows are ILLUSTRATIONS — never click them. A window can never be inside another window,
so anything that looks like a window inside a window is a picture${lay.pictures.length ? ` (found ${lay.pictures.length} such picture${lay.pictures.length > 1 ? "s" : ""})` : ""}.
Dragging a window ONTO another window docks it to that window.`;
  }

  // 좌표 클릭(click_at)이 창 본문(제목줄 아래) 안이면 그림이나 빈 곳이다 — 누르지 않는다
  function insideWindowBody(fx, fy) {
    return analyzeLayout().windows.some((r) => fx > r.x && fx < r.x + r.w && fy > r.y + r.barH && fy < r.y + r.h);
  }

  // OCR 줄마다 링크인지(누를 수 있는지) 가른다. 링크 = 연두색 + 밑줄.
  // 연두색만으로는 안 된다: 설명서의 True·False·숫자도 연두색 강조지만 밑줄이 없고 링크가 아니다 (사용자 확인).
  // 밑줄은 글자 아래 한 줄에 연두가 길게 끊김 없이 이어진다 (실측: Hay 33px, harvest 83px).
  // 밑줄 없는 강조는 글자 획뿐이라 짧게 끊긴다 (True·200 은 어느 줄도 12px 이하). 그래서 '글자 높이 0.8배 이상 이어지는 줄' 이 밑줄.
  // OCR 이 링크 여러 개를 한 줄로 합쳐 읽으면(do a flip harvest pet_the_piggy) 밑줄마다 쪼개 따로 번호를 준다.
  // 줄마다 l.link, l.inBody, l.inPicture, l.windowName 을 붙이고, 쪼갠 줄을 넣은 새 배열을 돌려준다.
  function classifyLines(lines, ow, oh) {
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !lines.length) return lines;
    const k = 1; // 밑줄 길이를 재야 해서 원래 크기로 본다
    const w = Math.round(W * k), h = Math.round(H * k);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const green = (x, y) => {
      const i = (y * w + x) * 4;
      return d[i + 1] > 90 && d[i + 1] > d[i] + 8 && d[i + 1] - d[i + 2] > 50;
    };
    const lay = analyzeLayout();
    const wins = lay.windows;
    const out = [];
    for (const l of lines) {
      const fx = (l.x + l.w / 2) / ow, fy = (l.y + l.h / 2) / oh;
      // 그림 둘레(▶ ─ ✕ 버튼까지)를 조금 넓게 본다
      l.inPicture = lay.pictures.some((r) => fx > r.x - 0.04 && fx < r.x + r.w + 0.04 && fy > r.y - 0.01 && fy < r.y + r.h + 0.01);
      // 진짜 창 제목줄 위의 글자 = 창(파일) 이름. 누르면 이름 바꾸기가 된다 (사용자 확인).
      const onBar = wins.find((r) => fx > r.x && fx < r.x + r.w && fy > r.y && fy < r.y + r.barH);
      l.windowName = !!onBar && !/^\s*[x×✕]\s*$/i.test(l.text);
      l.inBody = wins.some((r) => fx > r.x && fx < r.x + r.w && fy > r.y + r.barH && fy < r.y + r.h);

      // 밑줄 찾기: 글자 상자 위부터 아래로 글자 높이 60% 더 내려가며, 줄마다 연두가 끊김 없이 이어지는 구간을 모은다
      const x0 = Math.max(0, Math.floor((l.x / ow) * w)), x1 = Math.min(w - 1, Math.ceil(((l.x + l.w) / ow) * w));
      const lh = (l.h / oh) * h;
      const y0 = Math.max(0, Math.floor((l.y / oh) * h)), y1 = Math.min(h - 1, Math.ceil(((l.y + l.h) / oh) * h + lh * 0.6));
      // 글자 획은 글자 높이의 절반쯤에서 끊기고(True: 12px / 높이 25px), 밑줄은 그보다 길다(Hay: 33px)
      const need = Math.max(14 * k, lh * 0.8);
      let segs = [];
      for (let y = y0; y <= y1; y++) {
        const rowSegs = [];
        let a = -1;
        for (let x = x0; x <= x1 + 1; x++) {
          const on = x <= x1 && green(x, y);
          if (on && a < 0) a = x;
          if (!on && a >= 0) {
            // 밑줄은 1~2px 얇은 선이다. 창 버튼(올리브 꽉 찬 네모)은 색이 비슷하고 폭도 밑줄만큼이라, 위아래 4px 도 연두면 버리고 본다.
            const m = Math.round((a + x) / 2);
            const thin = !(y - 4 >= 0 && green(m, y - 4) && y + 4 < h && green(m, y + 4));
            if (x - a >= need && thin) rowSegs.push([a, x]);
            a = -1;
          }
        }
        // 밑줄이 가장 많이 덮인 줄 하나를 쓴다
        const len = (ss) => ss.reduce((t, [p, q]) => t + q - p, 0);
        if (len(rowSegs) > len(segs)) segs = rowSegs;
      }
      // 제목줄 위의 글자는 버튼(✕)이나 창 이름이지 링크가 아니다
      l.link = segs.length > 0 && !onBar;
      if (segs.length < 2) {
        out.push(l);
        continue;
      }
      // 밑줄마다 쪼갠다. 글자는 고정폭이라 x 비율로 글자 위치를 잡고, 낱말 경계로 맞춘다.
      const text = l.text;
      for (const [sa, sb] of segs) {
        const ca = Math.max(0, Math.floor(((sa / w) * ow - l.x) / l.w * text.length));
        const cb = Math.min(text.length, Math.ceil(((sb / w) * ow - l.x) / l.w * text.length));
        let A = ca, B = cb;
        while (A > 0 && text[A - 1] !== " ") A--;
        while (B < text.length && text[B] !== " ") B++;
        const part = text.slice(A, B).trim();
        if (!part) continue;
        out.push({
          ...l,
          text: part,
          x: (sa / w) * ow,
          w: ((sb - sa) / w) * ow,
          link: true,
          splitFrom: text,
        });
      }
    }
    return out;
  }

  // check() 에서 OCR 뒤에 부른다. 창마다 이름과 종류를 붙여 windowNames 에 남긴다.
  function nameWindows(lines, ow, oh) {
    const lay = analyzeLayout();
    let untitled = 0;
    windowNames = lay.windows.map((win) => {
      const title = lines.find((l) => {
        const fx = (l.x + l.w / 2) / ow, fy = (l.y + l.h / 2) / oh;
        return fx > win.x && fx < win.x + win.w && fy > win.y && fy < win.y + win.barH && !/^\s*[x×✕]\s*$/i.test(l.text);
      });
      const btns = barButtons(win);
      const left = btns.filter((b) => b[0] < win.x + win.w * 0.3);
      const kind = left.length >= 2 ? "code" : left.length === 1 && !title ? "info" : "window";
      // OCR 이 제목 앞에 ▶ 버튼을 '>' 로 읽거나 0 을 ø 로 읽는다
      // 창 이름엔 띄어쓰기가 없다. OCR 이 'ma in' 처럼 끊어 읽은 것을 붙인다.
      let name = title ? title.text.replace(/^[^A-Za-z0-9가-힣_]+/, "").replace(/ø/g, "0").replace(/\s+/g, "") : "";
      if (!name) name = kind === "info" ? "info" : `untitled${++untitled}`;
      return { x: win.x, y: win.y, name, kind };
    });
    return windowNames;
  }

  // 이름을 못 읽은 코드 창은 그 제목줄만 잘라 3배로 키워 OCR 을 한 번 더 한다 (10-28: f1 을 못 읽었다).
  async function nameUntitled() {
    const W = video.videoWidth, H = video.videoHeight;
    for (const n of windowNames) {
      if (n.kind !== "code" || !n.name.startsWith("untitled")) continue;
      const win = analyzeLayout().windows.find((w2) => Math.abs(w2.x - n.x) < 0.02 && Math.abs(w2.y - n.y) < 0.02);
      if (!win) continue;
      const sx = win.x * W, sy = win.y * H, sw = win.w * W, sh = win.barH * H;
      const c = document.createElement("canvas");
      c.width = Math.round(sw * 3);
      c.height = Math.round(sh * 3);
      c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
      const r = await ask({ type: "ocr", image: c.toDataURL("image/jpeg", 0.95).split(",")[1], lang: el.lang.value }, 10000);
      const t = (r.lines || []).map((l) => l.text).join(" ").replace(/ø/g, "0").replace(/[^A-Za-z0-9가-힣_ ]/g, " ").trim();
      // 버튼이 글자로 읽힌 것(x, D 같은 한 글자)은 뺀다
      const word = t.split(/\s+/).filter((x) => x.length >= 2 || /\d/.test(x)).join("");
      if (word) n.name = word;
    }
  }

  // 이름으로 창 찾기 (대소문자 무시)
  function windowByName(lay, name) {
    const n = String(name ?? "").trim().toLowerCase();
    return lay.windows.find((w2) => w2.name && w2.name.toLowerCase() === n);
  }

  // 창 본문 안인데 링크 색이 아닌 줄 — 설명 글이나 그림 속 글자다. 누르지 않는다.
  const plainInWindow = (l) => l.inBody && !l.link;

  // 뜻을 모르는 ⇈ 아이콘 둘레는 누르지 않는다 (메인 메뉴로 나가는 버튼일 수 있다). 사용자가 뜻을 알려주면 푼다.
  function forbiddenZone(fx, fy) {
    const up = findTopButtons().up;
    if (!up) return false;
    const W = video.videoWidth, H = video.videoHeight;
    // 버튼 반지름은 대략 화면 높이의 2.5%. 넉넉히 1.6배.
    const r = (H * 0.025 * 1.6);
    return Math.hypot((fx - up[0]) * W, (fy - up[1]) * H) < r;
  }

  // 누르고 화면이 바뀌는지 본다. 안 바뀌면 다음 자리로 옮겨 다시 누른다.
  // 화면에 원래 움직임(드론 등)이 있으니, 누르기 전에 두 프레임 차이로 '평소 흔들림'을 재고 그보다 확실히 클 때만 바뀐 걸로 친다.
  async function clickUntilChange(points, button, label) {
    const tries = [];
    for (let i = 0; i < points.length; i++) {
      const [fx, fy] = points[i];
      if (forbiddenZone(fx, fy)) {
        mark(fx, fy, false, "⛔");
        tries.push(`${i + 1}번째 (${Math.round(fx * 100)}%,${Math.round(fy * 100)}%) → ⇈ 아이콘 둘레라 건너뜀`);
        continue;
      }
      const a = tinyFrame();
      await sleep(150);
      const base = tinyFrame();
      const noise = frameDiff(a, base);
      const r = await sendClick(fx, fy, button, `${label}${points.length > 1 ? ` (${i + 1}번째 자리)` : ""}`);
      if (r.halted) return { text: "ESC 로 막힘", stop: true, tries };
      if (r.no_window) return { text: `'${el.window.value}' 창을 못 찾음`, stop: true, tries };
      if (r.error) {
        mark(fx, fy, false, `${label} ✕`);
        // 내용 영역 밖이라 거절된 자리는 다음 자리로 넘어간다 (실패로 끝내지 않는다)
        if (r.outside) {
          tries.push(`${i + 1}번째 (${Math.round(fx * 100)}%,${Math.round(fy * 100)}%) → 제목줄·테두리라 브릿지가 거절`);
          continue;
        }
        return { text: `실패: ${r.error}`, tries };
      }
      await sleep(700);
      const diff = frameDiff(base, tinyFrame());
      const changed = diff > noise * 2 + 1.5;
      mark(fx, fy, changed, `${label}${points.length > 1 ? ` ${i + 1}` : ""}`);
      tries.push(`${i + 1}번째 (${Math.round(fx * 100)}%,${Math.round(fy * 100)}%) → 화면 ${r.at ? `${r.at[0]},${r.at[1]}` : "?"} [${r.basis || "?"}] 변화 ${diff.toFixed(1)}${changed ? " ✓" : ""}`);
      if (changed) return { text: `눌림 — ${i + 1}번째 자리에서 화면이 바뀜`, tries };
      if (!r.live) return { text: "보냄 (안전모드라 실제로 누르진 않음)", tries };
    }
    return { text: `${points.length}군데 눌러봤지만 화면 변화 없음`, tries };
  }

  function describe(a, lines) {
    if (!a) return "없음";
    switch (a.type) {
      case "click": return `클릭 [${a.target}] "${lines[a.target]?.text ?? "?"}"${a.button === "right" ? " (오른쪽)" : ""}`;
      case "button": return `버튼 ${FARM_UI_HINTS.find((h) => h.button === a.name)?.name || a.name}`;
      case "move_window": return `창 '${a.window}' 옮기기`;
      case "close_window": return `창 '${a.window}' 닫기 (✕)`;
      case "run": return `'${a.window}' ▶ 실행`;
      case "back": return "정보 창 ↩ 돌아가기";
      case "code": return `'${a.window}' 에 코드 입력 "${String(a.text ?? "").slice(0, 60)}${String(a.text ?? "").length > 60 ? "…" : ""}"`;
      case "click_at": return `클릭 위치 ${Math.round(a.x * 100)}%, ${Math.round(a.y * 100)}%`;
      case "type": return `입력 "${String(a.text).slice(0, 80)}${String(a.text).length > 80 ? "…" : ""}"`;
      case "key": return `키 ${a.key}`;
      case "scroll": return `스크롤 ${a.direction === "up" ? "위" : "아래"} ${a.amount || 3}칸${a.target != null ? ` @ [${a.target}] "${lines[a.target]?.text ?? "?"}"` : a.x != null ? ` @ ${Math.round(a.x * 100)}%, ${Math.round(a.y * 100)}%` : ""}`;
      case "wait": return `${a.seconds}초 기다림`;
      case "done": return `끝 — ${a.why || ""}`;
      default: return `알 수 없는 행동 ${a.type}`;
    }
  }

  // ---- 코드 쓰기 → 읽어서 확인 → 실행 → 결과 보기 ----
  // 10-28: 한 글자씩 치니 편집기의 자동 완성·자동 들여쓰기가 끼어 코드가 망가졌고, 쓰고 나서 실행도 안 했다.
  // 그래서: 편집 칸 클릭 → Ctrl+A → 붙여넣기 → 편집 칸을 OCR 로 다시 읽어 비교 → 다르면 한 번 더 → 같으면 ▶ → 오류 글자 확인.

  // 코드 창 편집 칸의 글자를 읽는다. 들여쓰기는 줄의 x 위치로 되살린다 (고정폭 글꼴, 4칸 = 한 단계).
  async function readEditor(win) {
    const W = video.videoWidth, H = video.videoHeight;
    // 왼쪽 줄 번호 칸(폭의 약 5%)은 뺀다
    const sx = (win.x + win.w * 0.05) * W, sy = (win.y + win.barH) * H, sw = win.w * 0.95 * W, sh = (win.h - win.barH) * H;
    if (sw < 10 || sh < 10) return { lines: [], text: "" };
    const c = document.createElement("canvas");
    c.width = Math.round(sw * 3);
    c.height = Math.round(sh * 3);
    c.getContext("2d").drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const r = await ask({ type: "ocr", image: c.toDataURL("image/jpeg", 0.95).split(",")[1], lang: el.lang.value }, 15000);
    const ls = (r.lines || []).slice().sort((p1, p2) => p1.y - p2.y);
    if (!ls.length) return { lines: [], text: "" };
    const charW = ls.reduce((t, l) => t + l.w / Math.max(1, l.text.length), 0) / ls.length;
    const minX = Math.min(...ls.map((l) => l.x));
    const out = ls.map((l) => " ".repeat(Math.max(0, Math.round((l.x - minX) / (charW * 4))) * 4) + l.text.trim());
    return { lines: out, text: out.join("\n") };
  }

  // 비교용으로 고른다: OCR 이 흔히 헷갈리는 것과 띄어쓰기를 무시한다. 들여쓰기 단계는 남긴다.
  const normCode = (t) =>
    String(t)
      .replace(/\t/g, "    ")
      .split("\n")
      .map((l) => l.replace(/\s+$/, ""))
      .filter((l) => l.trim())
      .map((l) => `${Math.floor((l.length - l.trimStart().length) / 4)}|${l.trim().replace(/\s+/g, "").replace(/[‘’`]/g, "'").replace(/[“”]/g, '"').replace(/[|l]/g, "1").replace(/O/g, "0")}`)
      .join("\n");

  function sameCode(want, got) {
    const A = normCode(want), B = normCode(got);
    if (A === B) return true;
    // 글자 몇 개 틀린 건 OCR 탓일 수 있다 — 줄 수가 같고 95% 넘게 같으면 같은 걸로 본다
    const al = A.split("\n"), bl = B.split("\n");
    if (al.length !== bl.length) return false;
    let same = 0, all = 0;
    al.forEach((x, i) => {
      const y = bl[i];
      all += Math.max(x.length, y.length);
      for (let j = 0; j < Math.min(x.length, y.length); j++) if (x[j] === y[j]) same++;
    });
    return all > 0 && same / all > 0.95;
  }

  async function runWindow(win) {
    const btn = barButtons(win)[0];
    if (!btn || btn[0] > win.x + win.w * 0.2) return { text: "▶ 버튼을 못 찾음" };
    const before = tinyFrame();
    const r = await sendClick(btn[0], btn[1], "left", `▶ '${win.name}' 실행`);
    mark(btn[0], btn[1], r.at ? true : false, "▶");
    if (r.halted) return { text: "ESC 로 막힘", stop: true };
    if (r.error) return { text: `▶ 누르기 실패: ${r.error}` };
    if (!r.live) return { text: "▶ 누름 (안전모드라 실제로 누르진 않음)" };
    // 드론이 움직이거나 오류가 뜰 시간을 준다
    await sleep(2000);
    const moved = frameDiff(before, tinyFrame());
    const all = await ocrNow();
    const errs = all.filter((l) => /error|exception|invalid|unknown|not defined|expected|오류|에러/i.test(l.text)).map((l) => l.text);
    return {
      text: `▶ 실행함 — 화면 변화 ${moved.toFixed(1)}${errs.length ? ` · 오류로 보이는 글자: ${errs.slice(0, 3).join(" / ")}` : " · 오류 글자 없음"}`,
    };
  }

  async function writeAndRun(win, code, run) {
    // 제목줄 바로 아래 편집 칸 (줄 번호 칸을 피해 폭 15% 안쪽). 이름(main)을 누르면 이름 바꾸기가 된다.
    const ex = win.x + win.w * 0.15, ey = win.y + win.barH + Math.min(0.03, (win.h - win.barH) * 0.3);
    const steps = [];
    let editor = { text: "" };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rc = await sendClick(ex, ey, "left", `✎ '${win.name}' 편집 칸 누르기 (${attempt}번째)`);
      if (rc.halted) return { text: "ESC 로 막힘", stop: true };
      if (rc.error) return { text: `편집 칸 클릭 실패: ${rc.error}` };
      mark(ex, ey, true, "✎");
      await sleep(200);
      // 있던 코드를 통째로 바꾼다
      const ra = await ask({ type: "key", key: "ctrl+a", why: `Ctrl+A — '${win.name}' 코드 전체 선택` });
      if (ra.halted) return { text: "ESC 로 막힘", stop: true };
      const rp = await ask({ type: "paste", text: code, why: `붙여넣기 → '${win.name}'` }, 20000);
      if (rp.halted) return { text: "ESC 로 막힘", stop: true };
      if (rp.error) return { text: `붙여넣기 실패: ${rp.error}` };
      if (!rp.live) return { text: `'${win.name}' 에 ${rp.typed}글자 붙여넣기 (안전모드라 실제로 넣진 않음)` };
      await sleep(400);
      setPhase("👁 쓴 코드 다시 읽는 중");
      editor = await readEditor(win);
      if (sameCode(code, editor.text)) {
        steps.push(`${attempt}번째에 편집기 글자가 쓴 코드와 같음`);
        break;
      }
      steps.push(`${attempt}번째: 편집기 글자가 다름 → ${attempt < 2 ? "다시 붙여넣기" : "멈춤"}`);
      if (attempt === 2) {
        return {
          text: `'${win.name}' 에 쓴 코드가 편집기에 다르게 보임 — 실행하지 않음. 편집기에 보이는 것:\n${editor.text || "(빈칸)"}`,
          tries: steps,
        };
      }
    }
    if (!run) return { text: `'${win.name}' 에 코드 씀 (실행은 안 함)`, tries: steps };
    setPhase("▶ 실행하는 중");
    const rr = await runWindow(win);
    return { ...rr, text: `'${win.name}' 에 코드 쓰고 확인 → ${rr.text}`, tries: steps };
  }

  // 행동 하나를 브릿지로 보낸다. 결과를 한국어 한 줄로 돌려준다.
  async function act(a, view) {
    setPhase(a?.type === "wait" ? "⏳ 기다리는 중" : a?.type === "type" || a?.type === "code" ? "⌨ 입력하는 중" : a?.type === "key" ? "⌨ 키 누르는 중" : a?.type === "scroll" ? "🖱 스크롤하는 중" : "🖱 누르는 중");
    const live = el.live.textContent === "실제 입력";
    const sent = live ? "보냄" : "보냄 (안전모드라 실제로 누르진 않음)";
    let r;
    switch (a?.type) {
      case "click": {
        const l = view.lines[a.target];
        if (!l) return { text: `${a.target}번 줄이 없음` };
        if (FORBIDDEN_TEXT.test(l.text)) return { text: `"${l.text}" 는 게임을 나가는 글자라 누르지 않음 (금지)` };
        if (docsOpenNow && isDocHeading(l.text)) return { text: `"${l.text}" 는 섹션 제목이라 누르지 않음 — 그 아래 이름을 고르세요` };
        if (l.inPicture) return { text: `"${l.text}" 는 설명서 속 그림 안의 글자라 누르지 않음` };
        if (l.windowName) return { text: `"${l.text}" 는 창 이름이라 누르지 않음 (누르면 이름 바꾸기) — 코드는 "code" 행동으로` };
        if (plainInWindow(l)) return { text: `"${l.text}" 는 창 안의 일반 글자(링크 아님)라 누르지 않음 — 초록 링크를 고르세요` };
        return clickUntilChange(nudges(l, view.w, view.h), a.button === "right" ? "right" : "left", `${l.link ? "링크" : "글자"} [${a.target}] "${l.text}"`);
      }
      case "button": {
        // 10-28: '+' 를 계속 눌러 코드 창(f0, f1, f3 …)을 무한히 만들었다. 코드 창이 하나라도 있으면 더 만들지 않는다.
        if (a.name === "add") {
          const codes = analyzeLayout().windows.filter((w2) => w2.kind === "code").map((w2) => w2.name);
          if (codes.length) return { text: `코드 창이 이미 있음 (${codes.join(", ")}) — 새로 만들지 않음. 있는 창에 "code" 로 쓰세요` };
        }
        const found = findTopButtons();
        const at = found[a.name];
        if (!at) return { text: `'${a.name}' 버튼을 화면에서 못 찾음 (찾은 것: ${Object.keys(found).join(", ") || "없음"})` };
        const hint = FARM_UI_HINTS.find((h) => h.button === a.name);
        return clickUntilChange([at], "left", `오른쪽 위 ${hint ? hint.name : a.name}`);
      }
      case "back": {
        const win = docsWindow(analyzeLayout());
        if (!win) return { text: "정보 창이 없음" };
        return { text: await goBack(win) };
      }
      case "close_window": {
        const win = windowByName(analyzeLayout(), a.window);
        if (!win) return { text: `'${a.window}' 창이 없음` };
        const btn = barButtons(win).pop();
        if (!btn || btn[0] < win.x + win.w * 0.7) return { text: `'${a.window}' 의 ✕ 를 못 찾음` };
        const r3 = await sendClick(btn[0], btn[1], "left", `✕ '${a.window}' 닫기`);
        mark(btn[0], btn[1], r3.at ? true : false, "✕");
        if (r3.halted) return { text: "ESC 로 막힘", stop: true };
        if (r3.error) return { text: `✕ 누르기 실패: ${r3.error}` };
        return { text: `'${a.window}' 닫음${r3.live ? "" : " (안전모드라 실제로 누르진 않음)"}` };
      }
      case "code": {
        const lay = analyzeLayout();
        const win = windowByName(lay, a.window);
        if (!win) return { text: `'${a.window}' 창이 없음` };
        if (win.kind && win.kind !== "code") return { text: `'${a.window}' 는 코드 창이 아님` };
        return writeAndRun(win, String(a.text ?? ""), a.run !== false);
      }
      case "run": {
        const win = windowByName(analyzeLayout(), a.window);
        if (!win) return { text: `'${a.window}' 창이 없음` };
        return runWindow(win);
      }
      case "move_window": {
        const lay = analyzeLayout();
        const win = windowByName(lay, a.window);
        if (!win) return { text: `'${a.window}' 창이 없음` };
        if (!lay.field) return { text: "밭 위치를 몰라 옮길 곳을 못 정함" };
        if (!win.handle) return { text: "창 제목줄에서 잡을 곳을 못 찾음" };
        const to = placeAway(win, lay.field, lay.windows.filter((o) => o !== win));
        if (!to) return { text: `'${a.window}' 를 다른 창과 안 겹치게 놓을 빈자리가 없음` };
        const [hx, hy] = win.handle;
        const r2 = await ask({ type: "drag", x1: hx, y1: hy, x2: hx + (to.x - win.x), y2: hy + (to.y - win.y), why: `창 '${a.window}' 옮기기`, cw: video.videoWidth, ch: video.videoHeight });
        if (r2.halted) return { text: "ESC 로 막힘", stop: true };
        if (r2.error) return { text: `실패: ${r2.error}` };
        mark(hx + (to.x - win.x), hy + (to.y - win.y), true, "↘");
        return { text: `'${a.window}' 를 (${pct(to.x)}%,${pct(to.y)}%) 로 옮김${r2.live ? "" : " (안전모드라 실제로 끌진 않음)"}` };
      }
      case "click_at": {
        if (insideWindowBody(Number(a.x), Number(a.y))) {
          mark(Number(a.x), Number(a.y), false, "🖼");
          return { text: "창 안의 그림·빈 곳이라 누르지 않음 — 창 안에서는 글자 링크(OCR 번호)를 고르세요" };
        }
        // 아이콘은 위치가 대충이라 둘레를 조금씩 돌며 눌러본다 (화면 폭의 1.5% 간격)
        const x = Number(a.x), y = Number(a.y), s = 0.015;
        const pts = [[x, y], [x, y - s], [x, y + s], [x - s, y], [x + s, y]];
        return clickUntilChange(pts.map(([px, py]) => [Math.min(1, Math.max(0, px)), Math.min(1, Math.max(0, py))]), a.button === "right" ? "right" : "left", `좌표 클릭 (${Math.round(x * 100)}%, ${Math.round(y * 100)}%)`);
      }
      case "scroll": {
        // 휠은 커서 밑에서만 먹는다. 줄 번호가 있으면 그 줄 위, 좌표가 있으면 거기, 둘 다 없으면 화면 가운데.
        const l = a.target != null ? view.lines[a.target] : null;
        const fx = l ? (l.x + l.w / 2) / view.w : a.x != null ? Number(a.x) : 0.5;
        const fy = l ? (l.y + l.h / 2) / view.h : a.y != null ? Number(a.y) : 0.5;
        const n = Math.min(10, Math.max(1, Number(a.amount) || 3)) * (a.direction === "up" ? -1 : 1);
        const before = tinyFrame();
        r = await ask({ type: "scroll", x: fx, y: fy, clicks: n, why: `스크롤 ${n > 0 ? "아래" : "위"} ${Math.abs(n)}칸${l ? ` — "${l.text}" 위에서` : ""}`, cw: video.videoWidth, ch: video.videoHeight });
        if (r.halted) return { text: "ESC 로 막힘", stop: true };
        if (r.no_window) return { text: `'${el.window.value}' 창을 못 찾음`, stop: true };
        if (r.error) return { text: `실패: ${r.error}` };
        mark(fx, fy, null, n > 0 ? "▼" : "▲");
        if (!r.live) return { text: "보냄 (안전모드라 실제로 스크롤하진 않음)" };
        await sleep(500);
        const diff = frameDiff(before, tinyFrame());
        // 끝까지 내려가 있으면 아무것도 안 바뀐다. LLM 이 다음 걸음에서 그걸 알 수 있게 그대로 알려준다.
        return { text: diff > 1.5 ? `스크롤됨 (변화 ${diff.toFixed(1)})` : `화면 변화 없음 — 이미 끝이거나 스크롤되는 곳이 아님 (변화 ${diff.toFixed(1)})` };
      }
      case "type":
        r = await ask({ type: "type", text: String(a.text ?? ""), why: "글자 입력" }, 60000);
        break;
      case "key":
        r = await ask({ type: "key", key: String(a.key ?? ""), why: `키 ${a.key}` });
        break;
      case "wait":
        await sleep(Math.min(10, Math.max(1, Number(a.seconds) || 2)) * 1000);
        return { text: "기다림" };
      case "done":
        return { text: "끝냄", stop: true };
      default:
        return { text: "모르는 행동이라 건너뜀" };
    }
    if (r.halted) return { text: "ESC 로 막힘", stop: true };
    if (r.no_window) return { text: `'${el.window.value}' 창을 못 찾음`, stop: true };
    if (r.error) return { text: `실패: ${r.error}` };
    return { text: r.ok === false ? "실패" : sent };
  }

  // ---- 설명서 한 쪽 끝까지 읽기 ----
  // LLM 은 스크롤도, 다 읽은 뒤 돌아가기도 잘 안 한다. 설명서 한 쪽이 열려 있으면 코드가 정해진 순서로 한다:
  //   보이는 부분 읽기 → 본문 위에서 아래로 스크롤 → 화면이 안 바뀌면 끝 → 왼쪽 위 ↩ 로 목차로 돌아가기.
  // 다 읽은 쪽은 dict.pagesRead 에 남겨 LLM 에게 '다시 열지 마' 로 알린다.

  // 창 제목줄의 올리브 버튼들 (왼쪽부터). 정보 창은 맨 왼쪽이 ↩, 오른쪽 둘이 ─ ✕.
  function barButtons(win) {
    const W = video.videoWidth, H = video.videoHeight;
    // 버튼 한가운데는 흰 그림(↩ ─ ✕ ▶)이 지나가므로 위·가운데·아래 세 줄 중 하나라도 올리브면 버튼으로 친다
    const y = Math.round((win.y + win.barH / 2) * H);
    const dy = Math.max(2, Math.round(win.barH * H * 0.3));
    const c = document.createElement("canvas");
    c.width = W;
    c.height = dy * 2 + 1;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, 0, y - dy, W, dy * 2 + 1, 0, 0, W, dy * 2 + 1);
    const d = g.getImageData(0, 0, W, dy * 2 + 1).data;
    const ol = (i) => Math.abs(d[i] - 96) < 22 && Math.abs(d[i + 1] - 115) < 22 && d[i + 2] < 45;
    const olive = (x) => [0, dy, dy * 2].some((row) => ol((row * W + x) * 4));
    const out = [];
    let a = -1;
    const x0 = Math.round(win.x * W), x1 = Math.round((win.x + win.w) * W);
    for (let x = x0; x <= x1 + 1; x++) {
      const on = x <= x1 && olive(x);
      if (on && a < 0) a = x;
      if (!on && a >= 0) {
        if (x - a > W * 0.008) out.push([(a + x) / 2 / W, y / H]);
        a = -1;
      }
    }
    return out;
  }

  // 가장 큰 창을 정보 창으로 본다 (설명서가 열려 있을 때 화면에서 제일 크다)
  const docsWindow = (lay) => lay.windows.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0];

  async function ocrNow() {
    const ocr = await ask({ type: "ocr", image: grab(0, 2), lang: el.lang.value }, 20000);
    return classifyLines(ocr.lines || [], ocr.w || video.videoWidth * 2, ocr.h || video.videoHeight * 2);
  }

  async function goBack(win) {
    const btn = barButtons(win)[0];
    if (!btn || btn[0] > win.x + win.w * 0.2) return "왼쪽 위 ↩ 버튼을 못 찾음";
    const r = await sendClick(btn[0], btn[1], "left", "↩ 정보 창 목차로 돌아가기");
    mark(btn[0], btn[1], r.at ? true : false, "↩");
    if (r.error) return `↩ 누르기 실패: ${r.error}`;
    return `↩ 눌러 목차로${r.live ? "" : " (안전모드라 실제로 누르진 않음)"}`;
  }

  async function readWholePage(n, firstLines) {
    const lay = analyzeLayout();
    const win = docsWindow(lay);
    if (!win) return { text: "정보 창을 못 찾음" };
    const title = (firstLines.find((l) => l.inBody && !l.inPicture)?.text || "?").trim();
    const rows = [];
    let learned = 0;
    let lines = firstLines;
    const ctxOf = () => ({ at: new Date().toISOString(), n, screen: "docs" });
    for (let i = 0; i < 8 && agentOn; i++) {
      // 첫 화면은 check() 가 이미 읽었다. 스크롤한 뒤부터 읽는다.
      if (i > 0) {
        setPhase(`📖 '${title}' 읽는 중 (${i + 1}쪽째)`);
        lines = await ocrNow();
        const d = await readDocs(lines, el.model.value);
        if (d.terms?.length) {
          const rep2 = learn(d.terms, "LLM", ctxOf());
          learned += rep2.added.length + rep2.filled.length;
          rows.push(`${i + 1}쪽째: ${d.terms.map((t) => t.name).join(", ")}`);
        }
      }
      setPhase(`📜 '${title}' 스크롤`);
      const before = tinyFrame();
      const cx = win.x + win.w / 2, cy = win.y + win.barH + (win.h - win.barH) / 2;
      const r = await ask({ type: "scroll", x: cx, y: cy, clicks: 5, why: `📜 설명서 '${title}' 아래로 스크롤 (${i + 1}번째)`, cw: video.videoWidth, ch: video.videoHeight });
      if (r.halted || !agentOn) return { text: "ESC 로 막힘", stop: true };
      if (r.error) { rows.push(`스크롤 실패: ${r.error}`); break; }
      mark(cx, cy, null, "▼");
      if (!r.live) { rows.push("안전모드라 실제로 스크롤하진 않음"); break; }
      await sleep(600);
      const diff = frameDiff(before, tinyFrame());
      if (diff < 1.5) { rows.push(`끝까지 읽음 (스크롤 ${i + 1}번)`); break; }
    }
    const back = await goBack(win);
    rows.push(back);
    dict.pagesRead = [...new Set([...(dict.pagesRead || []), title])].slice(-200);
    saveDict();
    return { text: `설명서 '${title}' 끝까지 읽고 돌아감 — 새로 배운 것 ${learned}개`, rows };
  }

  async function agentStart() {
    if (agentOn) return;
    if (!stream) return setStatus("먼저 화면 공유를 해주세요", "bad");
    if (!(await ensureBridge())) return setStatus("브릿지에 연결하지 못했습니다", "bad");
    if (!el.model.value) return (el.agentState.textContent = "자율 플레이는 LLM 이 있어야 합니다 — 모델을 고르세요");
    el.auto.checked = false;
    scheduleAuto();
    await ask({ type: "set_window", window: el.window.value.trim() });
    await ask({ type: "resume" });
    agentOn = true;
    agentStep = 0;
    history = [];
    el.agentBar.hidden = false;
    el.agentGoal.textContent = `목표: ${el.goal.value.trim()}`;
    el.agentRun.disabled = true;
    el.agentRun.textContent = "자율 플레이 중…";
    el.check.disabled = true;
    setPhase("시작하는 중");
    if (el.live.textContent !== "실제 입력") {
      logger.push('<span class="bad">브릿지가 안전모드입니다 — 실제로 클릭·입력하지 않습니다.</span> 실제로 누르려면 <code>.\\start.ps1 -Live</code> 로 다시 켜세요', "warn");
    }
    logger.push(`<span class="tag">자율 시작</span> 목표: ${esc(el.goal.value.trim())}`, "win");
    agentLoop();
  }

  function agentStop(reason) {
    if (!agentOn) return;
    agentOn = false;
    el.agentBar.hidden = true;
    el.agentRun.disabled = false;
    el.agentRun.textContent = "▶ 자율 시작";
    el.check.disabled = false;
    el.agentState.textContent = `멈춤 — ${reason}`;
    setStatus(`자율 플레이 멈춤 — ${reason}`, reason === "ESC" || reason.startsWith("목표") ? "" : "bad");
    logger.push(`<span class="tag">자율 정지</span> ${esc(reason)} (${agentStep}걸음)`, "warn");
    if (connected()) ws.send(JSON.stringify({ type: "stop" }));
  }

  async function agentLoop() {
    const max = Math.max(1, Number(el.maxSteps.value) || 30);
    let fails = 0;
    while (agentOn) {
      if (agentStep >= max) return agentStop(`최대 ${max}걸음에 닿음`);
      const n = ++agentStep;
      const stepT0 = performance.now();
      el.agentState.textContent = `${n}/${max}걸음 — 보는 중`;
      // 밭이 먼저다: 창이 밭을 가리면 LLM 에게 묻기 전에 코드가 치운다
      setPhase("🪟 밭을 가린 창 치우는 중");
      const moved = await clearField();
      if (!agentOn) return;
      if (moved.length) {
        logger.push(`<span class="tag">자율 ${n}</span> 밭 먼저` + moved.map((m) => why(esc(m))).join(""));
        await sleep(500);
      }
      if (n === 1) el.agentStepEl.textContent = `1/${max}걸음`;
      const view = await check(n);
      if (!agentOn) return;
      if (view?.screen === "title" && n > 1) return agentStop("메인 메뉴(타이틀)로 나와서 멈춤 — 게임을 나가지 않게");
      // 설명서 한 쪽(목차 아님)이 열려 있으면 LLM 행동 대신 끝까지 읽고 돌아간다
      if (view && docsOpenNow && !INDEX_CUES.test(view.lines.map((l) => l.text).join("\n"))) {
        const res = await readWholePage(n, view.lines);
        history.push({ step: n, screen: "docs", plan: "설명서 한 쪽을 끝까지 읽는다", action: "스크롤하며 읽고 ↩", result: res.text });
        if (history.length > 8) history.shift();
        logger.push(`<span class="tag">자율 ${n}</span> 📖 ${esc(res.text)}` + (res.rows || []).map((r) => why(esc(r))).join(""), "win");
        if (res.stop) return agentStop("ESC");
        await sleep(800);
        continue;
      }
      const llm = view?.llm;
      if (!llm?.action) {
        fails++;
        logger.push(`<span class="tag">자율 ${n}</span> <span class="bad">LLM 이 행동을 정하지 못했습니다</span> (${fails}/3)`, "warn");
        if (fails >= 3) return agentStop("LLM 이 3번 연속 행동을 못 정함");
        await sleep(2000);
        continue;
      }
      fails = 0;
      const what = describe(llm.action, view.lines);
      el.agentState.textContent = `${n}/${max}걸음 — ${what}`;
      const res = await act(llm.action, view);
      history.push({ step: n, screen: view.screen, plan: String(llm.plan || "").slice(0, 160), action: what, result: res.text });
      if (history.length > 8) history.shift();
      logger.push(
        `<span class="tag">자율 ${n}</span> ${esc(what)}` +
          why(`생각: ${esc(llm.plan || "-")}`) +
          why(`기대: ${esc(llm.expect || "-")}`) +
          why(`결과: ${esc(res.text)}`) +
          (res.tries || []).map((t) => why(`<span class="dim">${esc(t)}</span>`)).join(""),
        res.stop ? "warn" : ""
      );
      if (res.stop) return agentStop(llm.action.type === "done" ? `목표 끝 — ${llm.action.why || ""}` : res.text);
      // 화면이 바뀔 틈을 준다
      setPhase("⏳ 화면이 바뀌길 기다리는 중");
      el.agentStepEl.textContent = `${agentStep}/${max}걸음 · 걸음당 ${((performance.now() - stepT0) / 1000).toFixed(1)}초`;
      await sleep(1200);
    }
  }

  // ---- 마우스 조작 ----
  async function start() {
    if (!stream) return setStatus("먼저 화면 공유를 해주세요", "bad");
    if (!(await ensureBridge())) return setStatus("브릿지에 연결하지 못했습니다", "bad");
    await ask({ type: "set_window", window: el.window.value.trim() });
    await ask({ type: "resume" });
    running = true;
    setStatus("조작 중 — 화면을 클릭하면 게임을 클릭합니다 (ESC 로 정지)", "ok");
  }

  function stop() {
    running = false;
    if (connected()) ws.send(JSON.stringify({ type: "stop" }));
    setStatus("정지됨", "");
  }

  async function click(ev, button) {
    if (!running) return;
    ev.preventDefault();
    const r = el.view.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const res = await sendClick(x, y, button, "손으로 누른 자리");
    if (res.halted) return;
    if (res.no_window) return setStatus(`'${el.window.value}' 창을 찾지 못했습니다 — 대상 창 이름을 확인하세요`, "bad");
    if (res.error) setStatus(res.error, "bad");
    mark(x, y, res.at ? null : false);
    el.last.textContent = res.at ? `${button === "right" ? "오른쪽 " : ""}${res.at[0]}, ${res.at[1]} (${res.basis})` : "실패";
  }

  // ---- 매뉴얼 = 몰리가 배운 문법 사전 ----
  function buildDictUi() {
    el.manual.innerHTML = `
      <div class="dict-head">
        <div>
          <h3>매뉴얼 — 몰리가 화면에서 배운 이 게임의 문법</h3>
          <p class="dim" id="fmDictSum">-</p>
        </div>
        <div class="controls">
          <button id="fmDictExport">JSON 내려받기</button>
          <button id="fmDictClear" class="btn-ghost">사전 비우기</button>
        </div>
      </div>
      <div class="controls">
        <input type="text" id="fmDictQ" placeholder="찾기: 이름, 뜻" />
        <select id="fmDictKind"><option value="">모든 종류</option>${Object.entries(TERM_KINDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
        <label class="checkbox"><input type="checkbox" id="fmDictUnknown" /> 뜻 모르는 것만</label>
      </div>
      <div id="fmDictList" class="dict-list"></div>`;
    for (const id of ["fmDictSum", "fmDictQ", "fmDictKind", "fmDictUnknown", "fmDictList"]) dictEl[id] = $(id);
    dictEl.fmDictQ.addEventListener("input", renderDict);
    dictEl.fmDictKind.addEventListener("change", renderDict);
    dictEl.fmDictUnknown.addEventListener("change", renderDict);
    $("fmDictExport").addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(dict, null, 1)], { type: "application/json" }));
      a.download = "farm_dict.json";
      a.click();
    });
    $("fmDictClear").addEventListener("click", () => {
      if (!confirm("몰리가 배운 사전을 모두 지울까요? 되돌릴 수 없습니다.")) return;
      dict = { game: dict.game, updated: new Date().toISOString(), entries: {} };
      logger.push('<span class="bad">사전을 비웠습니다</span>');
      saveDict();
    });
  }

  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "-" : d.toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  };
  const FIELD_NAME = { signature: "형태", meaning: "뜻", example: "예시" };

  function renderDict() {
    if (!dictEl.fmDictList) return;
    const all = Object.values(dict.entries);
    const known = all.filter((e) => e.meaning).length;
    const byKind = Object.entries(TERM_KINDS)
      .map(([k, v]) => [v, all.filter((e) => e.kind === k).length])
      .filter(([, c]) => c)
      .map(([v, c]) => `${v} ${c}`)
      .join(" · ");
    dictEl.fmDictSum.textContent = all.length
      ? `단어 ${all.length}개 (뜻까지 아는 것 ${known}개) — ${byKind} · 마지막으로 배운 때 ${when(dict.updated)}`
      : "아직 배운 것이 없습니다. 화면 확인을 하면 코드 창·설명서에서 단어를 주워 옵니다.";

    const q = dictEl.fmDictQ.value.trim().toLowerCase();
    const kind = dictEl.fmDictKind.value;
    const list = all
      .filter((e) => !kind || e.kind === kind)
      .filter((e) => !dictEl.fmDictUnknown.checked || !e.meaning)
      .filter((e) => !q || [e.name, e.meaning, e.signature].some((v) => String(v).toLowerCase().includes(q)))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

    dictEl.fmDictList.innerHTML = list.length
      ? list.map((e) => `
        <article class="dict-entry">
          <header>
            <code class="dict-name">${esc(e.signature && !e.signature.endsWith("(…)") ? e.signature : e.name)}</code>
            <span class="dict-kind">${TERM_KINDS[e.kind] || e.kind}${e.kindGuess ? "?" : ""}</span>
            <span class="dim dict-seen">${e.seen}번 봄</span>
          </header>
          <p>${e.meaning ? esc(e.meaning) : '<span class="dim">뜻 모름 — 화면에서 쓰이는 것만 봤습니다</span>'}</p>
          ${e.example ? `<pre class="dict-ex">${esc(e.example)}</pre>` : ""}
          <details>
            <summary>어떻게 배웠나 — 처음 ${when(e.first)}, 마지막 ${when(e.last)}</summary>
            <ul>${e.sources.map((x) => `<li>${x.check ? `#${x.check}` : "직접"} ${when(x.at)} · ${byId[x.screen]?.name || x.screen} · ${esc(x.how)} <span class="dim">← ${esc(x.from || "출처 없음")}</span></li>`).join("")}</ul>
            ${e.changes.length ? `<p class="dim">바뀐 기록</p><ul>${e.changes.map((c) => `<li>#${c.check} ${when(c.at)} ${FIELD_NAME[c.field]}: <span class="dim">${esc(c.old)}</span> → ${esc(c.now)}</li>`).join("")}</ul>` : ""}
          </details>
        </article>`).join("")
      : `<p class="dim">${all.length ? "조건에 맞는 단어가 없습니다" : ""}</p>`;
  }

  // ---- 연결 ----
  document.querySelectorAll(".fm-menu-btn").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll(".fm-menu-btn").forEach((x) => x.classList.toggle("is-active", x === b));
      document.querySelectorAll(".fm-sec").forEach((s) => s.classList.toggle("is-active", s.dataset.sec === b.dataset.sec));
    })
  );
  el.share.addEventListener("click", share);
  el.check.addEventListener("click", () => check());
  el.agentRun.addEventListener("click", agentStart);
  el.agentStop.addEventListener("click", () => agentStop("정지 버튼"));
  el.agentStop2.addEventListener("click", () => agentStop("정지 버튼"));
  el.goal.value = load("goal", el.goal.value);
  el.goal.addEventListener("change", () => save("goal", el.goal.value));
  el.auto.addEventListener("change", scheduleAuto);
  el.every.addEventListener("change", scheduleAuto);
  el.model.addEventListener("change", () => save("model", el.model.value));
  el.lang.value = load("lang", "en-US");
  el.lang.addEventListener("change", () => save("lang", el.lang.value));
  el.run.addEventListener("click", start);
  el.stop.addEventListener("click", stop);
  el.view.addEventListener("click", (e) => click(e, "left"));
  el.view.addEventListener("contextmenu", (e) => click(e, "right"));
  el.view.addEventListener(
    "wheel",
    async (e) => {
      if (!running) return;
      e.preventDefault();
      const r = el.view.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      const res = await ask({ type: "scroll", x: fx, y: fy, clicks: e.deltaY > 0 ? 1 : -1, why: "손으로 굴린 휠", cw: video.videoWidth, ch: video.videoHeight });
      if (res.error) setStatus(res.error, "bad");
      mark(fx, fy, null, e.deltaY > 0 ? "▼" : "▲");
    },
    { passive: false }
  );
  document.addEventListener("gamechange", () => {
    if (document.getElementById("panel-farm").classList.contains("is-active")) return;
    if (running) stop();
    agentStop("다른 게임으로 넘어감");
    el.auto.checked = false;
    scheduleAuto();
  });
  buildDictUi();
  loadDict();
  requestAnimationFrame(draw);
})();
