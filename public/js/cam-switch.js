// Shared webcam opener with a front/back flip button (for phones).
//
//   CamSwitch.start(video, { width: 640, height: 480 }) -> Promise<stream>
//
// Opens the camera preferring the side used last time on this device
// (localStorage). When the device has more than one camera, a round flip
// button is overlaid on the bottom-right of the preview; tapping it swaps
// front <-> back. The selfie mirror is dropped while the back camera is on
// (class "oh-cam-rear") so the picture aims naturally. Desktops with a single
// camera never see the button and behave exactly as before.
var CamSwitch = (function () {
  var KEY = "trgbi.camFacing";

  function start(video, opts) {
    var facing = "user";
    try { facing = localStorage.getItem(KEY) === "environment" ? "environment" : "user"; } catch (e) { /* private mode */ }
    var current = null;

    function open() {
      return navigator.mediaDevices
        .getUserMedia({ video: { width: opts.width, height: opts.height, facingMode: facing } })
        .then(function (stream) {
          current = stream;
          video.srcObject = stream;
          video.classList.toggle("oh-cam-rear", facing === "environment");
          try { localStorage.setItem(KEY, facing); } catch (e) { /* private mode */ }
          return stream;
        });
    }

    function stop() {
      if (!current) return;
      current.getTracks().forEach(function (t) { t.stop(); });
      current = null;
    }

    function flip() {
      var previous = facing;
      facing = facing === "user" ? "environment" : "user";
      stop();
      open().catch(function () {
        facing = previous; // the other camera refused — go back to the one that worked
        open().catch(function () { /* nothing usable; leave the note callers already show */ });
      });
    }

    // The button is only added when a second camera actually exists (device
    // labels/kinds are reliable here because permission was just granted).
    function addFlipButton() {
      if (!navigator.mediaDevices.enumerateDevices) return;
      navigator.mediaDevices
        .enumerateDevices()
        .then(function (devices) {
          var cams = devices.filter(function (d) { return d.kind === "videoinput"; });
          if (cams.length < 2) return;

          // Anchor: reuse the parent when it is already a positioned frame
          // (the scan page's video fills one); otherwise shrink-wrap the video
          // so the button sits on the picture itself, not beside it.
          var anchor = video.parentNode;
          if (getComputedStyle(anchor).position !== "relative") {
            var wrap = document.createElement("div");
            wrap.className = "oh-camflip-wrap";
            anchor.insertBefore(wrap, video);
            wrap.appendChild(video);
            anchor = wrap;
          }

          var btn = document.createElement("button");
          btn.type = "button";
          btn.className = "oh-camflip";
          btn.title = "Switch camera";
          btn.setAttribute("aria-label", "Switch camera");
          btn.innerHTML = '<span class="material-icons">flip_camera_android</span>';
          btn.addEventListener("click", flip);
          anchor.appendChild(btn);
        })
        .catch(function () { /* no device list — keep the plain preview */ });
    }

    return open().then(function (stream) {
      addFlipButton();
      return stream;
    });
  }

  return { start: start };
})();
