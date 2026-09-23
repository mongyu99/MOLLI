const env = new GridWorld(10, 150);
const brain = new FlyBrain({ nInputs: 5, nKC: 200, sparsity: 0.1, nActions: 5, lr: 0.15, gamma: 0.9 });

let obs = env.reset(true);
let epsilon = 1.0;
const EPS_MIN = 0.05;
const EPS_DECAY = 0.985; // 에피소드마다 곱해짐

let running = false;
let timer = null;
let episode = 0;
let episodeReward = 0;
let lastDopamine = 0;
let history = []; // { reward, steps, found }

const boardCanvas = document.getElementById("board");
const bctx = boardCanvas.getContext("2d");
const chartCanvas = document.getElementById("chart");
const cctx = chartCanvas.getContext("2d");

const logger = createLogger("scentLog");
const ACTION_NAMES = ["제자리", "위", "아래", "왼쪽", "오른쪽"];
let hoverIndex = null;

const el = {
  episode: document.getElementById("stEpisode"),
  step: document.getElementById("stStep"),
  eps: document.getElementById("stEps"),
  dopamine: document.getElementById("stDopamine"),
  success: document.getElementById("stSuccess"),
  avgSteps: document.getElementById("stAvgSteps"),
  btnStart: document.getElementById("btnStart"),
  btnStep: document.getElementById("btnStep"),
  btnReset: document.getElementById("btnReset"),
  speed: document.getElementById("speed"),
  randomGem: document.getElementById("randomGem"),
  logOn: document.getElementById("scentLogOn"),
  readout: document.getElementById("chartReadout"),
};

function cellSize() {
  return boardCanvas.width / env.size;
}

// 타일마다 고정된 픽셀 노이즈 패턴 (돌/광물 블록 특유의 도트 질감을 흉내냄)
const NOISE_SUB = 4;
const TILE_NOISE = [];
for (let y = 0; y < env.size; y++) {
  const row = [];
  for (let x = 0; x < env.size; x++) {
    const cell = [];
    for (let i = 0; i < NOISE_SUB * NOISE_SUB; i++) cell.push(Math.random());
    row.push(cell);
  }
  TILE_NOISE.push(row);
}

function clamp255(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// 향기 세기 -> 어두운 돌(deepslate)에서 다이아몬드빛 청록 발광으로 보간
function scentColor(s) {
  const t = Math.min(1, s);
  const stone = [52, 52, 60];
  const glow = [86, 226, 216];
  return [
    stone[0] + (glow[0] - stone[0]) * t,
    stone[1] + (glow[1] - stone[1]) * t,
    stone[2] + (glow[2] - stone[2]) * t,
  ];
}

function drawBoard() {
  const cs = cellSize();
  const subSize = cs / NOISE_SUB;

  for (let y = 0; y < env.size; y++) {
    for (let x = 0; x < env.size; x++) {
      const [r, g, b] = scentColor(env.scentAt(x, y));
      const noise = TILE_NOISE[y][x];
      for (let iy = 0; iy < NOISE_SUB; iy++) {
        for (let ix = 0; ix < NOISE_SUB; ix++) {
          const n = noise[iy * NOISE_SUB + ix];
          const d = (n - 0.5) * 28; // 블록 표면 도트 질감용 명도 편차
          bctx.fillStyle = `rgb(${clamp255(r + d)}, ${clamp255(g + d)}, ${clamp255(b + d)})`;
          bctx.fillRect(
            Math.floor(x * cs + ix * subSize),
            Math.floor(y * cs + iy * subSize),
            Math.ceil(subSize) + 1,
            Math.ceil(subSize) + 1
          );
        }
      }
    }
  }

  // 블록 경계선
  bctx.strokeStyle = "rgba(0,0,0,0.45)";
  bctx.lineWidth = 1;
  for (let i = 0; i <= env.size; i++) {
    bctx.beginPath();
    bctx.moveTo(i * cs, 0);
    bctx.lineTo(i * cs, boardCanvas.height);
    bctx.stroke();
    bctx.beginPath();
    bctx.moveTo(0, i * cs);
    bctx.lineTo(boardCanvas.width, i * cs);
    bctx.stroke();
  }

  // 발자국 (페이드되는 작은 블록들)
  env.trail.forEach((p, i) => {
    const alpha = ((i + 1) / env.trail.length) * 0.45;
    const fs = cs * 0.2;
    bctx.fillStyle = `rgba(255,176,64,${alpha})`;
    bctx.fillRect(p.x * cs + cs / 2 - fs / 2, p.y * cs + cs / 2 - fs / 2, fs, fs);
  });

  drawGemBlock(env.gem.x * cs, env.gem.y * cs, cs);
  drawFlySprite(env.fly.x * cs, env.fly.y * cs, cs);
}

// 다이아몬드 광물처럼 위/좌/우 세 면을 음영으로 나눠 그리는 의사-3D 블록
function drawGemBlock(px, py, cs) {
  const pad = cs * 0.14;
  const w = cs - pad * 2;
  const topH = w * 0.42;
  const bodyH = w * 0.5;
  const x0 = px + pad;
  const y0 = py + pad * 0.6;
  const cx = x0 + w / 2;

  const top = [cx, y0];
  const right = [x0 + w, y0 + topH / 2];
  const bottom = [cx, y0 + topH];
  const left = [x0, y0 + topH / 2];

  bctx.fillStyle = "#a9f6f1";
  bctx.beginPath();
  bctx.moveTo(...top);
  bctx.lineTo(...right);
  bctx.lineTo(...bottom);
  bctx.lineTo(...left);
  bctx.closePath();
  bctx.fill();

  bctx.fillStyle = "#3fb8c4";
  bctx.beginPath();
  bctx.moveTo(...left);
  bctx.lineTo(...bottom);
  bctx.lineTo(bottom[0], bottom[1] + bodyH);
  bctx.lineTo(left[0], left[1] + bodyH);
  bctx.closePath();
  bctx.fill();

  bctx.fillStyle = "#1f7c8a";
  bctx.beginPath();
  bctx.moveTo(...right);
  bctx.lineTo(...bottom);
  bctx.lineTo(bottom[0], bottom[1] + bodyH);
  bctx.lineTo(right[0], right[1] + bodyH);
  bctx.closePath();
  bctx.fill();

  bctx.strokeStyle = "#0d3b42";
  bctx.lineWidth = 1.5;
  bctx.beginPath();
  bctx.moveTo(...top);
  bctx.lineTo(...right);
  bctx.lineTo(bottom[0], bottom[1] + bodyH);
  bctx.lineTo(left[0], left[1] + bodyH);
  bctx.lineTo(...left);
  bctx.closePath();
  bctx.moveTo(...bottom);
  bctx.lineTo(bottom[0], bottom[1] + bodyH);
  bctx.stroke();
}

// 8x8 격자 기준 블록형 벌/초파리 스프라이트
function drawFlySprite(px, py, cs) {
  const pad = cs * 0.15;
  const size = cs - pad * 2;
  const x0 = px + pad;
  const y0 = py + pad;
  const unit = size / 8;
  const block = (gx, gy, gw, gh, color) => {
    bctx.fillStyle = color;
    bctx.fillRect(x0 + gx * unit, y0 + gy * unit, gw * unit, gh * unit);
  };

  block(0, 1, 2, 2, "rgba(224,232,240,0.85)"); // 왼쪽 날개
  block(6, 1, 2, 2, "rgba(224,232,240,0.85)"); // 오른쪽 날개
  block(2, 1, 4, 5, "#a06a2a"); // 몸통
  block(2, 2, 4, 1, "#1a1208"); // 줄무늬
  block(2, 4, 4, 1, "#1a1208"); // 줄무늬
  block(2, 0, 1, 1, "#1a1208"); // 눈
  block(5, 0, 1, 1, "#1a1208"); // 눈

  bctx.strokeStyle = "#1a1208";
  bctx.lineWidth = 1.5;
  bctx.strokeRect(x0 + 2 * unit, y0 + 1 * unit, 4 * unit, 5 * unit);
}

// 다이아몬드 발견 시 블록 파괴 이펙트
function drawBurst(gx, gy, cs) {
  const cx = gx * cs + cs / 2;
  const cy = gy * cs + cs / 2;
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const dist = cs * 0.55;
    const bx = cx + Math.cos(angle) * dist;
    const by = cy + Math.sin(angle) * dist;
    const s = cs * 0.13;
    bctx.fillStyle = i % 2 === 0 ? "#a9f6f1" : "#ffffff";
    bctx.fillRect(bx - s / 2, by - s / 2, s, s);
  }
}

const CHART_WINDOW = 200;

function chartSlice() {
  const recent = history.slice(-CHART_WINDOW);
  const xStart = history.length - recent.length + 1; // 1부터 세는 에피소드 번호
  const rewards = recent.map((h) => h.reward);
  const avg = rewards.map((_, i) => {
    const s = rewards.slice(Math.max(0, i - 19), i + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
  return { rewards, avg, xStart };
}

function drawChart() {
  ChartUtil.fit(chartCanvas, 220);
  if (history.length < 2) {
    cctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);
    return;
  }
  const { rewards, avg, xStart } = chartSlice();
  ChartUtil.draw(chartCanvas, {
    xStart,
    hoverIndex,
    series: [
      { values: rewards, color: "#4fd8e0", width: 1.5 },
      { values: avg, color: "#ffb040", width: 2 },
    ],
  });
}

function updateStats() {
  el.episode.textContent = episode;
  el.step.textContent = env.steps;
  el.eps.textContent = epsilon.toFixed(2);
  el.dopamine.textContent = lastDopamine.toFixed(2);
  const recent = history.slice(-100);
  if (recent.length) {
    const successRate = (recent.filter((h) => h.found).length / recent.length) * 100;
    el.success.textContent = `${successRate.toFixed(0)}%`;
    const avgSteps = recent.reduce((a, h) => a + h.steps, 0) / recent.length;
    el.avgSteps.textContent = avgSteps.toFixed(1);
  }
}

function logStep(o, action, q, explored, reward, found) {
  if (!el.logOn.checked) return;
  const scents = `향기 ↑${o[1].toFixed(2)} ↓${o[2].toFixed(2)} ←${o[3].toFixed(2)} →${o[4].toFixed(2)}`;
  const why = explored
    ? `<span class="dim">무작위 탐험 ε${epsilon.toFixed(2)}</span>`
    : `Q ${fmtNum(q[action])} <span class="dim">(최대)</span>`;
  const outcome = found
    ? `<span class="good">다이아몬드 발견 ${fmtNum(reward)}</span>`
    : `보상 ${fmtNum(reward)}`;
  logger.push(
    `<span class="tag">E${episode + 1}·S${env.steps}</span> ` +
      `<span class="pick">${ACTION_NAMES[action]}</span> · ${scents} · ${why} · ${outcome} · DA ${fmtNum(lastDopamine)}`,
    found ? "win" : null
  );
}

function tick() {
  const prevObs = obs;
  const { action, activeKC, q, explored } = brain.act(obs, epsilon);
  const { obs: nextObs, reward, done, found } = env.step(action);
  lastDopamine = brain.learn(activeKC, action, reward, nextObs, done);
  logStep(prevObs, action, q, explored, reward, found);
  obs = nextObs;
  episodeReward += reward;

  drawBoard();
  if (found) drawBurst(env.gem.x, env.gem.y, cellSize());
  updateStats();

  if (done) {
    episode++;
    history.push({ reward: episodeReward, steps: env.steps, found });
    epsilon = Math.max(EPS_MIN, epsilon * EPS_DECAY);
    episodeReward = 0;
    obs = env.reset(el.randomGem.checked);
    drawChart();
  }
}

function speedToInterval(v) {
  return Math.max(5, 220 - Number(v));
}

function startLoop() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, speedToInterval(el.speed.value));
}

el.btnStart.addEventListener("click", () => {
  running = !running;
  el.btnStart.textContent = running ? "⏸ 일시정지" : "▶ 학습 시작";
  if (running) startLoop();
  else clearInterval(timer);
});

el.btnStep.addEventListener("click", () => {
  if (running) {
    running = false;
    el.btnStart.textContent = "▶ 학습 시작";
    clearInterval(timer);
  }
  tick();
});

el.btnReset.addEventListener("click", () => {
  obs = env.reset(el.randomGem.checked);
  episodeReward = 0;
  drawBoard();
});

el.speed.addEventListener("input", () => {
  if (running) startLoop();
});

el.logOn.addEventListener("change", () => logger.setEnabled(el.logOn.checked));

const READOUT_HINT = "그래프에 마우스를 올리면 해당 에피소드 값이 표시됩니다";

chartCanvas.addEventListener("mousemove", (e) => {
  if (history.length < 2) return;
  const { rewards, avg, xStart } = chartSlice();
  const i = ChartUtil.indexFromEvent(chartCanvas, e, rewards.length);
  hoverIndex = i;
  if (i === null) {
    el.readout.textContent = READOUT_HINT;
  } else {
    const h = history[history.length - rewards.length + i];
    el.readout.textContent =
      `${xStart + i}번째 에피소드 · 보상 ${rewards[i].toFixed(2)} · 20개 이동평균 ${avg[i].toFixed(2)} · ` +
      `${h.steps}스텝 · ${h.found ? "성공" : "실패"}`;
  }
  drawChart();
});

chartCanvas.addEventListener("mouseleave", () => {
  hoverIndex = null;
  el.readout.textContent = READOUT_HINT;
  drawChart();
});

window.addEventListener("resize", drawChart);

drawBoard();
updateStats();
drawChart();
