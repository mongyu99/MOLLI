// 지뢰찾기 탭: 사람이 직접 플레이할 수도 있고, 같은 초파리 뇌 구조로 학습시킬 수도 있다.
// 향기 추적과 달리 보상이 즉시 확정되므로(열어보면 지뢰인지 바로 알 수 있음) 부트스트랩 없이
// 한 수의 결과만으로 학습하는 밴딧 방식으로 두었다. Q값은 그 칸의 "안전도" 추정치가 된다.
(function () {
  const CELL = 48;
  const env = new MinesweeperEnv(9, 10);
  const brain = new FlyBrain({
    nInputs: MinesweeperEnv.PN_DIM,
    nKC: 500,
    sparsity: 0.06,
    nActions: 1,
    lr: 0.15,
    gamma: 0,
  });

  // 지뢰찾기는 무작위 탐험 한 번이 그대로 죽음이라 탐험률을 낮게 잡는다
  let epsilon = 0.08;
  const EPS_MIN = 0.01;
  const EPS_DECAY = 0.999;

  let running = false;
  let timer = null;
  let games = 0;
  let wins = 0;
  let lastDopamine = 0;
  let history = []; // { won, progress }
  let safety = new Map(); // "r,c" -> 예측 안전도

  const canvas = document.getElementById("mineBoard");
  const ctx = canvas.getContext("2d");
  const chart = document.getElementById("mineChart");
  const chartCtx = chart.getContext("2d");

  const el = {
    games: document.getElementById("msGames"),
    wins: document.getElementById("msWins"),
    winRate: document.getElementById("msWinRate"),
    progress: document.getElementById("msProgress"),
    dopamine: document.getElementById("msDopamine"),
    eps: document.getElementById("msEps"),
    status: document.getElementById("msStatus"),
    btnAi: document.getElementById("msBtnAi"),
    btnMove: document.getElementById("msBtnMove"),
    btnNew: document.getElementById("msBtnNew"),
    speed: document.getElementById("msSpeed"),
    showSafety: document.getElementById("msShowSafety"),
    logOn: document.getElementById("msLogOn"),
    readout: document.getElementById("mineChartReadout"),
  };

  const logger = createLogger("mineLog");
  let hoverIndex = null;
  let moveNo = 0;

  const NUM_COLORS = [
    null,
    "#6ab7ff",
    "#7fd858",
    "#ff7b6b",
    "#c39bff",
    "#ffb040",
    "#4fd8e0",
    "#eef1f5",
    "#b6b6c0",
  ];

  function bevelBlock(x, y, size, base, hi, lo) {
    const b = Math.max(3, Math.floor(size * 0.09));
    ctx.fillStyle = base;
    ctx.fillRect(x, y, size, size);
    ctx.fillStyle = hi;
    ctx.fillRect(x, y, size, b);
    ctx.fillRect(x, y, b, size);
    ctx.fillStyle = lo;
    ctx.fillRect(x, y + size - b, size, b);
    ctx.fillRect(x + size - b, y, b, size);
  }

  function drawMine(x, y, size, hit) {
    ctx.fillStyle = hit ? "#7a1f18" : "#2f2f36";
    ctx.fillRect(x, y, size, size);
    const u = size / 8;
    ctx.fillStyle = hit ? "#ff6b5b" : "#c0392b";
    ctx.fillRect(x + 2 * u, y + 2 * u, 4 * u, 4 * u);
    ctx.fillStyle = "#1a1208";
    ctx.fillRect(x + 3 * u, y + u, 2 * u, u);
    ctx.fillRect(x + 3 * u, y + 6 * u, 2 * u, u);
    ctx.fillRect(x + u, y + 3 * u, u, 2 * u);
    ctx.fillRect(x + 6 * u, y + 3 * u, u, 2 * u);
    ctx.fillStyle = "#ffd9d0";
    ctx.fillRect(x + 3 * u, y + 3 * u, u, u);
  }

  function drawFlag(x, y, size) {
    const u = size / 8;
    ctx.fillStyle = "#2b2b31";
    ctx.fillRect(x + 4 * u, y + 2 * u, u, 4 * u);
    ctx.fillStyle = "#ff7b6b";
    ctx.fillRect(x + 2 * u, y + 2 * u, 2 * u, 2 * u);
    ctx.fillStyle = "#1a1208";
    ctx.fillRect(x + 2 * u, y + 6 * u, 4 * u, u);
  }

  function safetyTint(q) {
    // q: -1(위험) ~ +1(안전)
    const t = Math.max(0, Math.min(1, (q + 1) / 2));
    const r = Math.round(220 * (1 - t) + 60 * t);
    const g = Math.round(60 * (1 - t) + 210 * t);
    return `rgba(${r}, ${g}, 90, 0.42)`;
  }

  function draw() {
    const showSafety = el.showSafety.checked && safety.size > 0;
    for (let r = 0; r < env.size; r++) {
      for (let c = 0; c < env.size; c++) {
        const x = c * CELL;
        const y = r * CELL;
        const gameOver = env.dead || env.won;

        if (env.revealed[r][c]) {
          ctx.fillStyle = "#33333b";
          ctx.fillRect(x, y, CELL, CELL);
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
          const n = env.count[r][c];
          if (n > 0) {
            ctx.fillStyle = NUM_COLORS[n];
            ctx.font = "24px NeoDunggeunmo, monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(n), x + CELL / 2, y + CELL / 2 + 2);
          }
        } else if (gameOver && env.mine[r][c]) {
          const hit = env.lastHit && env.lastHit.r === r && env.lastHit.c === c;
          drawMine(x, y, CELL, hit);
        } else {
          bevelBlock(x, y, CELL, "#6a6a74", "#8d8d99", "#43434c");
          if (env.flagged[r][c]) drawFlag(x, y, CELL);
          if (showSafety && !env.flagged[r][c]) {
            const q = safety.get(`${r},${c}`);
            if (q !== undefined) {
              ctx.fillStyle = safetyTint(q);
              ctx.fillRect(x + 6, y + 6, CELL - 12, CELL - 12);
            }
          }
        }
      }
    }

    if (env.won) el.status.textContent = "클리어!";
    else if (env.dead) el.status.textContent = "지뢰 밟음";
    else el.status.textContent = `진행률 ${(env.progress() * 100).toFixed(0)}%`;
  }

  function computeSafety() {
    safety = new Map();
    if (!env.minesPlaced || env.dead || env.won) return;
    const cm = env.certainMineMap();
    for (const [r, c] of env.frontierCandidates()) {
      const activeKC = brain.encode(env.observe(r, c, cm));
      safety.set(`${r},${c}`, brain.qValues(activeKC)[0]);
    }
  }

  function endGame() {
    games++;
    if (env.won) wins++;
    if (el.logOn.checked) {
      logger.push(
        `<span class="tag">G${games}</span> ${moveNo}수 만에 ` +
          (env.won
            ? `<span class="good">클리어</span>`
            : `<span class="bad">종료</span>`) +
          ` · 개방률 ${(env.progress() * 100).toFixed(0)}%`,
        env.won ? "win" : null
      );
    }
    history.push({ won: env.won, progress: env.progress() });
    epsilon = Math.max(EPS_MIN, epsilon * EPS_DECAY);
    moveNo = 0;
    env.reset();
    safety = new Map();
    drawChart();
  }

  function aiMove() {
    if (env.dead || env.won) {
      endGame();
      draw();
      updateStats();
      return;
    }

    // 첫 수는 정보가 없고 규칙상 항상 안전하므로 중앙을 열고 학습은 건너뛴다
    if (!env.minesPlaced) {
      env.reveal(Math.floor(env.size / 2), Math.floor(env.size / 2));
      computeSafety();
      draw();
      updateStats();
      return;
    }

    let cands = env.frontierCandidates();
    if (!cands.length) cands = env.candidates();
    if (!cands.length) {
      endGame();
      draw();
      updateStats();
      return;
    }

    const cm = env.certainMineMap();
    let best = null;
    let bestQ = -Infinity;
    safety = new Map();
    const encoded = new Map();
    for (const [r, c] of cands) {
      const activeKC = brain.encode(env.observe(r, c, cm));
      const q = brain.qValues(activeKC)[0];
      encoded.set(`${r},${c}`, activeKC);
      safety.set(`${r},${c}`, q);
      if (q > bestQ) {
        bestQ = q;
        best = [r, c];
      }
    }

    const explored = Math.random() < epsilon;
    const pick = explored ? cands[Math.floor(Math.random() * cands.length)] : best;
    const [pr, pc] = pick;
    const activeKC = encoded.get(`${pr},${pc}`);
    const ev = env.evidence(pr, pc, cm);
    const pickQ = safety.get(`${pr},${pc}`);
    const rank = [...safety.values()].filter((v) => v > pickQ).length + 1;

    const { hitMine, opened } = env.reveal(pr, pc);
    const reward = hitMine ? -1 : 1;
    // 즉시 확정되는 결과라 부트스트랩 없이(done=true) 도파민 신호를 그대로 반영
    lastDopamine = brain.learn(activeKC, 0, reward, null, true);
    moveNo++;
    logMove(pr, pc, pickQ, rank, cands.length, ev, explored, hitMine, opened);

    draw();
    updateStats();
  }

  function logMove(r, c, q, rank, total, ev, explored, hitMine, opened) {
    if (!el.logOn.checked) return;
    const why = explored
      ? `<span class="dim">무작위 탐험 ε${epsilon.toFixed(2)}</span>`
      : `안전도 ${fmtNum(q)} <span class="dim">(후보 ${total}개 중 ${rank}위)</span>`;
    const clue = ev.hasClue
      ? `인접단서 최소 지뢰비율 ${ev.minR.toFixed(2)}${ev.certain ? ' <span class="bad">확정지뢰</span>' : ""}`
      : `<span class="dim">인접 단서 없음</span>`;
    const outcome = hitMine
      ? `<span class="bad">지뢰</span>`
      : `<span class="good">안전 ${opened}칸</span>`;
    logger.push(
      `<span class="tag">G${games + 1}·M${moveNo}</span> ` +
        `<span class="pick">(${r},${c})</span> · ${why} · ${clue} · ${outcome} · DA ${fmtNum(lastDopamine)}`,
      hitMine ? "hit" : null
    );
  }

  function updateStats() {
    el.games.textContent = games;
    el.wins.textContent = wins;
    el.dopamine.textContent = lastDopamine.toFixed(2);
    el.eps.textContent = epsilon.toFixed(2);
    const recent = history.slice(-100);
    if (recent.length) {
      const wr = (recent.filter((h) => h.won).length / recent.length) * 100;
      el.winRate.textContent = `${wr.toFixed(0)}%`;
      const avg = (recent.reduce((a, h) => a + h.progress, 0) / recent.length) * 100;
      el.progress.textContent = `${avg.toFixed(0)}%`;
    }
  }

  const BUCKET = 20;

  function chartBuckets() {
    const buckets = [];
    for (let i = 0; i + BUCKET <= history.length; i += BUCKET) {
      const slice = history.slice(i, i + BUCKET);
      buckets.push({
        win: (slice.filter((h) => h.won).length / BUCKET) * 100,
        prog: (slice.reduce((a, h) => a + h.progress, 0) / BUCKET) * 100,
        endGame: i + BUCKET,
      });
    }
    return buckets.slice(-60);
  }

  function drawChart() {
    ChartUtil.fit(chart, 220);
    chartCtx.clearRect(0, 0, chart.width, chart.height);
    const buckets = chartBuckets();
    if (buckets.length < 2) return;
    ChartUtil.draw(chart, {
      xStart: buckets[0].endGame,
      xStep: BUCKET,
      hoverIndex,
      yMin: 0,
      yMax: 100,
      format: (v) => `${v.toFixed(0)}`,
      markMax: false,
      series: [
        { values: buckets.map((b) => b.win), color: "#4fd8e0", width: 2 },
        { values: buckets.map((b) => b.prog), color: "#ffb040", width: 2 },
      ],
    });
  }

  function speedToInterval(v) {
    return Math.max(5, 320 - Number(v));
  }

  function startLoop() {
    if (timer) clearInterval(timer);
    timer = setInterval(aiMove, speedToInterval(el.speed.value));
  }

  function stopLoop() {
    running = false;
    el.btnAi.textContent = "AI 학습 시작";
    clearInterval(timer);
  }

  el.btnAi.addEventListener("click", () => {
    running = !running;
    el.btnAi.textContent = running ? "AI 정지" : "AI 학습 시작";
    if (running) startLoop();
    else clearInterval(timer);
  });

  el.btnMove.addEventListener("click", () => {
    if (running) stopLoop();
    aiMove();
  });

  el.btnNew.addEventListener("click", () => {
    if (running) stopLoop();
    env.reset();
    safety = new Map();
    draw();
    updateStats();
  });

  el.speed.addEventListener("input", () => {
    if (running) startLoop();
  });

  el.showSafety.addEventListener("change", () => {
    if (el.showSafety.checked && safety.size === 0) computeSafety();
    draw();
  });

  el.logOn.addEventListener("change", () => logger.setEnabled(el.logOn.checked));

  const READOUT_HINT = "그래프에 마우스를 올리면 해당 구간 값이 표시됩니다";

  chart.addEventListener("mousemove", (e) => {
    const buckets = chartBuckets();
    if (buckets.length < 2) return;
    const i = ChartUtil.indexFromEvent(chart, e, buckets.length);
    hoverIndex = i;
    if (i === null) {
      el.readout.textContent = READOUT_HINT;
    } else {
      const b = buckets[i];
      el.readout.textContent =
        `${b.endGame - BUCKET + 1}~${b.endGame}판 · 승률 ${b.win.toFixed(0)}% · 평균 개방률 ${b.prog.toFixed(0)}%`;
    }
    drawChart();
  });

  chart.addEventListener("mouseleave", () => {
    hoverIndex = null;
    el.readout.textContent = READOUT_HINT;
    drawChart();
  });

  window.addEventListener("resize", drawChart);

  canvas.addEventListener("click", (e) => {
    if (running) return;
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) / rect.width) * env.size);
    const r = Math.floor(((e.clientY - rect.top) / rect.height) * env.size);
    if (!env.inBounds(r, c)) return;
    if (env.dead || env.won) {
      endGame();
    } else {
      env.reveal(r, c);
      if (el.showSafety.checked) computeSafety();
    }
    draw();
    updateStats();
  });

  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (running) return;
    const rect = canvas.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) / rect.width) * env.size);
    const r = Math.floor(((e.clientY - rect.top) / rect.height) * env.size);
    if (!env.inBounds(r, c)) return;
    env.toggleFlag(r, c);
    draw();
  });

  draw();
  updateStats();
})();
