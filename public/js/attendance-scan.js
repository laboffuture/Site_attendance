// Supervisor "Log Attendance": pick the site you're at, then scan worker faces.
// Geofence-first: when the picked site is geofenced, the device location is
// verified UP FRONT and the Scan button stays locked until you're confirmed
// inside the radius. Non-geofenced sites scan freely. On scan, the webcam frame
// + GPS are POSTed to /attendance/scan (server matches + location-locks).
(function () {
  var video = document.getElementById("video");
  var canvas = document.getElementById("canvas");
  var scanBtn = document.getElementById("scanBtn");
  var result = document.getElementById("result");
  var camNote = document.getElementById("camNote");
  var geoNote = document.getElementById("geoNote");
  var siteSelect = document.getElementById("siteSelect");
  if (!scanBtn) return; // no sites assigned

  var lastGeo = null; // most recent fix, reused by the scan post

  function show(cls, text) {
    result.className = "oh-result oh-result--" + cls;
    result.textContent = text;
  }
  function setGeo(text, ok) {
    geoNote.textContent = text;
    geoNote.style.color = ok === true ? "var(--c-success)" : ok === false ? "var(--c-danger)" : "";
  }
  function fenced() {
    var opt = siteSelect.options[siteSelect.selectedIndex];
    return opt && opt.getAttribute("data-fenced") === "1";
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480 } })
      .then(function (stream) { video.srcObject = stream; })
      .catch(function () {
        camNote.textContent = "Camera unavailable. Check permissions and reload.";
        scanBtn.disabled = true;
      });
  } else {
    camNote.textContent = "Camera not supported in this browser.";
    scanBtn.disabled = true;
  }

  function getGeo() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve({ available: false });
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ available: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
        function () { resolve({ available: false }); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
      );
    });
  }

  // Geofence-first: verify the device is inside the picked site before allowing a scan.
  function verifyLocation() {
    lastGeo = null;
    if (!fenced()) {
      setGeo("", null);
      scanBtn.disabled = false;
      show("idle", "Face the camera and tap Scan.");
      return;
    }
    scanBtn.disabled = true;
    setGeo("Checking you're at the site…", null);
    show("idle", "Confirming location…");
    getGeo().then(function (geo) {
      lastGeo = geo;
      var body = "siteId=" + encodeURIComponent(siteSelect.value);
      if (geo.available) body += "&lat=" + geo.lat + "&lng=" + geo.lng + "&accuracy=" + geo.accuracy;
      return fetch("/attendance/geocheck", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body,
      }).then(function (r) { return r.json(); });
    }).then(function (d) {
      if (d.status === "inside") {
        setGeo("✓ At " + d.siteName + " (" + d.distanceMeters + "m, within " + d.radius + "m)", true);
        scanBtn.disabled = false;
        show("idle", "Location confirmed — face the camera and tap Scan.");
      } else if (d.status === "outside") {
        setGeo("✗ " + d.distanceMeters + "m from " + d.siteName + " (limit " + d.radius + "m)", false);
        show("error", "Too far from " + d.siteName + ". Move within " + d.radius + "m to scan.");
      } else if (d.status === "no_fix") {
        setGeo("✗ Location needed", false);
        show("warn", "Allow location access to log attendance at " + d.siteName + ".");
      } else if (d.status === "off") {
        scanBtn.disabled = false;
        show("idle", "Face the camera and tap Scan.");
      } else {
        show("error", d.message || "Could not check location.");
      }
    }).catch(function () { show("error", "Location check failed. Try again."); });
  }

  function render(data) {
    switch (data.status) {
      case "in":
        show("in", "✓ " + data.workerName + " — IN at " + data.time);
        break;
      case "out": {
        var ot = data.overtimeHours > 0 ? " · OT " + data.overtimeHours + "h (" + data.overtimeStatus + ")" : "";
        show("out", "✓ " + data.workerName + " — OUT at " + data.time + " · Total " + data.totalHours + "h" + ot);
        break;
      }
      case "wrong_site":
        show("error", "✗ " + data.workerName + " is assigned to " + data.homeSite + ", not " + data.thisSite + ". Rejected & flagged.");
        break;
      case "out_of_range":
        show("error", "✗ Out of range — " + data.distanceMeters + "m from " + data.siteName + " (limit " + data.radius + "m). Move closer.");
        if (fenced()) scanBtn.disabled = true;
        break;
      case "location_required":
        show("warn", "Location needed — allow GPS to log attendance at " + data.siteName + ".");
        if (fenced()) scanBtn.disabled = true;
        break;
      case "unknown":
        show("warn", "Face not recognized. Try again, or enrol the worker first.");
        break;
      case "no_face":
        show("warn", "No face detected — center the face and tap Scan again.");
        break;
      default:
        show("error", data.message || "Something went wrong. Try again.");
    }
  }

  scanBtn.addEventListener("click", function () {
    if (!video.videoWidth) { show("warn", "Camera not ready yet."); return; }
    scanBtn.disabled = true;
    show("idle", "Scanning…");

    // Reuse the confirmed fix where we have one; otherwise grab a fresh fix.
    (lastGeo ? Promise.resolve(lastGeo) : getGeo())
      .then(function (geo) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        var body = "photoData=" + encodeURIComponent(dataUrl) + "&siteId=" + encodeURIComponent(siteSelect.value);
        if (geo && geo.available) body += "&lat=" + geo.lat + "&lng=" + geo.lng + "&accuracy=" + geo.accuracy;
        return fetch("/attendance/scan", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: body,
        });
      })
      .then(function (r) {
        if (r.status === 401) { window.location.href = "/login"; return null; }
        return r.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () { show("error", "Network error. Try again."); })
      .finally(function () { if (!fenced()) scanBtn.disabled = false; });
  });

  siteSelect.addEventListener("change", verifyLocation);
  verifyLocation(); // run for the default-selected site on load
})();
