// Site location picker — Leaflet + OpenStreetMap. If #site-map is on the page,
// wire search (Nominatim) + click/drag to fill the form's latitude/longitude
// inputs. No API key. Falls back silently if Leaflet didn't load.
(function () {
  var el = document.getElementById("site-map");
  if (!el || typeof L === "undefined") return;

  var latInput = document.querySelector('input[name="latitude"]');
  var lngInput = document.querySelector('input[name="longitude"]');

  var startLat = parseFloat(latInput && latInput.value);
  var startLng = parseFloat(lngInput && lngInput.value);
  var hasStart = isFinite(startLat) && isFinite(startLng);

  // Default view: Chennai-ish; if the site already has coords, start there.
  var map = L.map(el).setView(hasStart ? [startLat, startLng] : [13.0827, 80.2707], hasStart ? 15 : 11);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);

  var marker = null;
  function fill(lat, lng) {
    if (latInput) latInput.value = lat.toFixed(6);
    if (lngInput) lngInput.value = lng.toFixed(6);
  }
  function place(lat, lng, zoom) {
    if (!marker) {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on("dragend", function () { var p = marker.getLatLng(); fill(p.lat, p.lng); });
    } else {
      marker.setLatLng([lat, lng]);
    }
    if (zoom) map.setView([lat, lng], zoom);
    fill(lat, lng);
  }
  if (hasStart) place(startLat, startLng);

  map.on("click", function (e) { place(e.latlng.lat, e.latlng.lng); });

  // Address search via the free Nominatim endpoint.
  var searchInput = document.getElementById("site-map-search");
  var searchBtn = document.getElementById("site-map-search-btn");
  function search() {
    var q = ((searchInput && searchInput.value) || "").trim();
    if (!q) return;
    if (searchBtn) { searchBtn.disabled = true; searchBtn.textContent = "Searching…"; }
    fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q), { headers: { Accept: "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (rows) {
        if (rows && rows.length) place(parseFloat(rows[0].lat), parseFloat(rows[0].lon), 16);
        else alert("No match — try a more specific address, or click the map to drop a pin.");
      })
      .catch(function () { alert("Search failed — click the map to set the location instead."); })
      .finally(function () { if (searchBtn) { searchBtn.disabled = false; searchBtn.textContent = "Search"; } });
  }
  if (searchBtn) searchBtn.addEventListener("click", search);
  if (searchInput) searchInput.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); search(); } });

  // Recalculate size once the surrounding layout has settled.
  setTimeout(function () { map.invalidateSize(); }, 200);
})();
