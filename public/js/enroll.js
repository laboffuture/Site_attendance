// Worker enrollment capture: feeds either a webcam frame or an uploaded image
// into a hidden field as a JPEG data URL, which the server decodes + encodes.
(function () {
  var video = document.getElementById("video");
  var canvas = document.getElementById("canvas");
  var preview = document.getElementById("preview");
  var captureBtn = document.getElementById("captureBtn");
  var fileInput = document.getElementById("fileInput");
  var photoData = document.getElementById("photoData");
  var submitBtn = document.getElementById("submitBtn");
  var camNote = document.getElementById("camNote");

  function setPhotoFromCanvas(w, h) {
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(this, 0, 0, w, h);
    var url = canvas.toDataURL("image/jpeg", 0.9);
    photoData.value = url;
    preview.src = url;
    preview.hidden = false;
    submitBtn.disabled = false;
  }

  // Start the webcam (optional — upload is always available).
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    CamSwitch.start(video, { width: 480, height: 360 })
      .catch(function () {
        camNote.textContent = "Camera unavailable — use Upload instead.";
        captureBtn.disabled = true;
      });
  } else {
    camNote.textContent = "Camera not supported — use Upload instead.";
    captureBtn.disabled = true;
  }

  captureBtn.addEventListener("click", function () {
    if (!video.videoWidth) {
      camNote.textContent = "Camera not ready yet.";
      return;
    }
    setPhotoFromCanvas.call(video, video.videoWidth, video.videoHeight);
  });

  fileInput.addEventListener("change", function () {
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var img = new Image();
    img.onload = function () {
      setPhotoFromCanvas.call(img, img.naturalWidth, img.naturalHeight);
    };
    img.src = URL.createObjectURL(file);
  });
})();
