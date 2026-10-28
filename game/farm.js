// 농부는 대체되었다 (The Farmer Was Replaced) — 화면 공유 + 마우스 클릭 조작.
// 클릭 좌표는 공유 화면 안의 비율(0~1)로 보내고, 브릿지가 대상 창 내용 영역에 맞춰 화면 좌표로 바꾼다.
// ESC 는 브릿지가 전역으로 감시한다. 눌리면 입력을 막고 { halted: true } 를 보낸다.
(function () {
  const $ = (id) => document.getElementById(id);
  const el = {
    view: $("fmView"), status: $("fmStatus"), share: $("fmShare"), run: $("fmRun"), stop: $("fmStop"),
    window: $("fmWindow"), bridge: $("fmBridge"), live: $("fmLive"), last: $("fmLast"),
  };
  if (!el.view) return;
  const ctx = el.view.getContext("2d");
  const video = document.createElement("video");
  video.muted = true;
  let stream = null;
  let ws = null;
  let running = false;
  let reqId = 0;
  const pending = new Map();

  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.className = "vs-status" + (kind ? " " + kind : "");
  }

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
        if (m.halted && running) {
          running = false;
          setStatus("ESC 로 정지됨 — 다시 하려면 '조작 시작'", "bad");
        }
      };
      ws.onclose = () => {
        el.bridge.textContent = "끊김";
        el.live.textContent = "-";
        ws = null;
        running = false;
      };
      ws.onerror = () => {
        el.bridge.textContent = "연결 실패 (브릿지 확인)";
        resolve(false);
      };
      setTimeout(() => resolve(false), 2500);
    });
  }

  function ask(payload, timeoutMs = 3000) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve({ error: "브릿지 미연결" });
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
    setStatus("공유 중 — '조작 시작'을 누르세요", "");
  }

  function draw() {
    if (stream && video.videoWidth) {
      if (el.view.width !== video.videoWidth) {
        el.view.width = video.videoWidth;
        el.view.height = video.videoHeight;
      }
      ctx.drawImage(video, 0, 0);
    }
    requestAnimationFrame(draw);
  }

  async function start() {
    if (!stream) return setStatus("먼저 화면 공유를 해주세요", "bad");
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (!(await connectBridge())) return setStatus("브릿지에 연결하지 못했습니다", "bad");
    }
    await ask({ type: "set_window", window: el.window.value.trim() });
    await ask({ type: "resume" });
    running = true;
    setStatus("조작 중 — 화면을 클릭하면 게임을 클릭합니다 (ESC 로 정지)", "ok");
  }

  function stop() {
    running = false;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    setStatus("정지됨", "");
  }

  async function click(ev, button) {
    if (!running) return;
    ev.preventDefault();
    const r = el.view.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    const res = await ask({ type: "click", x, y, button });
    if (res.halted) return;
    if (res.no_window) return setStatus(`'${el.window.value}' 창을 찾지 못했습니다 — 대상 창 이름을 확인하세요`, "bad");
    el.last.textContent = res.at ? `${button === "right" ? "오른쪽 " : ""}${res.at[0]}, ${res.at[1]}` : "실패";
  }

  el.share.addEventListener("click", share);
  el.run.addEventListener("click", start);
  el.stop.addEventListener("click", stop);
  el.view.addEventListener("click", (e) => click(e, "left"));
  el.view.addEventListener("contextmenu", (e) => click(e, "right"));
  requestAnimationFrame(draw);
})();
