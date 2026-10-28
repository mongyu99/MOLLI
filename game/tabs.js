// 페이지에 들어오면 게임부터 고른다. 고른 게임은 주소 #vamp / #farm 에 남겨서 새로고침해도 유지한다.
const GAMES = { vamp: "뱀서", farm: "농부는 대체되었다" };

function showGame(id) {
  const ok = id in GAMES;
  document.getElementById("gamePick").hidden = ok;
  document.getElementById("gameLayout").hidden = !ok;
  document.getElementById("gameNav").hidden = !ok;
  document.getElementById("gameName").textContent = ok ? GAMES[id] : "";
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.id === `panel-${id}`));
  document.dispatchEvent(new Event("gamechange"));
  history.replaceState(null, "", ok ? `#${id}` : location.pathname + location.search);
}

document.querySelectorAll(".game-card").forEach((card) => {
  card.addEventListener("click", () => showGame(card.dataset.tab));
});
// 선택 화면에서는 숫자키로도 고른다
document.addEventListener("keydown", (e) => {
  if (document.getElementById("gamePick").hidden || e.target.closest("input, textarea")) return;
  const card = document.querySelectorAll(".game-card")[Number(e.key) - 1];
  if (card) card.click();
});
document.getElementById("gameChange").addEventListener("click", () => showGame(null));
showGame(location.hash.slice(1));
