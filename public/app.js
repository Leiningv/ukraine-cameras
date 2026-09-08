const cameras = window.PORTAL_DATA.cameras;
const extraCrossings = window.PORTAL_DATA.extraCrossings || [];
const borderCrossings = window.PORTAL_DATA.borderCrossings || {};
const polandUkraineCrossings = borderCrossings.Poland || [];
const countries = window.PORTAL_DATA.countries;
const sources = window.PORTAL_DATA.sources;
const BORDER_LABELS = {
  Poland: "Ukraine–Poland",
  Slovakia: "Ukraine–Slovakia",
  Hungary: "Ukraine–Hungary",
  Romania: "Ukraine–Romania",
  Moldova: "Ukraine–Moldova",
  Ukraine: "Uman / Ukraine",
};

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
let hlsProxyOk = null;
let wallSelectedId = null;
let playGeneration = 0;

const $ = (id) => document.getElementById(id);

function directHlsUrl(slug) {
  return `https://mediaserver.border.gov.md:50793/hls/${slug}/index.m3u8`;
}

function proxyHlsUrl(slug) {
  return `/api/media?url=${encodeURIComponent(directHlsUrl(slug))}`;
}

function watchLiveHref(cam) {
  return cam.page;
}

function destroyActiveHls() {
  if (activeHls) {
    try {
      activeHls.destroy();
    } catch {
      /* already torn down */
    }
    activeHls = null;
  }
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
  if (cam.kind === "youtube") return { label: "Live stream", cls: "live" };
  if (cam.kind === "page") return { label: "Official live page", cls: "page" };
  return { label: "Offline", cls: "offline" };
}

function isLiveKind(cam) {
  return cam.kind === "hls" || cam.kind === "page" || cam.kind === "youtube";
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

  for (const list of Object.values(borderCrossings)) {
    for (const crossing of list) seed(crossing, crossing.id);
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

function isCountryView() {
  return selectedBorder() !== "all";
}

function isPolandView() {
  return selectedBorder() === "Poland";
}

function searchBlob(value) {
  return [value.name, value.crossing, value.country, value.border, value.title, value.extra]
    .filter(Boolean)
    .join(" ");
}

function matchesSearch(value, q) {
  if (!q) return true;
  const blob = searchBlob(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const needle = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (blob.includes(needle)) return true;
  return blob.split(/[^a-z0-9а-яіїєґ]+/i).some((word) => word.startsWith(needle));
}

function filterText(value) {
  const q = $("search").value.trim().toLowerCase();
  const country = selectedBorder();
  const liveOnly = $("live-only").checked && !isCountryView();
  if (country !== "all" && !String(value.country || "").includes(country) && !String(value.border || "").includes(country)) {
    return false;
  }
  if (liveOnly && value.kind && value.kind !== "hls" && value.kind !== "page") return false;
  return matchesSearch(value, q);
}

function setLocateStatus(message, kind = "") {
  const el = $("locate-status");
  if (!el) return;
  el.textContent = message;
  el.className = `locate-status ${kind}`.trim();
}

function watchLiveButton(cam, label = "Watch live") {
  return `<a class="watch-live" href="${watchLiveHref(cam)}" target="_blank" rel="noopener">${label}</a>`;
}

function fallbackMessage(cam) {
  if (cam.kind === "page") {
    return cam.note || "This camera is on an official page, not a direct video stream.";
  }
  if (cam.kind === "offline") {
    return cam.note || "No public live feed.";
  }
  if (hlsProxyOk === false) {
    return "This network cannot reach Moldova’s camera server (port 50793). Open the official page to watch if your phone or another network allows it.";
  }
  return "If the video does not start, open the official live page.";
}

function playerFallbackHtml(cam, statusText) {
  const status = cameraStatus(cam);
  const title = cam.kind === "offline" ? "Camera offline" : cam.kind === "page" ? "Official live page" : "Live camera";
  return `
    <div class="player-fallback" data-fallback>
      <div class="player-poster" aria-hidden="true">${cam.kind === "offline" ? "○" : "▶"}</div>
      <span class="badge ${status.cls}">${status.label}</span>
      <p class="player-fallback-title">${title}</p>
      <p class="hint" data-status>${statusText || fallbackMessage(cam)}</p>
      ${watchLiveButton(cam, cam.kind === "offline" ? "Official page" : "Watch live")}
    </div>
  `;
}

function mountStaticFallback(host, cam) {
  host.innerHTML = playerFallbackHtml(cam);
}

function tryNativeHls(video, src, gen) {
  return new Promise((resolve, reject) => {
    if (!video.canPlayType("application/vnd.apple.mpegurl")) {
      reject(new Error("no native HLS"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, 8000);
    const ok = () => {
      cleanup();
      resolve();
    };
    const bad = () => {
      cleanup();
      reject(new Error("native error"));
    };
    function cleanup() {
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", ok);
      video.removeEventListener("error", bad);
    }
    if (playGeneration !== gen) {
      cleanup();
      reject(new Error("cancelled"));
      return;
    }
    video.addEventListener("loadedmetadata", ok, { once: true });
    video.addEventListener("error", bad, { once: true });
    video.src = src;
    video.play().catch(() => {});
  });
}

function tryHlsJs(video, src, gen) {
  return new Promise((resolve, reject) => {
    if (!(window.Hls && Hls.isSupported())) {
      reject(new Error("no hls.js"));
      return;
    }
    destroyActiveHls();
    const hls = new Hls({
      enableWorker: true,
      maxBufferLength: 10,
      manifestLoadingTimeOut: 7000,
      manifestLoadingMaxRetry: 1,
      levelLoadingTimeOut: 7000,
      levelLoadingMaxRetry: 1,
      fragLoadingTimeOut: 7000,
      fragLoadingMaxRetry: 1,
    });
    const timer = setTimeout(() => {
      hls.destroy();
      if (activeHls === hls) activeHls = null;
      reject(new Error("timeout"));
    }, 8000);
    activeHls = hls;
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (playGeneration !== gen) {
        clearTimeout(timer);
        hls.destroy();
        reject(new Error("cancelled"));
        return;
      }
      clearTimeout(timer);
      video.play().catch(() => {});
      resolve();
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      clearTimeout(timer);
      hls.destroy();
      if (activeHls === hls) activeHls = null;
      reject(data);
    });
  });
}

async function playWithFallback(video, cam, onOk, onFail) {
  const gen = ++playGeneration;
  if (hlsProxyOk === null) await loadHlsStatus();
  if (playGeneration !== gen) return;
  const proxy = proxyHlsUrl(cam.slug);
  const direct = directHlsUrl(cam.slug);
  const attempts = [];
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    attempts.push(() => tryNativeHls(video, direct, gen));
    if (hlsProxyOk !== false) attempts.push(() => tryNativeHls(video, proxy, gen));
  }
  if (hlsProxyOk !== false) attempts.push(() => tryHlsJs(video, proxy, gen));
  attempts.push(() => tryHlsJs(video, direct, gen));

  for (const attempt of attempts) {
    if (playGeneration !== gen) return;
    try {
      await attempt();
      if (playGeneration !== gen) return;
      onOk();
      return;
    } catch {
      destroyActiveHls();
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* ignore */
      }
    }
  }
  if (playGeneration === gen) {
    onFail(fallbackMessage(cam));
  }
}

function mountHlsPlayer(host, cam) {
  const initialStatus = hlsProxyOk === false ? fallbackMessage(cam) : "Trying live stream…";
  host.innerHTML = `
    ${playerFallbackHtml(cam, initialStatus)}
    <video class="hidden" id="live-video" controls muted playsinline autoplay></video>
  `;
  const video = host.querySelector("video");
  const fallback = host.querySelector("[data-fallback]");
  const status = host.querySelector("[data-status]");
  playWithFallback(
    video,
    cam,
    () => {
      fallback.classList.add("hidden");
      video.classList.remove("hidden");
    },
    (msg) => {
      if (status) status.textContent = msg;
      video.classList.add("hidden");
      fallback.classList.remove("hidden");
    }
  );
}

function mountPlayer(host, cam) {
  destroyActiveHls();
  if (!host) return;
  if (cam.kind === "hls") {
    mountHlsPlayer(host, cam);
    return;
  }
  if (cam.kind === "youtube" && cam.youtube) {
    host.innerHTML = `<iframe class="cam-frame" src="https://www.youtube.com/embed/${cam.youtube}?autoplay=1&mute=1" title="${cam.name}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
    return;
  }
  mountStaticFallback(host, cam);
}

function revealCameraSheet(sheet) {
  try {
    if (typeof sheet.showModal === "function") {
      if (!sheet.open) sheet.showModal();
      return;
    }
  } catch {
    /* fall through to attribute fallback */
  }
  sheet.setAttribute("open", "");
}

function openCameraSheet(cam) {
  const sheet = $("camera-sheet");
  const body = $("sheet-body");
  if (!sheet || !body) return;
  wallSelectedId = cam.id;
  $("sheet-title").textContent = cam.name;
  const status = cameraStatus(cam);
  const related = nearbyQueues(cam.lat, cam.lng);
  const truckN = related.filter((x) => (queues.trucks || []).includes(x)).reduce((n, x) => n + (x.vehicle_in_active_queues_counts || 0), 0);
  const wait = related.reduce((n, x) => Math.max(n, x.wait_time || 0), 0);
  let frame = "";
  if (cam.kind === "page" && cam.page) {
    frame = `<iframe class="cam-frame" src="${cam.page}" title="${cam.name}" referrerpolicy="no-referrer"></iframe>`;
  } else if (cam.kind === "youtube" && cam.youtube) {
    frame = `<iframe class="cam-frame" src="https://www.youtube.com/embed/${cam.youtube}?autoplay=1&mute=1" title="${cam.name}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`;
  }
  body.innerHTML = `
    <span class="badge ${status.cls}">${status.label}</span>
    <h2>${cam.name}</h2>
    <p>${cam.crossing} · ${cam.border}</p>
    <p class="${waitClass(wait)}">Nearby eQueue: ${truckN} trucks · wait ${formatWait(wait)}</p>
    ${frame}
    <div data-player></div>
    <p>${cam.note || "Public camera from the neighbouring border service."}</p>
    <div class="actions">${watchLiveButton(cam, cam.kind === "offline" ? "Official page" : "Watch live")}</div>
  `;
  if (cam.kind === "hls" || cam.kind === "offline") {
    mountPlayer(body.querySelector("[data-player]"), cam);
  }
  revealCameraSheet(sheet);
}

function closeCameraSheet() {
  destroyActiveHls();
  playGeneration += 1;
  const sheet = $("camera-sheet");
  if (!sheet) return;
  if (sheet.open) sheet.close();
  else sheet.removeAttribute("open");
}

function showCamera(cam) {
  openCameraSheet(cam);
}

function showBorderList(groups) {
  const country = selectedBorder();
  const list = country === "all" ? groups : groups.filter((g) => g.country === country);
  const q = $("search").value.trim();
  const label = BORDER_LABELS[country] || "All borders";
  $("detail").innerHTML = `
    <span class="badge page">${label}</span>
    <h2>${q ? `${list.length} crossing${list.length === 1 ? "" : "s"} matching “${q}”` : `All ${list.length} road crossings`}</h2>
    <p>${country === "all" ? "Pick a border above, or tap a crossing." : `Every operating ${label} checkpoint. Live truck/bus counts update from eQueue.`}</p>
    <div class="crossing-list">
      ${list.map((g) => `
        <button type="button" data-crossing="${g.key}">
          <strong>${g.name}</strong><br>
          <span class="hint">${g.extra || "road crossing"} · trucks ${g.trucks} · wait ${formatWait(g.truckWait)}</span>
        </button>
      `).join("") || `<p class="hint">No crossings match “${q}”.</p>`}
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

function showPolandList(groups) {
  showBorderList(groups);
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
    ${isCountryView() ? `<div class="actions"><button type="button" id="back-pl">All ${BORDER_LABELS[selectedBorder()] || "crossings"}</button></div>` : ""}
  `;
  $("detail").querySelectorAll("[data-cam]").forEach((el) => {
    el.addEventListener("click", () => {
      const cam = cameras.find((c) => c.id === el.dataset.cam);
      if (cam) showCamera(cam);
    });
  });
  $("back-pl")?.addEventListener("click", () => {
    $("detail").dataset.pinned = "";
    showBorderList(groupedCrossings().filter(filterText));
  });
  $("detail").scrollIntoView({ behavior: "smooth", block: "end" });
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
    map = L.map("map", { zoomControl: true, attributionControl: true }).setView([49.8, 23.2], 8);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
    }).addTo(map);
    setTimeout(() => map.invalidateSize(), 80);
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
      radius: isNearest ? 12 : 9,
      color: isNearest ? "#ffd15a" : markerColor(group),
      fillColor: isNearest ? "#ffd15a" : markerColor(group),
      fillOpacity: 0.95,
      weight: isNearest ? 4 : 2,
    }).addTo(map);
    marker.bindTooltip(`${isNearest ? "Nearest · " : ""}${group.name}<br>${group.trucks} trucks · ${formatWait(group.truckWait)}`);
    marker.on("click", () => showCrossing(group));
    markers.push(marker);
  }
  placeUserMarker();
  if (groups.length && pendingFit && !nearestKeyHighlight) {
    const bounds = L.latLngBounds(groups.map((g) => [g.lat, g.lng]));
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: groups.length < 4 ? 9 : 8 });
    pendingFit = false;
    setTimeout(() => map.invalidateSize(), 80);
  }
  if (!$("detail").dataset.pinned) showBorderList(groups);
}

function setActiveView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`view-${view}`).classList.add("active");
}

function showMapView() {
  setActiveView("map");
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

function wallCameras() {
  const q = $("search").value.trim().toLowerCase();
  const liveOnly = $("live-only").checked;
  const country = selectedBorder();
  return cameras.filter((cam) => {
    if (!matchesSearch(cam, q)) return false;
    if (liveOnly && !isLiveKind(cam)) return false;
    if (isLiveKind(cam)) return true;
    if (country === "all") return true;
    return String(cam.country || "").includes(country) || String(cam.border || "").includes(country);
  });
}

function renderWallStage(_cam) {
  /* Camera playback is in the overlay sheet so it never opens behind the header. */
}

function renderWallCards() {
  const matched = wallCameras();
  $("wall").innerHTML = matched.map((cam) => {
    const status = cameraStatus(cam);
    const selected = cam.id === wallSelectedId ? " selected" : "";
    const action = cam.kind === "hls" ? "Tap to open" : cam.kind === "page" ? "Official live page" : "Offline";
    return `
    <article class="wall-item cam-card${selected}" data-cam="${cam.id}" tabindex="0" role="button">
      <span class="badge ${status.cls}">${status.label}</span>
      <h3>${cam.name}</h3>
      <p>${cam.crossing}</p>
      <p class="hint">${action}</p>
      <div class="actions">${watchLiveButton(cam, cam.kind === "offline" ? "Official page" : "Watch live")}</div>
    </article>`;
  }).join("") || "<p class='hint'>No cameras match the filter.</p>";

  $("wall").querySelectorAll("[data-cam]").forEach((el) => {
    const open = () => {
      const cam = cameras.find((c) => c.id === el.dataset.cam);
      if (!cam) return;
      wallSelectedId = cam.id;
      $("wall").querySelectorAll(".wall-item").forEach((card) => {
        card.classList.toggle("selected", card.dataset.cam === cam.id);
      });
      openCameraSheet(cam);
    };
    el.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      open();
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

function renderWall() {
  renderWallCards();
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

function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return `${m}m ago`;
}

function updateStats() {
  const live = cameras.filter((c) => c.kind === "hls" || c.kind === "page").length;
  const groups = groupedCrossings();
  const trucks = (queues.trucks || []).reduce((n, x) => n + (x.vehicle_in_active_queues_counts || 0), 0);
  $("stat-live").textContent = live;
  $("stat-crossings").textContent = groups.length;
  $("stat-trucks").textContent = trucks;
  $("stat-updated").textContent = queues.updatedAt ? formatAge(Date.now() - queues.updatedAt) : "–";
}

function refreshWall() {
  if (!$("view-wall").classList.contains("active")) return;
  renderWallCards();
}

function refreshViews() {
  updateStats();
  drawMap();
  renderQueues();
  refreshWall();
}

let hlsStatusPromise = null;

async function loadHlsStatus() {
  if (hlsStatusPromise) return hlsStatusPromise;
  hlsStatusPromise = (async () => {
    try {
      const res = await fetch("/api/hls-status", { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      hlsProxyOk = !!data.ok;
    } catch {
      hlsProxyOk = false;
    }
    return hlsProxyOk;
  })();
  return hlsStatusPromise;
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
    closeCameraSheet();
    setActiveView(btn.dataset.view);
    if (btn.dataset.view === "map" && map) setTimeout(() => map && map.invalidateSize(), 80);
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
  $("detail").dataset.pinned = "";
  if (value !== "all") $("live-only").checked = false;
  showMapView();
  refreshViews();
}

["search", "country-filter", "live-only"].forEach((id) => {
  $(id).addEventListener("input", () => {
    if (id === "search") $("detail").dataset.pinned = "";
    refreshViews();
  });
  $(id).addEventListener("change", () => {
    if (id === "country-filter") setBorderFilter($("country-filter").value);
    else refreshViews();
  });
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => setBorderFilter(chip.dataset.border));
});

$("nearest-btn")?.addEventListener("click", locateNearest);
$("sheet-close")?.addEventListener("click", closeCameraSheet);
$("camera-sheet")?.addEventListener("click", (event) => {
  if (event.target === $("camera-sheet")) closeCameraSheet();
});
$("camera-sheet")?.addEventListener("close", () => {
  destroyActiveHls();
  playGeneration += 1;
});

renderSources();
loadHlsStatus();
document.body.dataset.view = "map";
pendingFit = true;
setBorderFilter("Poland");
loadQueues();
setInterval(loadQueues, 15000);
setInterval(updateStats, 1000);
