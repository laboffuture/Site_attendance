// Kiosk capture: snap a webcam frame, POST it to /station/scan, show the result.
(function () {
  var video = document.getElementById("video");
  var canvas = document.getElementById("canvas");
  var scanBtn = document.getElementById("scanBtn");
  var result = document.getElementById("result");
  var camNote = document.getElementById("camNote");
  var autoToggle = document.getElementById("autoToggle");
  function autoOn() { return autoToggle ? autoToggle.getAttribute("data-on") === "1" : true; }

  function show(cls, text) {
    result.className = "oh-result oh-result--" + cls;
    result.textContent = text;
  }

  // A big, unmistakable standing-state card for a wall-mounted kiosk:
  // bold headline ("CLOCKED IN"/"CLOCKED OUT") + a name/time detail line.
  function showCard(cls, title, detail) {
    result.className = "oh-result oh-result--" + cls + " oh-result--card";
    result.textContent = "";
    var head = document.createElement("div");
    head.className = "oh-result__title";
    head.textContent = title;
    var sub = document.createElement("div");
    sub.className = "oh-result__detail";
    sub.textContent = detail;
    result.appendChild(head);
    result.appendChild(sub);
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

  // Best-effort GPS — captured if the device allows it; never blocks a scan.
  function getLocation() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        function (p) { resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
        function () { resolve(null); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    });
  }

  function locText(data) {
    if (!data.geo) return "";
    if (!data.geo.available) return " · 📍 location not captured";
    if (data.geo.distanceMeters != null) return " · 📍 " + data.geo.distanceMeters + " m from site";
    return " · 📍 location captured";
  }

  function render(data) {
    switch (data.status) {
      case "in":
        showCard("in", "CLOCKED IN", data.workerName + " — since " + data.time + locText(data));
        break;
      case "out": {
        var ot = data.overtimeHours > 0 ? " · OT " + data.overtimeHours + "h (pending approval)" : "";
        showCard("out", "CLOCKED OUT", data.workerName + " — at " + data.time + " · Total " + data.totalHours + "h" + ot + locText(data));
        break;
      }
      case "wrong_site":
        show("error", "✗ " + data.workerName + " is assigned to " + data.homeSite + ", not " + data.thisSite + ". Scan rejected and flagged.");
        break;
      case "unknown":
        show("warn", "Face not recognized. Please try again or see your supervisor.");
        break;
      case "no_face":
        show("warn", "No face detected — center your face and tap Scan again.");
        break;
      default:
        show("error", data.message || "Something went wrong. Try again.");
    }
  }

  // One scan: snap the frame + GPS and POST it. Used by the button + auto-scan.
  function doScan() {
    if (!video.videoWidth) { show("warn", "Camera not ready yet."); return Promise.resolve(); }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    var dataUrl = canvas.toDataURL("image/jpeg", 0.9);

    scanBtn.disabled = true;
    show("idle", "Scanning…");
    return getLocation().then(function (loc) {
      var body = "photoData=" + encodeURIComponent(dataUrl);
      if (loc) {
        body += "&lat=" + encodeURIComponent(loc.lat) +
                "&lng=" + encodeURIComponent(loc.lng) +
                "&accuracy=" + encodeURIComponent(loc.accuracy);
      }
      return fetch("/station/scan", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body,
      });
    })
      .then(function (r) {
        if (r.status === 401) { window.location.href = "/station/login"; return null; }
        return r.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () { show("error", "Network error. Try again."); })
      .finally(function () { scanBtn.disabled = false; });
  }

  scanBtn.addEventListener("click", doScan);

  if (autoToggle) {
    autoToggle.addEventListener("click", function () {
      var on = autoToggle.getAttribute("data-on") === "1";
      autoToggle.setAttribute("data-on", on ? "0" : "1");
      autoToggle.textContent = on ? "Auto-scan: Off" : "Auto-scan: On";
      autoToggle.classList.toggle("is-on", !on);
    });
  }

  // Live auto-scan: fire a scan when a worker's face holds steady, then wait
  // until they step away before re-arming. Manual button stays as a fallback.
  if (window.FaceAutoScan) {
    FaceAutoScan.start(video, {
      canScan: function () { return autoOn(); },
      onCapture: doScan,
      onStatus: function (state) {
        if (state === "holding") show("idle", "Hold still…");
        else if (state === "capturing") show("idle", "Scanning…");
        else if (state === "ready" || state === "searching") show("idle", autoOn() ? "Step up and face the camera — auto-scan is on." : "Face the camera and tap Scan.");
      },
    });
  }
})();
