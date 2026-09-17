document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
    const target = `panel-${tab.dataset.tab}`;
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.id === target));
  });
});
