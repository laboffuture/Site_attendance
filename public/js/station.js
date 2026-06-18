// Kiosk capture: snap a webcam frame, POST it to /station/scan, show the result.
(function () {
  var video = document.getElementById("video");
  var canvas = document.getElementById("canvas");
  var scanBtn = document.getElementById("scanBtn");
  var result = document.getElementById("result");
  var camNote = document.getElementById("camNote");

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

  scanBtn.addEventListener("click", function () {
    if (!video.videoWidth) { show("warn", "Camera not ready yet."); return; }
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    var dataUrl = canvas.toDataURL("image/jpeg", 0.9);

    scanBtn.disabled = true;
    show("idle", "Scanning…");
    fetch("/station/scan", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: "photoData=" + encodeURIComponent(dataUrl),
    })
      .then(function (r) {
        if (r.status === 401) { window.location.href = "/station/login"; return null; }
        return r.json();
      })
      .then(function (data) { if (data) render(data); })
      .catch(function () { show("error", "Network error. Try again."); })
      .finally(function () { scanBtn.disabled = false; });
  });
})();
