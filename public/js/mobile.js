// Mobile "More" drawer toggle. No-op on pages without the bottom nav
// (login, kiosk) and on desktop (the nav is hidden via CSS).
(function () {
  var btn = document.getElementById("oh-more-btn");
  var drawer = document.getElementById("oh-drawer");
  var backdrop = document.getElementById("oh-drawer-close");
  var xbtn = document.getElementById("oh-drawer-x");
  if (!btn || !drawer) return;

  function open() { drawer.classList.add("oh-drawer--open"); }
  function close() { drawer.classList.remove("oh-drawer--open"); }

  btn.addEventListener("click", open);
  if (backdrop) backdrop.addEventListener("click", close);
  if (xbtn) xbtn.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
})();
