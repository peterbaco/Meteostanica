const SLOVAK_WEEKDAYS = ["Pondelok", "Utorok", "Streda", "Štvrtok", "Piatok", "Sobota", "Nedeľa"];
const SLOVAK_MONTHS = ["január","február","marec","apríl","máj","jún","júl","august","september","október","november","december"];

let chart = null;
let currentRangeHours = 8;
let chartTimestamps = [];  // surové unix timestampy paralelne k chart.data.labels (labels sú len text) - potrebné pre orezávanie starých bodov pri živom prídavku

function formatLabel(ts, hours) {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString("sk-SK", { hour: "2-digit", minute: "2-digit" });
  if (hours <= 24) return time;
  const date = d.toLocaleDateString("sk-SK", { day: "2-digit", month: "2-digit" });
  return `${date} ${time}`;
}

// ------------------------------------------------------------------
// Hodiny v hlavičke
// ------------------------------------------------------------------
function updateClock() {
  const now = new Date();
  document.getElementById("clockTime").textContent = now.toLocaleTimeString("sk-SK");
  document.getElementById("clockDate").textContent =
    `${SLOVAK_WEEKDAYS[(now.getDay() + 6) % 7]}, ${now.getDate()}. ${SLOVAK_MONTHS[now.getMonth()]} ${now.getFullYear()}`;
}
setInterval(updateClock, 1000);
updateClock();

// ------------------------------------------------------------------
// Živé dáta cez WebSocket (s automatickým reconnectom pri výpadku)
// ------------------------------------------------------------------
function connectWebSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/live`);

  ws.onopen = () => setStatus(true);
  ws.onclose = () => { setStatus(false); setTimeout(connectWebSocket, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (event) => applyCurrent(JSON.parse(event.data));
}

function setStatus(online) {
  const el = document.getElementById("statusLine");
  el.textContent = online ? "Pripojené · živé dáta" : "Bez spojenia so serverom...";
  el.className = "status-line " + (online ? "online" : "offline");
}

function applyCurrent(data) {
  if (!data) return;

  document.getElementById("tempValue").innerHTML =
    data.temp != null ? `${data.temp.toFixed(1)}<small>°C</small>` : `--.-<small>°C</small>`;
  document.getElementById("humValue").innerHTML =
    data.hum != null ? `${data.hum.toFixed(1)}<small>%</small>` : `--.-<small>%</small>`;
  document.getElementById("pressValue").innerHTML =
    data.pressure_sea_level != null ? `${data.pressure_sea_level.toFixed(1)}<small>hPa</small>` : `--.-<small>hPa</small>`;

  const trend = data.trend || {};
  document.getElementById("trendValue").textContent = trend.status || "Zbieram dáta...";
  document.getElementById("trendDetail").textContent = trend.detail || "";

  const aqPill = document.getElementById("aqPill");
  const info = data.tvoc_info || {};
  if (info.warmup_remaining != null) {
    const mm = Math.floor(info.warmup_remaining / 60);
    const ss = Math.floor(info.warmup_remaining % 60).toString().padStart(2, "0");
    aqPill.textContent = `Kvalita ovzdušia: Zahrievanie (${mm}:${ss})`;
    aqPill.style.color = "#D97706";
  } else if (info.label) {
    aqPill.textContent = `Kvalita ovzdušia: ${info.label}`;
    aqPill.style.color = info.color;
  } else {
    aqPill.textContent = "Kvalita ovzdušia: --";
  }

  const battPill = document.getElementById("battPill");
  const bat = data.battery || {};
  if (bat.voltage != null) {
    battPill.style.display = "inline-block";
    battPill.textContent = `Batéria: ${bat.voltage.toFixed(2)} V · ${bat.current_ma?.toFixed(0) ?? "--"} mA`;
  }

  setStatus(!data.is_stale);

  // Nová vzorka -> pridaj bod do grafu, len ak je zobrazené najkratšie (live) okno
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
// Graf teploty a vlhkosti (Chart.js, dve osi Y, textové popisky - bez
// časového adaptéra, ktorý by vyžadoval ďalšiu externú knižnicu)
// ------------------------------------------------------------------
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
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Teplota (°C)", data: temps, borderColor: "#D9381E",
          yAxisID: "yTemp", pointRadius: 0, tension: 0.25, borderWidth: 2,
        },
        {
          label: "Vlhkosť (%)", data: hums, borderColor: "#0284C7",
          yAxisID: "yHum", pointRadius: 0, tension: 0.25, borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 8, autoSkip: true } },
        yTemp: { position: "left", title: { display: true, text: "°C" } },
        yHum: { position: "right", title: { display: true, text: "%" }, grid: { drawOnChartArea: false } },
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
// Karta "Posledných 7 dní"
// ------------------------------------------------------------------
async function loadDaily() {
  const res = await fetch("/api/daily?days=7");
  const json = await res.json();
  const container = document.getElementById("dailyRows");
  container.innerHTML = "";
  (json.data || []).slice().reverse().forEach(entry => {
    const row = document.createElement("div");
    row.className = "daily-row";
    row.innerHTML = `
      <span>${entry.day}</span>
      <span class="d-temp">${entry.avg_temp?.toFixed(1) ?? "--"} °C</span>
      <span class="d-hum">${entry.avg_hum?.toFixed(1) ?? "--"} %</span>`;
    container.appendChild(row);
  });
}

// ------------------------------------------------------------------
// Alarmy kvality ovzdušia
// ------------------------------------------------------------------
async function loadAlarms() {
  const res = await fetch("/api/alarms?limit=50");
  const json = await res.json();
  const tbody = document.getElementById("alarmRows");
  tbody.innerHTML = "";
  (json.data || []).forEach(a => {
    const tr = document.createElement("tr");
    const time = new Date(a.ts * 1000).toLocaleString("sk-SK");
    tr.innerHTML = `
      <td>${time}</td><td>${a.trigger_text}</td>
      <td>${a.temp?.toFixed(1) ?? "--"} °C</td>
      <td>${a.hum?.toFixed(1) ?? "--"} %</td>
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
// Nastavenia (výška, referenčný tlak) - ekvivalent panelu Nastavenia
// z pôvodnej Windows appky. Výška opravuje prepočet na hladinu mora
// (karta "Tlak" vyššie) - kým nie je nastavená, appka zobrazuje surový
// tlak zo senzora nezmenený (altitude_m=0 = žiadny prepočet).
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

  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  msgEl.textContent = json.ok ? "Uložené." : (json.message || "Chyba pri ukladaní.");
  msgEl.style.color = json.ok ? "var(--cal)" : "#DC2626";
  if (json.ok) loadHistory(currentRangeHours);  // prepočíta graf so správnou výškou
});

// ------------------------------------------------------------------
// Štart
// ------------------------------------------------------------------
connectWebSocket();
loadHistory(currentRangeHours);
loadDaily();
loadAlarms();
loadSettings();
setInterval(loadDaily, 5 * 60 * 1000);
setInterval(loadAlarms, 60 * 1000);
