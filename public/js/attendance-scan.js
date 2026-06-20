// Supervisor "Log Attendance": pick the site you're at, capture a webcam frame
// + device GPS, POST to /attendance/scan. The server matches the face,
// location-locks to the picked site, and enforces the geofence where one is set.
(function () {
  var video = document.getElementById("video");
  var canvas = document.getElementById("canvas");
  var scanBtn = document.getElementById("scanBtn");
  var result = document.getElementById("result");
  var camNote = document.getElementById("camNote");
  var geoNote = document.getElementById("geoNote");
  var siteSelect = document.getElementById("siteSelect");
  if (!scanBtn) return; // no sites assigned

  function show(cls, text) {
    result.className = "oh-result oh-result--" + cls;
    result.textContent = text;
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

  // Best-effort GPS; resolves { available:false } if denied/unavailable.
  function getGeo() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve({ available: false });
      navigator.geolocation.getCurrentPosition(
        function (p) {
          resolve({ available: true, lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy });
        },
        function () { resolve({ available: false }); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 10000 }
      );
    });
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
        break;
      case "location_required":
        show("warn", "Location needed — allow GPS to log attendance at " + data.siteName + ".");
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
    var opt = siteSelect.options[siteSelect.selectedIndex];
    var fenced = opt && opt.getAttribute("data-fenced") === "1";

    scanBtn.disabled = true;
    geoNote.textContent = "";
    show("idle", fenced ? "Getting location…" : "Scanning…");

    getGeo()
      .then(function (geo) {
        if (fenced && geo.available) geoNote.textContent = "Location ±" + Math.round(geo.accuracy) + "m";
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        var dataUrl = canvas.toDataURL("image/jpeg", 0.9);
        var body =
          "photoData=" + encodeURIComponent(dataUrl) +
          "&siteId=" + encodeURIComponent(siteSelect.value);
        if (geo.available) body += "&lat=" + geo.lat + "&lng=" + geo.lng + "&accuracy=" + geo.accuracy;
        show("idle", "Scanning…");
        return fetch("/attendance/scan", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: body,
        });
      })
      .then(function (r) {
        if (!r) return null;
        if (r.status === 401) { window.location.href = "/login"; return null; }
        return r.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () { show("error", "Network error. Try again."); })
      .finally(function () { scanBtn.disabled = false; });
  });
})();
