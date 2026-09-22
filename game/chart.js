// 축과 눈금 숫자가 있는 꺾은선 차트. 어느 회차에서 얼마나 튀었는지 읽을 수 있게 하는 게 목적이다.
const ChartUtil = (function () {
  const PAD = { left: 44, right: 10, top: 14, bottom: 22 };
  const FONT = "16px NeoDunggeunmo, monospace";

  // 표시 크기에 맞춰 내부 해상도를 1:1로 맞춘다 (비트맵 폰트가 흐려지지 않게)
  function fit(canvas, height) {
    const w = Math.max(240, Math.floor(canvas.clientWidth || canvas.width));
    if (canvas.width !== w || canvas.height !== height) {
      canvas.width = w;
      canvas.height = height;
    }
  }

  function niceStep(range, targetTicks) {
    const raw = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(raw) || 1)));
    const norm = raw / mag;
    let step;
    if (norm <= 1) step = 1;
    else if (norm <= 2) step = 2;
    else if (norm <= 5) step = 5;
    else step = 10;
    return step * mag;
  }

  function draw(canvas, opts) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const series = (opts.series || []).filter((s) => s.values && s.values.length);
    if (!series.length) return null;

    const n = Math.max(...series.map((s) => s.values.length));
    if (n < 2) return null;

    const xStart = opts.xStart || 0;
    const xStep = opts.xStep || 1;
    const xLabel = (i) => String(xStart + i * xStep);
    const fmt = opts.format || ((v) => (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)));

    let lo = opts.yMin;
    let hi = opts.yMax;
    if (lo === undefined || hi === undefined) {
      let mn = Infinity;
      let mx = -Infinity;
      for (const s of series) {
        for (const v of s.values) {
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      const pad = (mx - mn) * 0.12 || 1;
      lo = lo === undefined ? mn - pad : lo;
      hi = hi === undefined ? mx + pad : hi;
    }
    if (hi - lo < 1e-6) hi = lo + 1;

    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;
    const xAt = (i) => PAD.left + (i / (n - 1)) * plotW;
    const yAt = (v) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;

    ctx.font = FONT;
    ctx.textBaseline = "middle";

    // y축 눈금 + 격자
    const yStep = niceStep(hi - lo, 4);
    ctx.textAlign = "right";
    for (let v = Math.ceil(lo / yStep) * yStep; v <= hi; v += yStep) {
      const y = yAt(v);
      ctx.strokeStyle = Math.abs(v) < 1e-9 ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.09)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(PAD.left, Math.round(y) + 0.5);
      ctx.lineTo(W - PAD.right, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = "#b6b6c0";
      ctx.fillText(fmt(v), PAD.left - 6, y);
    }

    // x축 눈금 (회차 번호)
    ctx.textAlign = "center";
    ctx.fillStyle = "#b6b6c0";
    const xTicks = Math.min(4, n - 1);
    for (let k = 0; k <= xTicks; k++) {
      const i = Math.round((k / xTicks) * (n - 1));
      ctx.fillText(xLabel(i), xAt(i), H - PAD.bottom / 2);
    }

    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 2;
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = xAt(i);
        const y = yAt(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // 가장 크게 튄 지점 표시
    if (opts.markMax !== false) {
      const primary = series[0];
      let bi = 0;
      for (let i = 1; i < primary.values.length; i++) {
        if (primary.values[i] > primary.values[bi]) bi = i;
      }
      const x = xAt(bi);
      const y = yAt(primary.values[bi]);
      ctx.fillStyle = "#ffb040";
      ctx.fillRect(x - 3, y - 3, 6, 6);
      ctx.textAlign = bi > n * 0.7 ? "right" : "left";
      ctx.fillText(`#${xLabel(bi)} ${fmt(primary.values[bi])}`, bi > n * 0.7 ? x - 6 : x + 6, y - 12);
    }

    // 마우스 올린 지점
    if (opts.hoverIndex !== null && opts.hoverIndex !== undefined) {
      const i = Math.max(0, Math.min(n - 1, opts.hoverIndex));
      const x = xAt(i);
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, PAD.top);
      ctx.lineTo(Math.round(x) + 0.5, PAD.top + plotH);
      ctx.stroke();
      for (const s of series) {
        if (i >= s.values.length) continue;
        ctx.fillStyle = s.color;
        const y = yAt(s.values[i]);
        ctx.fillRect(x - 3, y - 3, 6, 6);
      }
    }

    return { xAt, yAt, n, plotLeft: PAD.left, plotW };
  }

  // 캔버스 위 마우스 x좌표를 데이터 인덱스로
  function indexFromEvent(canvas, event, n) {
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    const px = (event.clientX - rect.left) * scale;
    const plotW = canvas.width - PAD.left - PAD.right;
    const t = (px - PAD.left) / plotW;
    if (t < -0.05 || t > 1.05) return null;
    return Math.round(Math.max(0, Math.min(1, t)) * (n - 1));
  }

  return { fit, draw, indexFromEvent };
})();
