// Portal-open geofence indicator for PM/Supervisor. If the banner is on the
// page, ask the browser for a location fix and reflect whether they're at an
// assigned site. Informational only — never blocks. (Geolocation needs HTTPS
// or localhost; on plain http it silently shows the "couldn't read" state.)
(function () {
  var banner = document.getElementById("geo-login-banner");
  if (!banner) return;
  var textEl = banner.querySelector(".oh-geo-banner__text");

  function set(state, text) {
    banner.className = "oh-geo-banner oh-geo-banner--" + state;
    textEl.textContent = text;
    banner.hidden = false;
  }

  if (!navigator.geolocation || !window.isSecureContext) {
    set("warn", "Location needs a secure (https) connection to confirm you're on site.");
    return;
  }

  set("checking", "Checking your location…");
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      var body = new URLSearchParams({
        lat: String(pos.coords.latitude),
        lng: String(pos.coords.longitude),
        accuracy: pos.coords.accuracy ? String(pos.coords.accuracy) : "",
      });
      fetch("/me/location-check", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.status === "inside") {
            set("inside", "You're at " + d.siteName + " — location confirmed.");
          } else if (d.status === "outside") {
            set("outside", "You're not at your site" + (d.siteName ? " — " + d.distanceMeters + "m from " + d.siteName : "") + ". Go to the site.");
          } else if (d.status === "no_fix") {
            set("warn", "Couldn't read your location. Enable location to confirm you're on site.");
          } else {
            banner.hidden = true; // "off" — no geofenced site assigned
          }
        })
        .catch(function () { set("warn", "Location check failed."); });
    },
    function () {
      set("warn", "Location permission denied. Allow location to confirm you're on site.");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
  );
})();
