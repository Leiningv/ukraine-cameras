const cameras = window.PORTAL_DATA.cameras;
const extraCrossings = window.PORTAL_DATA.extraCrossings;
const polandUkraineCrossings = window.PORTAL_DATA.polandUkraineCrossings || [];
const countries = window.PORTAL_DATA.countries;
const sources = window.PORTAL_DATA.sources;

let queues = { trucks: [], buses: [], updatedAt: 0 };
let map;
let markers = [];
let activeHls;
let pendingFit = false;
let userMarker = null;
let accuracyCircle = null;
let lastUser = null;
let nearestKeyHighlight = null;
let nearestDistanceKm = null;

const $ = (id) => document.getElementById(id);

function hlsUrl(slug) {
  return `/api/media?url=${encodeURIComponent(`https://mediaserver.border.gov.md:50793/hls/${slug}/index.m3u8`)}`;
}

function formatWait(seconds) {
  if (seconds == null || Number.isNaN(Number(seconds))) return "–";
  const s = Number(seconds);
  if (s <= 0) return "0 min";
  const hours = Math.floor(s / 3600);
  const mins = Math.round((s % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `${hours}h ${mins}m`;
  return `${mins} min`;
}

function formatKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(km < 20 ? 1 : 0)} km`;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function waitClass(seconds) {
  if (seconds == null) return "";
  if (seconds < 1800) return "wait-good";
  if (seconds < 6 * 3600) return "wait-mid";
  return "wait-bad";
}

function cameraStatus(cam) {
  if (cam.kind === "hls") return { label: "Live HLS", cls: "live" };
  if (cam.kind === "page") return { label: "Official live page", cls: "page" };
  return { label: "Offline", cls: "offline" };
}

function nearbyQueues(lat, lng) {
  const all = [...(queues.trucks || []), ...(queues.buses || [])];
  return all.filter((item) => {
    if (item.lat == null || item.lng == null) return false;
    return Math.hypot(item.lat - lat, item.lng - lng) < 0.08;
  });
}

function crossingKey(item) {
  return `${Number(item.lat).toFixed(3)},${Number(item.lng).toFixed(3)}`;
}

function groupedCrossings() {
  const groups = new Map();

  function seed(item, key) {
    if (groups.has(key)) return groups.get(key);
    const group = {
      key,
      name: item.name || item.title.split("(")[0].replace(/\.\s*$/, "").trim(),
      country: item.country || countries[item.country_id] || "Unknown",
      lat: item.lat,
      lng: item.lng,
      trucks: 0,
      truckWait: 0,
      buses: 0,
      busWait: null,
      extra: item.types || item.extra || "",
    };
    groups.set(key, group);
    return group;
  }

  function nearestKey(lat, lng, maxDist = 0.08) {
    let best = null;
    let bestDist = maxDist;
    for (const group of groups.values()) {
      const dist = Math.hypot(group.lat - lat, group.lng - lng);
      if (dist < bestDist) {
        best = group.key;
        bestDist = dist;
      }
    }
    return best;
  }

  for (const crossing of polandUkraineCrossings) {
    seed(crossing, crossing.id);
  }

  for (const item of queues.trucks || []) {
    const key = nearestKey(item.lat, item.lng) || crossingKey(item);
    const g = groups.get(key) || seed({ ...item, country: countries[item.country_id] }, key);
    g.trucks += item.vehicle_in_active_queues_counts || 0;
    g.truckWait = Math.max(g.truckWait, item.wait_time || 0);
  }
  for (const item of queues.buses || []) {
    const key = nearestKey(item.lat, item.lng) || crossingKey(item);
    const g = groups.get(key) || seed({ ...item, country: countries[item.country_id] }, key);
    g.buses += item.vehicle_in_active_queues_counts || 0;
    if (item.wait_time != null) g.busWait = Math.max(g.busWait || 0, item.wait_time);
  }
  for (const extra of extraCrossings) {
    if (!nearestKey(extra.lat, extra.lng, 0.05)) {
      seed(extra, extra.id);
    }
  }
  return [...groups.values()];
}

function selectedBorder() {
  return $("country-filter").value;
}

function isPolandView() {
  return selectedBorder() === "Poland";
}

function filterText(value) {
  const q = $("search").value.trim().toLowerCase();
  const country = selectedBorder();
  const liveOnly = $("live-only").checked && !isPolandView();
  if (country !== "all" && !String(value.country || "").includes(country) && !String(value.border || "").includes(country)) {
    return false;
  }
  if (liveOnly && value.kind && value.kind !== "hls" && value.kind !== "page") return false;
  if (!q) return true;
  return [value.name, value.crossing, value.country, value.border, value.title, value.extra]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

function setLocateStatus(message, kind = "") {
  const el = $("locate-status");
  if (!el) return;
  el.textContent = message;
  el.className = `locate-status ${kind}`.trim();
}

function playHls(video, slug) {
  const src = hlsUrl(slug);
  if (activeHls) {
    activeHls.destroy();
    activeHls = null;
  }
  if (window.Hls && Hls.isSupported()) {
    activeHls = new Hls({ enableWorker: true });
    activeHls.loadSource(src);
    activeHls.attachMedia(video);
    activeHls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = src;
    video.play().catch(() => {});
  }
}

function showCamera(cam) {
  const status = cameraStatus(cam);
  const related = nearbyQueues(cam.lat, cam.lng);
  const truckN = related.filter((x) => (queues.trucks || []).includes(x)).reduce((n, x) => n + (x.vehicle_in_active_queues_counts || 0), 0);
  const wait = related.reduce((n, x) => Math.max(n, x.wait_time || 0), 0);
  $("detail").innerHTML = `
    <span class="badge ${status.cls}">${status.label}</span>
    <h2>${cam.name}</h2>
    <p>${cam.crossing} · ${cam.border}</p>
    <p class="${waitClass(wait)}">Nearby eQueue: ${truckN} trucks · wait ${formatWait(wait)}</p>
    ${cam.kind === "hls" ? `<video id="live-video" controls autoplay muted playsinline></video>` : ""}
    <p>${cam.note || "Public camera from the neighbouring border service."}</p>
    <div class="actions">
      <a href="${cam.page}" target="_blank" rel="noopener">Open official live page</a>
    </div>
  `;
  if (cam.kind === "hls") playHls($("live-video"), cam.slug);
}

function showPolandList(groups) {
  const list = groups.filter((g) => g.country === "Poland");
  $("detail").innerHTML = `
    <span class="badge page">Ukraine–Poland</span>
    <h2>All ${list.length} road crossings</h2>
    <p>Every operating Ukraine–Poland checkpoint, including cars and pedestrians. Cameras on this border have been off since 24 Feb 2022; live truck/bus counts still update from eQueue.</p>
    <div class="crossing-list">
      ${list.map((g) => `
        <button type="button" data-crossing="${g.key}">
          <strong>${g.name}</strong><br>
          <span class="hint">${g.extra || "road crossing"} · trucks ${g.trucks} · wait ${formatWait(g.truckWait)}</span>
        </button>
      `).join("")}
    </div>
  `;
  $("detail").querySelectorAll("[data-crossing]").forEach((el) => {
    el.addEventListener("click", () => {
      const group = list.find((g) => g.key === el.dataset.crossing);
      if (group) {
        map.setView([group.lat, group.lng], 11);
        showCrossing(group);
      }
    });
  });
}

function showCrossing(group, extras = {}) {
  $("detail").dataset.pinned = "1";
  const cams = cameras.filter((cam) => Math.hypot(cam.lat - group.lat, cam.lng - group.lng) < 0.08);
  const distance = extras.distanceKm != null ? extras.distanceKm : nearestKeyHighlight === group.key ? nearestDistanceKm : null;
  $("detail").innerHTML = `
    ${distance != null ? `<p class="distance">${formatKm(distance)} from you</p>` : ""}
    <h2>${group.name}</h2>
    <p>${group.country}${group.extra ? ` · ${group.extra}` : ""}</p>
    <p class="${waitClass(group.truckWait)}">Trucks in queue: <strong>${group.trucks}</strong> · wait ${formatWait(group.truckWait)}</p>
    <p>Buses in queue: <strong>${group.buses || "–"}</strong> · wait ${formatWait(group.busWait)}</p>
    <div class="cam-list">
      ${cams.map((cam) => {
        const status = cameraStatus(cam);
        return `<div class="cam-card" data-cam="${cam.id}"><span class="badge ${status.cls}">${status.label}</span><h3>${cam.name}</h3><p>${cam.note || cam.border}</p></div>`;
      }).join("") || "<p class='hint'>No public camera at this crossing.</p>"}
    </div>
    ${isPolandView() ? `<div class="actions"><button type="button" id="back-pl">All Ukraine–Poland crossings</button></div>` : ""}
  `;
  $("detail").querySelectorAll("[data-cam]").forEach((el) => {
    el.addEventListener("click", () => {
      const cam = cameras.find((c) => c.id === el.dataset.cam);
      if (cam) showCamera(cam);
    });
  });
  $("back-pl")?.addEventListener("click", () => {
    $("detail").dataset.pinned = "";
    showPolandList(groupedCrossings().filter(filterText));
  });
  $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function markerColor(group) {
  const hasLive = cameras.some((cam) => cam.kind === "hls" && Math.hypot(cam.lat - group.lat, cam.lng - group.lng) < 0.08);
  if (hasLive) return "#3d8bff";
  if (group.truckWait > 6 * 3600) return "#ff5d5d";
  if (group.truckWait > 1800) return "#ffb020";
  return "#3dd68c";
}

function placeUserMarker() {
  if (!map || !lastUser) return;
  if (userMarker) userMarker.remove();
  if (accuracyCircle) {
    accuracyCircle.remove();
    accuracyCircle = null;
  }
  userMarker = L.circleMarker([lastUser.lat, lastUser.lng], {
    radius: 8,
    color: "#ffffff",
    fillColor: "#3d8bff",
    fillOpacity: 1,
    weight: 3,
  }).addTo(map);
  userMarker.bindTooltip("You are here");
  if (lastUser.accuracy && lastUser.accuracy < 8000) {
    accuracyCircle = L.circle([lastUser.lat, lastUser.lng], {
      radius: lastUser.accuracy,
      color: "#3d8bff",
      weight: 1,
      fillOpacity: 0.08,
    }).addTo(map);
  }
}

function drawMap() {
  if (!map) {
    map = L.map("map").setView([48.4, 25.5], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
  }
  markers.forEach((m) => m.remove());
  markers = [];
  if (userMarker) {
    userMarker.remove();
    userMarker = null;
  }
  const groups = groupedCrossings().filter(filterText);
  for (const group of groups) {
    const isNearest = nearestKeyHighlight === group.key;
    const marker = L.circleMarker([group.lat, group.lng], {
      radius: isNearest ? 12 : 8,
      color: isNearest ? "#ffd15a" : markerColor(group),
      fillColor: isNearest ? "#ffd15a" : markerColor(group),
      fillOpacity: 0.95,
      weight: isNearest ? 4 : 2,
    }).addTo(map);
    marker.bindTooltip(`${isNearest ? "Nearest · " : ""}${group.name}<br>${group.trucks} trucks · ${formatWait(group.truckWait)}`);
    marker.on("click", () => showCrossing(group));
    markers.push(marker);
  }
  for (const cam of cameras.filter(filterText)) {
    if (cam.kind !== "hls" && cam.kind !== "page" && cam.kind !== "offline") continue;
    const marker = L.circleMarker([cam.lat, cam.lng], {
      radius: cam.kind === "offline" ? 4 : 5,
      color: cam.kind === "offline" ? "#8899aa" : "#ffd15a",
      fillColor: cam.kind === "offline" ? "#8899aa" : "#ffd15a",
      fillOpacity: 0.9,
    }).addTo(map);
    marker.bindTooltip(`Camera: ${cam.name}`);
    marker.on("click", () => showCamera(cam));
    markers.push(marker);
  }
  placeUserMarker();
  if (isPolandView() && groups.length) {
    if (pendingFit && !nearestKeyHighlight) {
      const bounds = L.latLngBounds(groups.map((g) => [g.lat, g.lng]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
      pendingFit = false;
    }
    if (!$("detail").dataset.pinned) showPolandList(groups);
  }
}

function showMapView() {
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === "map"));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-map").classList.add("active");
  setTimeout(() => map && map.invalidateSize(), 60);
}

function locateNearest() {
  const btn = $("nearest-btn");
  if (!navigator.geolocation) {
    setLocateStatus("This browser cannot read your location. Try Chrome or Safari on the phone.", "error");
    return;
  }
  showMapView();
  btn.disabled = true;
  setLocateStatus("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.disabled = false;
      const { latitude, longitude, accuracy } = pos.coords;
      lastUser = { lat: latitude, lng: longitude, accuracy };
      const visible = groupedCrossings().filter(filterText);
      if (!visible.length) {
        setLocateStatus("No crossings match the current filter.", "error");
        return;
      }
      let best = visible[0];
      let bestKm = haversineKm(latitude, longitude, best.lat, best.lng);
      for (const group of visible) {
        const km = haversineKm(latitude, longitude, group.lat, group.lng);
        if (km < bestKm) {
          best = group;
          bestKm = km;
        }
      }
      nearestKeyHighlight = best.key;
      nearestDistanceKm = bestKm;
      drawMap();
      map.flyTo([best.lat, best.lng], 11);
      showCrossing(best, { distanceKm: bestKm });
      const filterNote = isPolandView() ? " among Ukraine–Poland crossings" : selectedBorder() === "all" ? "" : ` on the ${selectedBorder()} border`;
      setLocateStatus(`${best.name} · ${formatKm(bestKm)}${filterNote}`, "ok");
    },
    (err) => {
      btn.disabled = false;
      if (err.code === 1) {
        setLocateStatus("Location is blocked. On your phone, tap the lock or AA in the address bar → Site settings → Location → Allow, then tap Nearest to me again.", "error");
      } else if (err.code === 3) {
        setLocateStatus("Location timed out. Move somewhere with a clearer GPS signal and try again.", "error");
      } else {
        setLocateStatus("Could not read your location. Turn on GPS/location services and try again.", "error");
      }
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
  );
}

function renderWall() {
  const matched = cameras.filter((cam) => filterText(cam) && (cam.kind === "hls" || isPolandView()));
  $("wall").innerHTML = matched.map((cam) => {
    const status = cameraStatus(cam);
    return `
    <article class="wall-item cam-card">
      <span class="badge ${status.cls}">${status.label}</span>
      <h3>${cam.name}</h3>
      <p>${cam.crossing}</p>
      ${cam.kind === "hls" ? `<video id="wall-${cam.id}" controls muted playsinline></video>` : `<p class="hint">${cam.note || "No public live feed."}</p>`}
      <div class="actions"><a href="${cam.page}" target="_blank" rel="noopener">Official page</a></div>
    </article>`;
  }).join("") || "<p class='hint'>No cameras match the filter.</p>";
  matched.filter((cam) => cam.kind === "hls").forEach((cam) => playHlsOn($(`wall-${cam.id}`), cam.slug));
}

function playHlsOn(video, slug) {
  if (!video) return;
  const src = hlsUrl(slug);
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ maxBufferLength: 10 });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = src;
  }
}

function renderQueues() {
  const groups = groupedCrossings().filter(filterText);
  const rows = groups.map((g) => {
    const cam = cameras.find((c) => Math.hypot(c.lat - g.lat, c.lng - g.lng) < 0.08);
    const status = cam ? cameraStatus(cam) : { label: "None", cls: "offline" };
    return { g, status };
  });
  $("queue-body").innerHTML = rows.map(({ g, status }) => `<tr>
      <td>${g.name}</td>
      <td>${g.country}</td>
      <td>${g.extra || "–"}</td>
      <td>${g.trucks}</td>
      <td class="${waitClass(g.truckWait)}">${formatWait(g.truckWait)}</td>
      <td>${g.buses || "–"}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
    </tr>`).join("");
  const cards = $("queue-cards");
  if (cards) {
    cards.innerHTML = rows.map(({ g, status }) => `
      <article class="queue-card">
        <h3>${g.name}</h3>
        <p>${g.country} · ${g.extra || "road crossing"}</p>
        <p class="${waitClass(g.truckWait)}">Trucks ${g.trucks} · wait ${formatWait(g.truckWait)}</p>
        <p>Buses ${g.buses || "–"} · <span class="badge ${status.cls}">${status.label}</span></p>
      </article>`).join("");
  }
}

function renderSources() {
  $("sources").innerHTML = sources.map((s) => `
    <article class="source-card">
      <h3>${s.name}</h3>
      <p>${s.why}</p>
      <p><a href="${s.url}" target="_blank" rel="noopener">Open live source</a></p>
    </article>
  `).join("");
}

function updateStats() {
  const live = cameras.filter((c) => c.kind === "hls" || c.kind === "page").length;
  const groups = groupedCrossings();
  const trucks = (queues.trucks || []).reduce((n, x) => n + (x.vehicle_in_active_queues_counts || 0), 0);
  $("stat-live").textContent = live;
  $("stat-crossings").textContent = groups.length;
  $("stat-trucks").textContent = trucks;
  $("stat-updated").textContent = queues.updatedAt ? new Date(queues.updatedAt).toLocaleTimeString() : "–";
}

function refreshViews() {
  updateStats();
  drawMap();
  renderQueues();
  if ($("view-wall").classList.contains("active")) renderWall();
}

async function loadQueues() {
  try {
    const res = await fetch("/api/queues");
    const data = await res.json();
    if (Array.isArray(data.trucks)) queues = data;
  } catch (error) {
    console.error(error);
  }
  refreshViews();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
    btn.classList.add("active");
    $(`view-${btn.dataset.view}`).classList.add("active");
    if (btn.dataset.view === "map" && map) setTimeout(() => map.invalidateSize(), 50);
    if (btn.dataset.view === "wall") renderWall();
  });
});

function setBorderFilter(value) {
  $("country-filter").value = value;
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.classList.toggle("active", chip.dataset.border === value);
  });
  pendingFit = true;
  nearestKeyHighlight = null;
  nearestDistanceKm = null;
  if (value === "Poland") {
    $("live-only").checked = false;
    $("detail").dataset.pinned = "";
  }
  refreshViews();
}

["search", "country-filter", "live-only"].forEach((id) => {
  $(id).addEventListener("input", refreshViews);
  $(id).addEventListener("change", () => {
    if (id === "country-filter") setBorderFilter($("country-filter").value);
    else refreshViews();
  });
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => setBorderFilter(chip.dataset.border));
});

$("nearest-btn")?.addEventListener("click", locateNearest);

renderSources();
loadQueues();
setInterval(loadQueues, 60000);
