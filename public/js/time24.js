// 24-hour time field. Any <input class="oh-time24"> is a strict HH:MM (24-hour)
// field on every browser/OS — no AM/PM, unlike native <input type="time"> which
// follows the device locale. It is a plain text input (so it is already 24-hour
// and works without JS); this script just adds the conveniences: digits-only with
// an auto-inserted colon, and pad/validate on blur. The submitted value stays
// "HH:MM", exactly what the server validators expect.
(function () {
  var RE = /^([01]\d|2[0-3]):[0-5]\d$/;

  function format(digits) {
    var d = digits.replace(/\D/g, "").slice(0, 4);
    return d.length > 2 ? d.slice(0, 2) + ":" + d.slice(2) : d;
  }

  function onInput(e) {
    var el = e.target;
    var atEnd = el.selectionStart === el.value.length;
    el.value = format(el.value);
    if (atEnd) el.setSelectionRange(el.value.length, el.value.length);
    if (el.value === "" || RE.test(el.value)) el.classList.remove("is-invalid");
  }

  function onBlur(e) {
    var el = e.target;
    if (!el.value) { el.classList.remove("is-invalid"); return; }
    var m = el.value.match(/^(\d{1,2}):?(\d{0,2})$/);
    if (m) {
      var h = Math.min(23, parseInt(m[1] || "0", 10));
      var mi = Math.min(59, parseInt(m[2] || "0", 10));
      var v = String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
      if (RE.test(v)) el.value = v;
    }
    el.classList.toggle("is-invalid", !RE.test(el.value));
  }

  function init(root) {
    (root || document).querySelectorAll("input.oh-time24").forEach(function (el) {
      if (el.dataset.t24) return;
      el.dataset.t24 = "1";
      if (el.type === "time") el.type = "text"; // belt-and-suspenders if a view missed it
      el.setAttribute("inputmode", "numeric");
      el.setAttribute("autocomplete", "off");
      if (!el.getAttribute("placeholder")) el.setAttribute("placeholder", "HH:MM");
      el.addEventListener("input", onInput);
      el.addEventListener("blur", onBlur);
    });
  }

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", function () { init(); });
})();
