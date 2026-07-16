// Kiosk capture: worker picks CLOCK IN / CLOCK OUT, then a face scan POSTs to /station/scan.
(function () {
  var video = document.getElementById("video");
  var canvas = document.getElementById("canvas");
  var result = document.getElementById("result");
  var camNote = document.getElementById("camNote");
  var inBtn = document.getElementById("mp-in");
  var outBtn = document.getElementById("mp-out");

  var selectedAction = null; // "in" | "out" — must be set before any scan/POST
  var scanning = false;      // guards against overlapping captures
  var autoLive = false;      // face auto-scan loaded & running
  var camReady = true;
  var auto = null;

  var IDLE_TEXT = "Pick Clock In or Clock Out, then face the camera.";

  function actionLabel(a) { return a === "in" ? "CLOCK IN" : "CLOCK OUT"; }

  function show(cls, text) {
    result.className = "oh-result oh-result--" + cls;
    result.textContent = text;
  }
  function showIdle() { show("idle", IDLE_TEXT); }

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

  function setButtonsDisabled(d) {
    if (inBtn) inBtn.disabled = d;
    if (outBtn) outBtn.disabled = d;
  }
  function markActive(a) {
    if (inBtn) inBtn.classList.toggle("is-active", a === "in");
    if (outBtn) outBtn.classList.toggle("is-active", a === "out");
  }
  function clearAction() {
    selectedAction = null;
    markActive(null);
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    CamSwitch.start(video, { width: 640, height: 480 })
      .catch(function () {
        camReady = false;
        camNote.textContent = "Camera unavailable. Check permissions and reload.";
        setButtonsDisabled(true);
      });
  } else {
    camReady = false;
    camNote.textContent = "Camera not supported in this browser.";
    setButtonsDisabled(true);
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
      case "already_in":
        showCard("warn", "ALREADY CLOCKED IN", data.workerName + " — already clocked in" + (data.time ? " since " + data.time : "") + ".");
        break;
      case "not_clocked_in":
        showCard("warn", "NOT CLOCKED IN", data.workerName + " — not clocked in (tap Clock In).");
        break;
      case "wrong_site":
        show("error", "✗ " + data.workerName + " is assigned to " + data.homeSite + ", not " + data.thisSite + ". Scan rejected and flagged.");
        break;
      case "unknown":
        show("warn", "Face not recognized. Please try again or see your supervisor.");
        break;
      case "no_face":
        show("warn", "No face detected — center your face and tap Clock In or Clock Out again.");
        break;
      default:
        show("error", data.message || "Something went wrong. Try again.");
    }
  }

  // One scan: snap the frame + GPS and POST it WITH the chosen action.
  // Never POSTs without an action — both this guard and FaceAutoScan's canScan
  // gate on selectedAction, and the body always carries &action=.
  function doScan() {
    if (!selectedAction) { showIdle(); return Promise.resolve(); }
    if (scanning) return Promise.resolve();
    if (!video.videoWidth) { show("warn", "Camera not ready yet."); return Promise.resolve(); }

    var action = selectedAction; // pin it for the body before clearAction() runs
    scanning = true;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    var dataUrl = canvas.toDataURL("image/jpeg", 0.9);

    setButtonsDisabled(true);
    show("idle", "Scanning to " + actionLabel(action) + "…");
    return getLocation().then(function (loc) {
      var body = "photoData=" + encodeURIComponent(dataUrl) +
                 "&action=" + encodeURIComponent(action);
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
      .finally(function () {
        scanning = false;
        setButtonsDisabled(!camReady);
        clearAction(); // back to the idle two-button state — the next worker picks again
      });
  }

  // Tapping CLOCK IN / CLOCK OUT selects the action and (re)starts the capture.
  function pick(action) {
    if (!camReady || scanning) return;
    selectedAction = action;
    markActive(action);
    show("idle", "Hold still — clocking " + (action === "in" ? "in" : "out") + "…");
    if (auto && auto.rearm) auto.rearm();
    if (!autoLive) doScan(); // no live face detection → capture immediately
  }

  if (inBtn) inBtn.addEventListener("click", function () { pick("in"); });
  if (outBtn) outBtn.addEventListener("click", function () { pick("out"); });

  // Live auto-scan: fires a scan when a worker's face holds steady, then waits
  // until they step away before re-arming. It is gated on a chosen action, so it
  // can never POST until a button has been tapped.
  if (window.FaceAutoScan) {
    auto = FaceAutoScan.start(video, {
      canScan: function () { return !!selectedAction && !scanning; },
      onCapture: doScan,
      onStatus: function (state) {
        if (state === "error") { autoLive = false; return; }
        autoLive = true;
        if (state === "capturing") return; // doScan owns the on-screen message
        if (state === "holding") {
          if (selectedAction) show("idle", "Hold still…");
          return;
        }
        if (state === "ready" || state === "searching") {
          if (selectedAction) show("idle", "Face the camera to clock " + (selectedAction === "in" ? "in" : "out") + "…");
          else showIdle();
          return;
        }
        if (state === "blocked") {
          // No action picked yet — keep a fresh result card visible, else prompt.
          if (!selectedAction && !result.classList.contains("oh-result--card")) showIdle();
        }
      },
    });
  }
})();
