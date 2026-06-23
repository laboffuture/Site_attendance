// Site coverage picker — Leaflet + OpenStreetMap + Leaflet.draw.
// Supports: search (Nominatim), click-to-drop a point, "My location", and
// drawing a Circle (→ lat/lng + radius) or a Rectangle (→ polygon). Writes to
// the form's latitude / longitude / geofenceRadiusMeters / geofencePolygon
// inputs. Falls back silently if Leaflet didn't load.
(function () {
  var el = document.getElementById("site-map");
  if (!el || typeof L === "undefined") return;

  var latInput = document.querySelector('input[name="latitude"]');
  var lngInput = document.querySelector('input[name="longitude"]');
  var radInput = document.querySelector('input[name="geofenceRadiusMeters"]');
  var polyInput = document.querySelector('input[name="geofencePolygon"]');
  var ACCENT = "#1c4d8c";

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  var startLat = num(latInput && latInput.value);
  var startLng = num(lngInput && lngInput.value);
  var hasStart = startLat != null && startLng != null;

  var map = L.map(el).setView(hasStart ? [startLat, startLng] : [13.0827, 80.2707], hasStart ? 15 : 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);

  var drawn = L.featureGroup().addTo(map); // holds the single active shape

  function setLatLng(lat, lng) {
    if (latInput) latInput.value = lat.toFixed(6);
    if (lngInput) lngInput.value = lng.toFixed(6);
  }
  function clearShape() { drawn.clearLayers(); if (polyInput) polyInput.value = ""; }

  function showPoint(lat, lng, zoom) {
    clearShape();
    var m = L.marker([lat, lng], { draggable: true }).addTo(drawn);
    m.on("dragend", function () { var p = m.getLatLng(); setLatLng(p.lat, p.lng); });
    setLatLng(lat, lng);
    if (zoom) map.setView([lat, lng], zoom);
  }
  function showCircle(lat, lng, radius) {
    clearShape();
    L.circle([lat, lng], { radius: radius, color: ACCENT, fillOpacity: 0.08 }).addTo(drawn);
    setLatLng(lat, lng);
    if (radInput) radInput.value = Math.round(radius);
  }
  function showPolygon(latlngs) {
    clearShape();
    var poly = L.polygon(latlngs, { color: ACCENT, fillOpacity: 0.08 }).addTo(drawn);
    if (polyInput) polyInput.value = JSON.stringify(latlngs.map(function (p) { return [+p.lat.toFixed(6), +p.lng.toFixed(6)]; }));
    var c = poly.getBounds().getCenter();
    setLatLng(c.lat, c.lng);
    if (radInput) radInput.value = ""; // polygon enforces the shape, not a radius
  }

  // Restore an existing shape (edit mode).
  var existingPoly = [];
  try { existingPoly = JSON.parse((polyInput && polyInput.value) || "[]"); } catch (e) { existingPoly = []; }
  if (Array.isArray(existingPoly) && existingPoly.length >= 3) {
    showPolygon(existingPoly.map(function (p) { return L.latLng(p[0], p[1]); }));
    map.fitBounds(drawn.getBounds().pad(0.3));
  } else if (hasStart && radInput && num(radInput.value)) {
    showCircle(startLat, startLng, num(radInput.value));
  } else if (hasStart) {
    showPoint(startLat, startLng);
  }

  map.on("click", function (e) { showPoint(e.latlng.lat, e.latlng.lng); });

  function btn(id, fn) { var b = document.getElementById(id); if (b) b.addEventListener("click", function (ev) { ev.preventDefault(); fn(); }); }
  var hasDraw = !!(L.Draw && L.Draw.Circle && L.Draw.Rectangle);
  btn("map-draw-circle", function () { if (!hasDraw) return; new L.Draw.Circle(map, { shapeOptions: { color: ACCENT } }).enable(); });
  btn("map-draw-rect", function () { if (!hasDraw) return; new L.Draw.Rectangle(map, { shapeOptions: { color: ACCENT } }).enable(); });
  btn("map-clear", function () { clearShape(); if (latInput) latInput.value = ""; if (lngInput) lngInput.value = ""; if (radInput) radInput.value = ""; });
  btn("map-my-location", function () {
    if (!navigator.geolocation) { alert("Geolocation isn't available on this device."); return; }
    navigator.geolocation.getCurrentPosition(
      function (pos) { showPoint(pos.coords.latitude, pos.coords.longitude, 16); },
      function () { alert("Couldn't get your location — search or draw on the map instead."); },
    );
  });

  if (hasDraw) {
    map.on(L.Draw.Event.CREATED, function (e) {
      if (e.layerType === "circle") { var c = e.layer.getLatLng(); showCircle(c.lat, c.lng, e.layer.getRadius()); }
      else if (e.layerType === "rectangle") { var b = e.layer.getBounds(); showPolygon([b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()]); }
    });
  }

  // Address search via the free Nominatim endpoint.
  var searchInput = document.getElementById("site-map-search");
  var searchBtn = document.getElementById("site-map-search-btn");
  function search() {
    var q = ((searchInput && searchInput.value) || "").trim();
    if (!q) return;
    if (searchBtn) { searchBtn.disabled = true; searchBtn.textContent = "Searching…"; }
    fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (rows) { if (rows && rows.length) showPoint(parseFloat(rows[0].lat), parseFloat(rows[0].lon), 16); else alert("No match — try a more specific address, or draw on the map."); })
      .catch(function () { alert("Search failed — draw on the map instead."); })
      .finally(function () { if (searchBtn) { searchBtn.disabled = false; searchBtn.textContent = "Search"; } });
  }
  if (searchBtn) searchBtn.addEventListener("click", function (e) { e.preventDefault(); search(); });
  if (searchInput) searchInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); search(); } });

  setTimeout(function () { map.invalidateSize(); }, 200);
})();
