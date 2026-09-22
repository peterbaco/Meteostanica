// ============================================================
// KONŠTANTY POLOHY - pre výpočet východu/západu slnka (karta "Slnko").
// Appka nemá senzor GPS, preto je poloha napevno zadaná tu.
// UPRAV podľa reálnej polohy meteostanice, ak sa výrazne líši.
// ============================================================
const STATION_LATITUDE = 49.2;
const STATION_LONGITUDE = 16.6;

// Prahy komfortnej zóny - MUSIA zodpovedať app/config.py (COMFORT_HUM_*),
// appka ich duplikuje len pre textový popisok v prístrojovej lište, hlavnú
// klasifikáciu (banner) počíta server (viď main.py, classify_comfort()).
const COMFORT_HUM_DRY = 30.0, COMFORT_HUM_IDEAL_LOW = 40.0, COMFORT_HUM_IDEAL_HIGH = 60.0, COMFORT_HUM_OK_HIGH = 70.0;

const SLOVAK_MONTHS = ["január","február","marec","apríl","máj","jún","júl","august","september","október","november","december"];
const SLOVAK_WEEKDAYS = ["Nedeľa","Pondelok","Utorok","Streda","Štvrtok","Piatok","Sobota"];

let chart = null;
let currentRangeHours = 8;
let chartTimestamps = [];
let sunTimesToday = null;

// ------------------------------------------------------------------
// Sidebar - prepínanie stránok + zbalenie/vysunutie
// ------------------------------------------------------------------
const PAGE_TITLES = { current: "Aktuálne údaje", stats: "Štatistiky a grafy", alarms: "Alarmy", settings: "Nastavenia" };
document.querySelectorAll(".nav-item[data-page]").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
    item.classList.add("active");
    const pageId = item.dataset.page;
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    document.getElementById("page-" + pageId).classList.add("active");
    document.getElementById("pageTitle").textContent = PAGE_TITLES[pageId];
    if (pageId === "stats" && chart) chart.resize();
  });
});
document.getElementById("sidebarToggle").addEventListener("click", () => {
  document.getElementById("sidebar").classList.toggle("collapsed");
});

// ------------------------------------------------------------------
// Hodiny + denná doba (mení atmosférický gradient hero podľa skutočného
// slnečného času, nie ručne - vypočíta sa raz denne cez getSunTimes())
// ------------------------------------------------------------------
const PARTS = {
  morning: { top: "#1E3A5F", mid: "#3D6B8C", horizon: "#E8A87C", glow: "#FFD79E", glowOpacity: 0.45 },
  day:     { top: "#0A1830", mid: "#123258", horizon: "#2B6E86", glow: "#F4A261", glowOpacity: 0.35 },
  evening: { top: "#1A1030", mid: "#4A2E5C", horizon: "#C9603A", glow: "#FF8A5B", glowOpacity: 0.5 },
  night:   { top: "#050A16", mid: "#0B1526", horizon: "#141E33", glow: "#4FC3F7", glowOpacity: 0.15 },
};
const heroEl = document.getElementById("heroSection");
const daypartStyleTag = document.createElement("style");
document.head.appendChild(daypartStyleTag);

function applyDaypart(part) {
  const p = PARTS[part] || PARTS.day;
  heroEl.style.background = `linear-gradient(180deg, ${p.top} 0%, ${p.mid} 55%, ${p.horizon} 100%)`;
  daypartStyleTag.textContent = `.hero::after { background: radial-gradient(60% 50% at 78% 15%, ${p.glow} 0%, transparent 65%); opacity: ${p.glowOpacity}; }`;
}

function getDaypart(now, sun) {
  if (!sun) return "day";
  const h = now.getHours() + now.getMinutes() / 60;
  const sr = sun.sunrise.getHours() + sun.sunrise.getMinutes() / 60;
  const ss = sun.sunset.getHours() + sun.sunset.getMinutes() / 60;
  if (h < sr - 1 || h > ss + 1) return "night";
  if (h < sr + 1.5) return "morning";
  if (h > ss - 1.5) return "evening";
  return "day";
}

function updateClock() {
  const now = new Date();
  document.getElementById("clockTime").textContent = now.toLocaleTimeString("sk-SK");
  document.getElementById("clockDate").textContent =
    `${SLOVAK_WEEKDAYS[now.getDay()]}, ${now.getDate()}. ${SLOVAK_MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  applyDaypart(getDaypart(now, sunTimesToday));
}
setInterval(updateClock, 1000);

// ------------------------------------------------------------------
// Východ/západ slnka - zjednodušený výpočet (Sunrise/Sunset algoritmus,
// dostatočná presnosť na zobrazenie v minútach). Appka nemá GPS senzor,
// poloha je napevno zadaná v STATION_LATITUDE/STATION_LONGITUDE vyššie.
// ------------------------------------------------------------------
function getSunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const zenith = 90.833;

  function calc(isSunrise) {
    const lngHour = lon / 15;
    const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
    L = (L + 360) % 360;
    let RA = (1 / rad) * Math.atan(0.91764 * Math.tan(L * rad));
    RA = (RA + 360) % 360;
    const Lquadrant = Math.floor(L / 90) * 90;
    const RAquadrant = Math.floor(RA / 90) * 90;
    RA = (RA + (Lquadrant - RAquadrant)) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * rad) - (sinDec * Math.sin(lat * rad))) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null;
    let H = isSunrise ? 360 - (1 / rad) * Math.acos(cosH) : (1 / rad) * Math.acos(cosH);
    H /= 15;
    const T = H + RA - 0.06571 * t - 6.622;
    return (T - lngHour + 24) % 24;
  }

  const sunriseUT = calc(true);
  const sunsetUT = calc(false);
  if (sunriseUT == null || sunsetUT == null) return null;

  function utToLocalDate(ut) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0));
    d.setUTCMinutes(d.getUTCMinutes() + Math.round(ut * 60));
    return d;
  }
  return { sunrise: utToLocalDate(sunriseUT), sunset: utToLocalDate(sunsetUT) };
}

function refreshSunCard() {
  sunTimesToday = getSunTimes(new Date(), STATION_LATITUDE, STATION_LONGITUDE);
  const fmt = (d) => d.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
  if (sunTimesToday) {
    document.getElementById("sunValue").innerHTML = `${fmt(sunTimesToday.sunrise)}<span style="font-size:11px">–${fmt(sunTimesToday.sunset)}</span>`;
    const mins = Math.round((sunTimesToday.sunset - sunTimesToday.sunrise) / 60000);
    document.getElementById("sunSub").textContent = `${Math.floor(mins / 60)}h ${mins % 60}m svetla`;
  } else {
    document.getElementById("sunValue").textContent = "—";
    document.getElementById("sunSub").textContent = "Mimo rozsahu pre tento výpočet";
  }
}
refreshSunCard();
setInterval(refreshSunCard, 3600 * 1000);

// ------------------------------------------------------------------
// Živé dáta cez WebSocket
// ------------------------------------------------------------------
function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/live`);
  ws.onopen = () => setLiveStatus(true);
  ws.onclose = () => { setLiveStatus(false); setTimeout(connectWebSocket, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (event) => applyCurrent(JSON.parse(event.data));
}

function setLiveStatus(online) {
  const pill = document.getElementById("livePill");
  pill.classList.toggle("offline", !online);
  document.getElementById("liveText").textContent = online ? "Pripojené · živé" : "Bez spojenia...";
}

function humidityText(hum) {
  if (hum < COMFORT_HUM_DRY) return "Sucho";
  if (hum < COMFORT_HUM_IDEAL_LOW) return "Mierne sucho";
  if (hum <= COMFORT_HUM_IDEAL_HIGH) return "Ideálne pásmo";
  if (hum <= COMFORT_HUM_OK_HIGH) return "Mierne vlhko";
  return "Vlhko";
}

function updateDial(temp) {
  const minT = -10, maxT = 40;
  const circumference = 452.4;
  if (temp == null) { document.getElementById("dialArc").style.strokeDashoffset = circumference; return; }
  const frac = Math.max(0, Math.min(1, (temp - minT) / (maxT - minT)));
  document.getElementById("dialArc").style.strokeDashoffset = circumference * (1 - frac);
}

function applyCurrent(data) {
  if (!data) return;

  document.getElementById("dialValue").innerHTML = data.temp != null ? `${data.temp.toFixed(1)}<small>°C</small>` : `--.-<small>°C</small>`;
  updateDial(data.temp);

  document.getElementById("humValue").textContent = data.hum != null ? `${data.hum.toFixed(1)}%` : "--.-%";
  document.getElementById("humSub").textContent = data.hum != null ? humidityText(data.hum) : "—";

  document.getElementById("pressValue").innerHTML = data.pressure_sea_level != null ? `${data.pressure_sea_level.toFixed(1)}<span style="font-size:11px">hPa</span>` : `--.-<span style="font-size:11px">hPa</span>`;
  const trend = data.trend || {};
  document.getElementById("trendSub").textContent = [trend.status, trend.detail].filter(Boolean).join(" · ") || "Zbieram dáta...";

  const info = data.tvoc_info || {};
  if (info.warmup_remaining != null) {
    const mm = Math.floor(info.warmup_remaining / 60);
    const ss = Math.floor(info.warmup_remaining % 60).toString().padStart(2, "0");
    document.getElementById("airValue").textContent = "Zahrievanie";
    document.getElementById("airSub").textContent = `${mm}:${ss}`;
  } else if (info.label) {
    document.getElementById("airValue").textContent = info.label;
    document.getElementById("airValue").style.color = info.color;
    document.getElementById("airSub").textContent = data.tvoc != null ? `TVOC ${data.tvoc.toFixed(0)} ppb` : "—";
  }

  const battInst = document.getElementById("instBatt");
  const bat = data.battery || {};
  if (bat.voltage != null) {
    battInst.style.display = "";
    document.getElementById("battValue").textContent = `${bat.voltage.toFixed(2)} V`;
    document.getElementById("battSub").textContent = bat.current_ma != null ? `${bat.current_ma.toFixed(0)} mA` : "—";
  }

  const comfort = data.comfort || {};
  document.getElementById("comfortHeadline").textContent = comfort.label || "Zbieram dáta...";
  document.getElementById("comfortDetail").textContent = comfort.detail || "";
  document.getElementById("comfortEmoji").textContent = comfort.emoji || "⏳";
  document.getElementById("comfortLabel").textContent = comfort.label || "Zbieram dáta...";
  document.getElementById("comfortSub").textContent = comfort.detail || "";
  const banner = document.getElementById("comfortBanner");
  banner.className = "comfort-banner" + (comfort.level ? ` level-${comfort.level}` : "");

  setLiveStatus(!data.is_stale);

  if (chart && currentRangeHours <= 24) {
    chartTimestamps.push(data.ts);
    chart.data.labels.push(formatLabel(data.ts, currentRangeHours));
    chart.data.datasets[0].data.push(data.temp);
    chart.data.datasets[1].data.push(data.hum);
    const cutoff = Date.now() / 1000 - currentRangeHours * 3600;
    while (chartTimestamps.length && chartTimestamps[0] < cutoff) {
      chartTimestamps.shift();
      chart.data.labels.shift();
      chart.data.datasets[0].data.shift();
      chart.data.datasets[1].data.shift();
    }
    chart.update("none");
  }
}

// ------------------------------------------------------------------
// Graf teploty a vlhkosti (tmavá téma, gradientová výplň pod krivkou)
// ------------------------------------------------------------------
function formatLabel(ts, hours) {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
  if (hours <= 24) return time;
  return `${d.toLocaleDateString("sk-SK", { day: "2-digit", month: "2-digit" })} ${time}`;
}

async function loadHistory(hours) {
  currentRangeHours = hours;
  const res = await fetch(`/api/history?hours=${hours}`);
  const json = await res.json();
  const rows = json.data || [];

  chartTimestamps = rows.map(r => r.ts);
  const labels = chartTimestamps.map(ts => formatLabel(ts, hours));
  const temps = rows.map(r => r.temp);
  const hums = rows.map(r => r.hum);

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = temps;
    chart.data.datasets[1].data = hums;
    chart.update();
    return;
  }

  const ctx = document.getElementById("chartTempHum").getContext("2d");
  const gradFill = ctx.createLinearGradient(0, 0, 0, 260);
  gradFill.addColorStop(0, "rgba(255,122,89,0.35)");
  gradFill.addColorStop(1, "rgba(255,122,89,0)");

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Teplota (°C)", data: temps, borderColor: "#FF7A59", backgroundColor: gradFill, fill: true, yAxisID: "yTemp", pointRadius: 0, tension: 0.3, borderWidth: 2 },
        { label: "Vlhkosť (%)", data: hums, borderColor: "#4FC3F7", fill: false, yAxisID: "yHum", pointRadius: 0, tension: 0.3, borderWidth: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#8FA3B8", font: { family: "Space Grotesk", size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: "#8FA3B8", maxTicksLimit: 8, font: { family: "JetBrains Mono", size: 10 } } },
        yTemp: { position: "left", grid: { color: "#ffffff10" }, ticks: { color: "#8FA3B8", font: { family: "JetBrains Mono", size: 10 } }, title: { display: true, text: "°C", color: "#8FA3B8" } },
        yHum: { position: "right", grid: { display: false }, ticks: { color: "#8FA3B8", font: { family: "JetBrains Mono", size: 10 } }, title: { display: true, text: "%", color: "#8FA3B8" } },
      },
    },
  });
}

document.getElementById("rangeButtons").addEventListener("click", (e) => {
  if (e.target.tagName !== "BUTTON") return;
  document.querySelectorAll("#rangeButtons button").forEach(b => b.classList.remove("active"));
  e.target.classList.add("active");
  loadHistory(parseFloat(e.target.dataset.hours));
});

// ------------------------------------------------------------------
// Posledných 7 dní (MIN/MAX na hero stránke + klikateľný týždenný prehľad)
// ------------------------------------------------------------------
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function loadDaily() {
  const res = await fetch("/api/daily?days=7");
  const json = await res.json();
  const rows = json.data || [];

  const today = rows.find(r => r.day === todayKey());
  document.getElementById("todayMin").textContent = today && today.min_temp != null ? `MIN ${today.min_temp.toFixed(1)}°C` : "MIN --.-°C";
  document.getElementById("todayMax").textContent = today && today.max_temp != null ? `MAX ${today.max_temp.toFixed(1)}°C` : "MAX --.-°C";
  if (today && today.min_temp != null && today.max_temp != null) {
    const range = today.max_temp - today.min_temp || 1;
    const frac = Math.max(0, Math.min(1, (today.avg_temp - today.min_temp) / range));
    document.getElementById("minmaxNow").style.left = `${frac * 100}%`;
  }

  const weekRow = document.getElementById("weekRow");
  weekRow.innerHTML = "";
  const maxT = Math.max(...rows.map(r => r.avg_temp || 0), 1);
  const todayStr = todayKey();
  rows.forEach(r => {
    const col = document.createElement("div");
    col.className = "week-day" + (r.day === todayStr ? " today" : "");
    const barHeight = r.avg_temp != null ? 20 + (r.avg_temp / maxT) * 70 : 4;
    const label = new Date(r.day + "T00:00:00").toLocaleDateString("sk-SK", { weekday: "short" });
    col.innerHTML = `<div class="week-bar" style="height:${barHeight}%"></div><div class="wlabel">${r.day === todayStr ? "Dnes" : label}</div>`;
    col.addEventListener("click", () => {
      document.querySelectorAll(".week-day").forEach(c => c.classList.remove("selected"));
      col.classList.add("selected");
      const avg = r.avg_temp != null ? r.avg_temp.toFixed(1) : "--";
      const min = r.min_temp != null ? r.min_temp.toFixed(1) : "--";
      const max = r.max_temp != null ? r.max_temp.toFixed(1) : "--";
      const hum = r.avg_hum != null ? r.avg_hum.toFixed(1) : "--";
      document.getElementById("weekDetail").textContent = `${r.day} · priemer ${avg}°C (min ${min}°C, max ${max}°C) · vlhkosť ${hum}%`;
    });
    weekRow.appendChild(col);
  });
}

// ------------------------------------------------------------------
// Alarmy kvality ovzdušia
// ------------------------------------------------------------------
async function loadAlarms() {
  const res = await fetch("/api/alarms?limit=50");
  const json = await res.json();
  const rows = json.data || [];
  const tbody = document.getElementById("alarmRows");
  tbody.innerHTML = "";

  document.getElementById("alarmsEmptyHint").style.display = rows.length ? "none" : "block";
  const badge = document.getElementById("alarmBadge");
  badge.style.display = rows.length ? "inline-block" : "none";
  badge.textContent = rows.length;

  rows.forEach(a => {
    const tr = document.createElement("tr");
    tr.className = a.band_idx >= 4 ? "sev-dangerous" : (a.band_idx === 3 ? "sev-bad" : "");
    const time = new Date(a.ts * 1000).toLocaleString("sk-SK");
    tr.innerHTML = `
      <td>${time}</td><td>${a.trigger_text}</td>
      <td>${a.temp?.toFixed(1) ?? "--"}°C</td>
      <td>${a.hum?.toFixed(1) ?? "--"}%</td>
      <td>${a.pressure?.toFixed(1) ?? "--"} hPa</td>
      <td>${a.tvoc?.toFixed(0) ?? "--"} ppb</td>`;
    tbody.appendChild(tr);
  });
}

document.getElementById("btnClearAlarms").addEventListener("click", async () => {
  if (!confirm("Naozaj vymazať všetky záznamy alarmov?")) return;
  await fetch("/api/alarms/clear", { method: "POST" });
  loadAlarms();
});

// ------------------------------------------------------------------
// Nastavenia (výška, referenčný tlak)
// ------------------------------------------------------------------
async function loadSettings() {
  const res = await fetch("/api/settings");
  const json = await res.json();
  if (!json.ok) return;
  document.getElementById("inpAltitude").value = json.data.altitude_m;
  document.getElementById("inpRefPressure").value = json.data.reference_sea_level_pressure.toFixed(2);
}

document.getElementById("btnSaveSettings").addEventListener("click", async () => {
  const altitude = document.getElementById("inpAltitude").value;
  const refPressure = document.getElementById("inpRefPressure").value;
  const msgEl = document.getElementById("settingsMsg");

  const body = new URLSearchParams();
  if (altitude !== "") body.set("altitude_m", altitude);
  if (refPressure !== "") body.set("reference_sea_level_pressure", refPressure);

  const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const json = await res.json();
  msgEl.textContent = json.ok ? "Uložené." : (json.message || "Chyba pri ukladaní.");
  msgEl.style.color = json.ok ? "var(--cal)" : "var(--dangerous)";
  if (json.ok) loadHistory(currentRangeHours);
});

// ------------------------------------------------------------------
// Štart
// ------------------------------------------------------------------
updateClock();
connectWebSocket();
loadHistory(currentRangeHours);
loadDaily();
loadAlarms();
loadSettings();
setInterval(loadDaily, 5 * 60 * 1000);
setInterval(loadAlarms, 60 * 1000);
