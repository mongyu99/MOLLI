// 에이전트가 왜 그렇게 판단했는지 남기는 로그.
// 빠른 속도로 돌리면 매 스텝 DOM을 건드릴 수 없어서, 버퍼에 쌓고 주기적으로 한 번에 그린다.
function createLogger(containerId, options = {}) {
  const el = document.getElementById(containerId);
  const max = options.max || 60;
  let entries = [];
  let dirty = false;
  let enabled = true;

  setInterval(() => {
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

function fmtNum(v, digits = 2) {
  const s = v.toFixed(digits);
  return v > 0 ? `+${s}` : s;
}
