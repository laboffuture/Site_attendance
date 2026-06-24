/* Live auto-scan: runs the face-api tinyFaceDetector on a <video> and fires a
 * capture when a face is present + steady, then waits (cooldown) until that
 * person steps away before re-arming. Self-hosted model under /static/models.
 *
 *   FaceAutoScan.start(video, {
 *     canScan: () => bool,        // gate (e.g. geofence + toggle); default always
 *     onCapture: () => Promise,   // do the real capture+POST+render
 *     onStatus: (state, info) => {}, // ready|searching|holding|capturing|blocked|error
 *   }) -> { stop(), rearm() }
 */
window.FaceAutoScan = (function () {
  var loaded = null;
  function loadModel() {
    if (!loaded) {
      if (typeof faceapi === "undefined") return Promise.reject(new Error("face-api missing"));
      loaded = faceapi.nets.tinyFaceDetector.loadFromUri("/static/models/face");
    }
    return loaded;
  }

  function start(video, opts) {
    opts = opts || {};
    var TICK = 280;        // ms between detections (~3.5/sec)
    var NEED = 3;          // consecutive steady hits before capturing (~0.8s)
    var ABSENT = 3;        // consecutive face-gone hits to clear cooldown
    var MIN_BOX = 0.16;    // face box width as a fraction of frame (close enough)
    var MIN_COOL = 2500;   // keep the result on screen at least this long
    var MAX_COOL = 9000;   // hard re-arm even if detection is flaky
    var detOpts = null, phase = "scan", steady = 0, absent = 0, coolAt = 0, stopped = false;
    var status = function (s, info) { if (opts.onStatus) opts.onStatus(s, info); };

    loadModel()
      .then(function () {
        detOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
        status("ready");
        loop();
      })
      .catch(function () { status("error"); });

    function loop() {
      if (stopped) return;
      tick().catch(function () {}).then(function () { if (!stopped) setTimeout(loop, TICK); });
    }

    async function tick() {
      if (!video.videoWidth || video.paused) return;
      var det = await faceapi.detectSingleFace(video, detOpts);
      var hasFace = !!det && det.box.width / video.videoWidth >= MIN_BOX;

      if (phase === "cooldown") {
        var elapsed = Date.now() - coolAt;
        absent = hasFace ? 0 : absent + 1;
        if ((absent >= ABSENT && elapsed > MIN_COOL) || elapsed > MAX_COOL) {
          phase = "scan"; steady = 0; absent = 0; status("ready");
        }
        return;
      }
      if (opts.canScan && !opts.canScan()) { steady = 0; status("blocked"); return; }
      if (hasFace) {
        steady++;
        if (steady >= NEED) {
          steady = 0; phase = "cooldown"; coolAt = Date.now(); absent = 0;
          status("capturing");
          try { await opts.onCapture(); } catch (e) { /* render handles errors */ }
        } else {
          status("holding", steady / NEED);
        }
      } else {
        steady = 0; status("searching");
      }
    }

    return {
      stop: function () { stopped = true; },
      rearm: function () { phase = "scan"; steady = 0; absent = 0; coolAt = 0; },
    };
  }

  return { start: start };
})();
