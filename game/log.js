// 에이전트가 왜 그렇게 판단했는지 남기는 로그.
// 빠른 속도로 돌리면 매 스텝 DOM을 건드릴 수 없어서, 버퍼에 쌓고 주기적으로 한 번에 그린다.
// options.sink(lines) 를 주면 글자만 뽑아 모아 두었다가 같은 주기로 넘긴다 (브릿지가 파일에 남긴다).
// sink 가 true 를 돌려줘야 보낸 것으로 친다 — 브릿지가 아직 안 붙었으면 모아 두었다가 붙으면 보낸다.
function createLogger(containerId, options = {}) {
  const el = document.getElementById(containerId);
  const max = options.max || 60;
  const sink = options.sink;
  let entries = [];
  let outbox = [];
  let dirty = false;
  let enabled = true;

  setInterval(() => {
    if (sink && outbox.length && sink(outbox)) outbox = [];
    if (!dirty || !enabled) return;
    dirty = false;
    el.innerHTML = entries
      .map((e) => `<div class="log-row${e.kind ? " log-" + e.kind : ""}">${e.html}</div>`)
      .join("");
  }, 120);

  return {
    push(html, kind) {
      if (!enabled) return;
      entries.unshift({ html, kind });
      if (entries.length > max) entries.length = max;
      dirty = true;
      if (sink) {
        outbox.push({ t: Date.now(), kind: kind || "", text: logText(html) });
        if (outbox.length > 500) outbox.shift();
      }
    },
    setEnabled(v) {
      enabled = v;
      if (!v) el.innerHTML = '<div class="log-row log-muted">로그 기록 꺼짐</div>';
      else dirty = true;
    },
    clear() {
      entries = [];
      el.innerHTML = "";
    },
  };
}

// 로그 한 줄의 HTML 에서 글자만 남긴다. 그림(click-shot)은 빠진다.
const LOG_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
function logText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, " / ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => LOG_ENTITIES[m])
    .replace(/\s+/g, " ")
    .replace(/( \/)+\s*$/, "")
    .trim();
}

function fmtNum(v, digits = 2) {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}
