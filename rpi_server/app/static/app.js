// ============================================================
// KONŠTANTY POLOHY - pre výpočet východu/západu slnka (karta
// "Východ a západ slnka") a pre prepočet tlaku (karta "Tlak").
// Appka nemá senzor GPS, preto je poloha napevno zadaná tu -
// Adamov, okres Blansko, Jihomoravský kraj.
// ============================================================
const STATION_LATITUDE = 49.297;
const STATION_LONGITUDE = 16.642;

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
let lastSampleTs = null;

// Dnešné MIN/MAX teploty a vlhkosti (vrátane času výskytu) - naplní ich
// loadDaily() z /api/daily (autoritatívny zdroj, obnova každých 5 min),
// priebežne ich medzi tým rozširuje aj applyCurrent() pri každej novej
// živej vzorke, nech kruhové ukazovatele nečakajú na ďalší /api/daily poll.
let todayTemp = { min: null, max: null, minTs: null, maxTs: null };
let todayHum = { min: null, max: null, minTs: null, maxTs: null };

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
// slnečného času, nie ručne - vypočíta sa raz denne cez getSunTimes()) +
// text "Posledná vzorka: HH:MM:SS (pred Ns)" v hornej lište.
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

  // bod 6 (predch. kolo): pageSub sa už nezasekne na "Čakám na prvú
  // vzorku..." - keď appka aspoň raz dostala dáta, ukazuje čas poslednej
  // vzorky a jej vek v sekundách (aktualizuje sa každú sekundu).
  const sub = document.getElementById("pageSub");
  if (lastSampleTs != null) {
    const ageS = Math.max(0, Math.round(Date.now() / 1000 - lastSampleTs));
    const t = new Date(lastSampleTs * 1000).toLocaleTimeString("sk-SK");
    sub.textContent = `Posledná vzorka: ${t} (pred ${ageS}s)`;
  }
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
    // oba časy (východ aj západ) rovnakou veľkosťou písma - žiadny <small>
    document.getElementById("sunValue").innerHTML =
      `<span>${fmt(sunTimesToday.sunrise)}</span><span class="sep">–</span><span>${fmt(sunTimesToday.sunset)}</span>`;
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
// Kruhové ukazovatele (teplota + vlhkosť) - kruh je vždy celý (gradient),
// biela bodka sa posúva po obvode podľa polohy aktuálnej hodnoty medzi
// dnešným MIN a MAX (todayTemp/todayHum, pozri loadDaily() a applyCurrent()).
// ------------------------------------------------------------------
const DIAL_R = 58, DIAL_CX = 70, DIAL_CY = 70;

function fracInRange(value, min, max) {
  if (value == null || min == null || max == null || max === min) return 0.5;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

function setDot(id, frac) {
  const angle = (-90 + frac * 360) * Math.PI / 180; // 0 % = hore, v smere hodinových ručičiek
  const el = document.getElementById(id);
  el.setAttribute("cx", DIAL_CX + DIAL_R * Math.cos(angle));
  el.setAttribute("cy", DIAL_CY + DIAL_R * Math.sin(angle));
}

function fmtTime(ts) {
  return ts != null ? new Date(ts * 1000).toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" }) : "--:--";
}

function renderFoot(elId, unit, decimals, range) {
  const el = document.getElementById(elId);
  if (range.min == null || range.max == null) { el.textContent = "Zbieram dáta..."; return; }
  el.innerHTML =
    `<span class="lbl min">MIN ${range.min.toFixed(decimals)}${unit}</span> <span class="at">${fmtTime(range.minTs)}</span><br>` +
    `<span class="lbl max">MAX ${range.max.toFixed(decimals)}${unit}</span> <span class="at">${fmtTime(range.maxTs)}</span>`;
}

function updateDial(temp) {
  document.getElementById("dialValue").innerHTML = temp != null ? `${temp.toFixed(1)}<small>°C</small>` : `--.-<small>°C</small>`;
  setDot("dotTemp", fracInRange(temp, todayTemp.min, todayTemp.max));
  renderFoot("tempFoot", "°C", 1, todayTemp);
}

function updateDialHum(hum) {
  document.getElementById("dialValueHum").innerHTML = hum != null ? `${Math.round(hum)}<small>%</small>` : `--<small>%</small>`;
  setDot("dotHum", fracInRange(hum, todayHum.min, todayHum.max));
  renderFoot("humFoot", "%", 0, todayHum);
}

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

function setLiveStatus(online, sensorsOff) {
  const pill = document.getElementById("livePill");
  pill.classList.toggle("offline", !online && !sensorsOff);
  document.getElementById("liveText").textContent =
    sensorsOff ? "Senzory vypnuté" : (online ? "Pripojené · živé" : "Bez spojenia...");
}

function applyCurrent(data) {
  if (!data) return;
  lastSampleTs = data.ts;

  // priebežné rozšírenie dnešného MIN/MAX medzi dvoma /api/daily pollami
  // (loadDaily beží raz za 5 min) - server (get_daily_averages) je aj tak
  // autoritatívny zdroj, toto len drží kruh presný aj medzitým.
  if (data.temp != null) {
    if (todayTemp.min == null || data.temp < todayTemp.min) { todayTemp.min = data.temp; todayTemp.minTs = data.ts; }
    if (todayTemp.max == null || data.temp > todayTemp.max) { todayTemp.max = data.temp; todayTemp.maxTs = data.ts; }
  }
  if (data.hum != null) {
    if (todayHum.min == null || data.hum < todayHum.min) { todayHum.min = data.hum; todayHum.minTs = data.ts; }
    if (todayHum.max == null || data.hum > todayHum.max) { todayHum.max = data.hum; todayHum.maxTs = data.ts; }
  }

  updateDial(data.temp);
  updateDialHum(data.hum);

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

  // Batéria ESP32 (% kapacity dopočítané zo vzoriek, kĺzavý priemer napočíta
  // server - pozri main.py get_smoothed_battery()) + samostatný odhad
  // odberu Raspberry Pi 5 (main.py rpi_power, pozri app/pi_power.py) - karta
  // sa zobrazí, ak je dostupný aspoň jeden z týchto dvoch zdrojov.
  const battInst = document.getElementById("instBatt");
  const battEsp = document.getElementById("battEsp");
  const rpiBlock = document.getElementById("rpiPower");
  const bat = data.battery || {};
  const rpi = data.rpi_power || null;
  const hasBat = bat.voltage != null;
  const hasRpi = rpi != null;

  battInst.style.display = (hasBat || hasRpi) ? "" : "none";
  battEsp.style.display = hasBat ? "" : "none";
  if (hasBat) {
    document.getElementById("battValue").innerHTML = `${Math.round(bat.percent)}<span style="font-size:11px">%</span>`;
    const sign = bat.current_ma >= 0 ? "+" : "";
    document.getElementById("battSub").textContent = `${sign}${Math.round(bat.current_ma)} mA · ${(bat.power_mw / 1000).toFixed(2)} W`;
  }
  rpiBlock.style.display = hasRpi ? "" : "none";
  if (hasRpi) {
    document.getElementById("rpiMa").textContent = `${Math.round(rpi.current_ma)} mA`;
    document.getElementById("rpiW").textContent = `${rpi.power_w.toFixed(2)} W`;
  }

  const comfort = data.comfort || {};
  document.getElementById("comfortEmoji").textContent = comfort.emoji || "⏳";
  document.getElementById("comfortLabel").textContent = comfort.label || "Zbieram dáta...";
  document.getElementById("comfortSub").textContent = comfort.detail || "";
  const banner = document.getElementById("comfortBanner");
  banner.className = "comfort-banner" + (comfort.level ? ` level-${comfort.level}` : "");

  const sensorsOff = data.device_state && data.device_state.sensors_enabled === false;
  setLiveStatus(!data.is_stale, sensorsOff);

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
// Posledných 7 dní (MIN/MAX+čas na hero kruhoch + klikateľný týždenný prehľad)
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
  if (today) {
    todayTemp = { min: today.min_temp, max: today.max_temp, minTs: today.min_temp_ts, maxTs: today.max_temp_ts };
    todayHum = { min: today.min_hum, max: today.max_hum, minTs: today.min_hum_ts, maxTs: today.max_hum_ts };
  }
  renderFoot("tempFoot", "°C", 1, todayTemp);
  renderFoot("humFoot", "%", 0, todayHum);

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
// Vypnutie displeja / senzorov na ESP32 (napr. cez noc, aby nebolo treba
// fyzicky odpájať batériu) - appka len uloží želaný stav do DB, samotné
// ESP32 si ho pravidelne (každých pár sekúnd) vyzdvihne cez
// GET /api/device-state a podľa toho vypne OLED / prestane čítať senzory
// (pozri pollDeviceState() v teplomer_I2C.ino).
// ------------------------------------------------------------------
let deviceState = { display_enabled: true, sensors_enabled: true };

async function loadPowerState() {
  try {
    const res = await fetch("/api/device-state");
    const json = await res.json();
    if (!json.ok) return;
    deviceState = json.data;
    renderPowerState();
  } catch (e) {
    // appka na RPi/sieť momentálne nedostupná - skús znova pri ďalšom polle
  }
}

function renderPowerState() {
  const dText = document.getElementById("displayStateText");
  const sText = document.getElementById("sensorsStateText");
  const dBtn = document.getElementById("btnToggleDisplay");
  const sBtn = document.getElementById("btnToggleSensors");

  dText.textContent = deviceState.display_enabled ? "Zapnutý" : "Vypnutý";
  dText.className = "power-state " + (deviceState.display_enabled ? "on" : "off");
  dBtn.textContent = deviceState.display_enabled ? "Vypnúť" : "Zapnúť";
  dBtn.classList.toggle("is-off", !deviceState.display_enabled);
  dBtn.disabled = false;

  sText.textContent = deviceState.sensors_enabled ? "Zapnuté" : "Vypnuté";
  sText.className = "power-state " + (deviceState.sensors_enabled ? "on" : "off");
  sBtn.textContent = deviceState.sensors_enabled ? "Vypnúť" : "Zapnúť";
  sBtn.classList.toggle("is-off", !deviceState.sensors_enabled);
  sBtn.disabled = false;
}

async function togglePower(key) {
  const msgEl = document.getElementById("powerMsg");
  const body = new URLSearchParams();
  body.set(key, deviceState[key] ? "0" : "1");
  const res = await fetch("/api/device-state", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const json = await res.json();
  if (json.ok) {
    deviceState = json.data;
    renderPowerState();
    msgEl.textContent = "Uložené - ESP32 si zmenu vyzdvihne do ~5 s.";
    msgEl.style.color = "var(--cal)";
  } else {
    msgEl.textContent = json.message || "Chyba pri ukladaní.";
    msgEl.style.color = "var(--dangerous)";
  }
}

document.getElementById("btnToggleDisplay").addEventListener("click", () => togglePower("display_enabled"));
document.getElementById("btnToggleSensors").addEventListener("click", () => togglePower("sensors_enabled"));

// ------------------------------------------------------------------
// Štart
// ------------------------------------------------------------------
updateClock();
connectWebSocket();
loadHistory(currentRangeHours);
loadDaily();
loadAlarms();
loadSettings();
loadPowerState();
setInterval(loadDaily, 5 * 60 * 1000);
setInterval(loadAlarms, 60 * 1000);
setInterval(loadPowerState, 5 * 1000);
