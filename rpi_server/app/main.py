# -*- coding: utf-8 -*-
"""
Meteostanica - server pre Raspberry Pi 5.

Nahrádza pôvodnú Windows desktop appku (meteostanica_domov_v2.py) -
architektúra sa mení z "appka číta sériový port priamo" na "ESP32 posiela
dáta cez WiFi na tento server, appka len zobrazuje" (pozri teplomer_I2C.ino
vo firmware/ priečinku - upravené o WiFi + HTTP POST).

Beh:
    uvicorn app.main:app --host 0.0.0.0 --port 8000

Endpointy:
    POST /api/ingest      - sem posiela dáta ESP32 (form-urlencoded)
    GET  /api/current     - posledná známa vzorka + odvodené hodnoty
    GET  /api/history     - história vzoriek pre graf (?hours=24)
    GET  /api/daily       - denné priemery (karta "Posledných 7 dní")
    GET  /api/alarms      - log alarmov kvality ovzdušia
    POST /api/alarms/clear
    GET  /api/settings    - výška / referenčný tlak
    POST /api/settings
    WS   /ws/live         - živé vysielanie novej vzorky všetkým pripojeným klientom
    GET  /                - web dashboard (app/static/index.html)
"""
import asyncio
import json
import math
import time
from collections import deque
from typing import Optional

from fastapi import FastAPI, Form, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import config, database as db, pi_power

app = FastAPI(title="Meteostanica")

# ----------------------------------------------------------------------
# Stav v pamäti (hysteréza TVOC pásma, alarm edge-trigger, kĺzavé priemery
# batérie ESP32 a odberu RPi5) - appka beží ako jeden proces, netreba to
# preto perzistovať mimo databázy (alarmy samotné sa ukladajú do DB, pozri
# db.insert_alarm; surové - nesprimerované - vzorky batérie ostávajú aj
# v tabuľke readings, vyhladzuje sa len to, čo appka POSIELA na dashboard).
# ----------------------------------------------------------------------
_state = {
    "tvoc_band_state": None,       # posledný TVOC label (pre hysterézu)
    "tvoc_alarm_active": False,    # True = alarm pre aktuálny "výskyt" už zaznamenaný
    "first_reading_ts": None,      # referenčný čas pre odhad ENS160 zahrievania
    "last_reading_ts": 0.0,
    # --- batéria ESP32 (INA226) - kĺzavý priemer surových čítaní z ingest() ---
    "batt_v_hist": deque(maxlen=config.BATTERY_AVG_SAMPLES),
    "batt_c_hist": deque(maxlen=config.BATTERY_AVG_SAMPLES),
    "batt_p_hist": deque(maxlen=config.BATTERY_AVG_SAMPLES),
    # --- odber Raspberry Pi 5 (vcgencmd pmic_read_adc) - vlastný periodický
    # cyklus (_pi_power_loop), nezávislý od príchodu vzoriek z ESP32 ---
    "pi_power_ma_hist": deque(maxlen=config.PI_POWER_AVG_SAMPLES),
    "pi_power_w_hist": deque(maxlen=config.PI_POWER_AVG_SAMPLES),
    "pi_power_last": None,         # posledný spriemerovaný výsledok, None kým appka nemá ani jedno platné čítanie
}


def _avg(values):
    return sum(values) / len(values) if values else None


def classify_band(value, boundaries, labels, margin, prev_label):
    """Rovnaká logika ako _classify_band() v pôvodnej Windows appke -
    hysteréza zabraňuje blikaniu klasifikácie tesne pri hranici pásma."""
    band = 0
    for b in boundaries:
        if value >= b:
            band += 1
        else:
            break
    plain_label = labels[band]

    if prev_label is None or prev_label not in labels:
        return plain_label

    prev_band = labels.index(prev_label)
    if band == prev_band:
        return prev_label
    if band > prev_band:
        b = boundaries[prev_band]
        return plain_label if value >= b + margin else prev_label
    b = boundaries[band]
    return plain_label if value < b - margin else prev_label


def station_to_sea_level(station_pressure, altitude_m):
    return station_pressure / (1 - altitude_m / config.BAROMETRIC_SCALE_HEIGHT_M) ** config.BAROMETRIC_EXPONENT


def get_ens160_warmup_remaining():
    if _state["first_reading_ts"] is None:
        return None
    remaining = config.ENS160_WARMUP_SECONDS - (time.time() - _state["first_reading_ts"])
    return remaining if remaining > 0 else None


def classify_comfort(temp, hum):
    """Komfortná zóna (teplota+vlhkosť) - klasifikácia podľa prahov v config.py
    (COMFORT_TEMP_*/COMFORT_HUM_*). level sa používa na strane webu na výber
    farby banneru (good/ok/warn)."""
    if temp is None or hum is None:
        return {"label": "Zbieram dáta...", "detail": "", "emoji": "⏳", "level": "info"}

    temp_ok = config.COMFORT_TEMP_LOW <= temp <= config.COMFORT_TEMP_HIGH

    if hum < config.COMFORT_HUM_DRY:
        hum_txt, hum_level = "sucho", "warn"
    elif hum < config.COMFORT_HUM_IDEAL_LOW:
        hum_txt, hum_level = "mierne sucho", "ok"
    elif hum <= config.COMFORT_HUM_IDEAL_HIGH:
        hum_txt, hum_level = "ideálna vlhkosť", "good"
    elif hum <= config.COMFORT_HUM_OK_HIGH:
        hum_txt, hum_level = "mierne vlhko", "ok"
    else:
        hum_txt, hum_level = "vlhko", "warn"

    if temp_ok and hum_level == "good":
        return {"label": "Ideálny komfort", "detail": "Teplota aj vlhkosť sú v odporúčanom pásme",
                "emoji": "🙂", "level": "good"}
    if temp_ok and hum_level == "ok":
        return {"label": "Príjemný komfort", "detail": f"Teplota vyhovuje, vzduch je {hum_txt}",
                "emoji": "🙂", "level": "ok"}
    if temp_ok:
        return {"label": f"Teplota v poriadku, vzduch je {hum_txt}", "detail": "Zvážte vetranie/zvlhčovanie",
                "emoji": "😐", "level": "warn"}

    temp_txt = "chladno" if temp < config.COMFORT_TEMP_LOW else "teplo"
    return {"label": f"Trochu {temp_txt}, vzduch je {hum_txt}", "detail": "",
            "emoji": "😕", "level": "warn"}


def compute_pressure_trend():
    """Rovnaký princíp ako update_forecast() v pressure_service.py - okno
    posledných PRESSURE_TREND_WINDOW_HOURS, klasifikácia zmeny do 5 stupňov."""
    window = db.get_pressure_trend_window()
    if len(window) < 2:
        return {"status": "Zbieram dáta...", "detail": "", "change": None}

    change = window[-1]["pressure_station"] - window[0]["pressure_station"]
    hours = (window[-1]["ts"] - window[0]["ts"]) / 3600.0

    if change <= -config.PRESSURE_TREND_RAPID_HPA:
        text = "Búrka"
    elif change <= -config.PRESSURE_TREND_MODERATE_HPA:
        text = "Dážď"
    elif change >= config.PRESSURE_TREND_RAPID_HPA:
        text = "Sucho"
    elif change >= config.PRESSURE_TREND_MODERATE_HPA:
        text = "Pekne"
    else:
        text = "Premenlivo"

    return {"status": text, "detail": f"{change:+.1f} hPa/{hours:.1f}h", "change": change}


def battery_percent_from_voltage(voltage):
    """Rovnaká vybíjacia krivka LiPo ako vo firmvéri (teplomer_I2C.ino,
    batteryPercentFromVoltage) - lineárna interpolácia medzi bodmi tabuľky
    v config.py (BATTERY_CURVE_VOLTAGE/PERCENT)."""
    curve_v = config.BATTERY_CURVE_VOLTAGE
    curve_p = config.BATTERY_CURVE_PERCENT
    if voltage >= curve_v[0]:
        return 100.0
    if voltage <= curve_v[-1]:
        return 0.0
    for i in range(len(curve_v) - 1):
        v_high, v_low = curve_v[i], curve_v[i + 1]
        if v_low <= voltage <= v_high:
            p_high, p_low = curve_p[i], curve_p[i + 1]
            ratio = (voltage - v_low) / (v_high - v_low)
            return p_low + ratio * (p_high - p_low)
    return 0.0  # nedosiahnuteľné (pokryté hraničnými prípadmi vyššie), poistka


def get_smoothed_battery():
    """Batéria ESP32 (INA226) - kĺzavý priemer posledných BATTERY_AVG_SAMPLES
    surových čítaní (pozri ingest() nižšie), + dopočítané percento nabitia.
    Vráti voltage=None a pod., kým appka ešte nedostala ani jednu platnú
    vzorku batérie (napr. INA226 nie je na ESP32 zapojený) - web dashboard
    podľa toho kartu Batéria skryje/zobrazí."""
    voltage = _avg(_state["batt_v_hist"])
    return {
        "voltage": voltage,
        "current_ma": _avg(_state["batt_c_hist"]),
        "power_mw": _avg(_state["batt_p_hist"]),
        "percent": battery_percent_from_voltage(voltage) if voltage is not None else None,
    }


def build_current_payload(row):
    """Prevedie surový DB riadok na payload pre dashboard - dopočíta tlak na
    hladinu mora, TVOC pásmo (s hysterézou) a rieši ENS160 zahrievanie."""
    altitude_m = db.get_altitude_m()
    sea_level_pressure = (
        station_to_sea_level(row["pressure_station"], altitude_m)
        if row.get("pressure_station") is not None else None
    )

    warmup_remaining = get_ens160_warmup_remaining()
    tvoc = row.get("tvoc")
    tvoc_info = {"warmup_remaining": warmup_remaining, "label": None, "band_idx": None, "color": None}
    if tvoc is not None and warmup_remaining is None:
        label = classify_band(
            tvoc, config.TVOC_BOUNDARIES, config.TVOC_LABELS, config.TVOC_HYSTERESIS,
            _state["tvoc_band_state"],
        )
        _state["tvoc_band_state"] = label
        band_idx = config.TVOC_LABELS.index(label)
        tvoc_info.update(label=label, band_idx=band_idx, color=config.AIR_QUALITY_BAND_COLORS[band_idx])

        if band_idx >= config.ALARM_TRIGGER_BAND_INDEX:
            if not _state["tvoc_alarm_active"]:
                _state["tvoc_alarm_active"] = True
                db.insert_alarm(
                    f"TVOC: {label}", band_idx,
                    row.get("temp"), row.get("hum"), sea_level_pressure, tvoc,
                )
        else:
            _state["tvoc_alarm_active"] = False

    return {
        "ts": row["ts"],
        "temp": row.get("temp"),
        "hum": row.get("hum"),
        "pressure_sea_level": sea_level_pressure,
        "pressure_station": row.get("pressure_station"),
        "tvoc": tvoc,
        "tvoc_info": tvoc_info,
        "comfort": classify_comfort(row.get("temp"), row.get("hum")),
        "battery": get_smoothed_battery(),
        # RPi5 odber (odhad, cez PMIC) - nezávislé od ESP32, pozri _pi_power_loop()
        "rpi_power": dict(_state["pi_power_last"]) if _state["pi_power_last"] else None,
        "trend": compute_pressure_trend(),
        # aby web vedel odlíšiť "zámerne vypnuté senzory" (Nastavenia) od
        # skutočného výpadku spojenia - pozri setLiveStatus() v app.js
        "device_state": {
            "display_enabled": db.get_display_enabled(),
            "sensors_enabled": db.get_sensors_enabled(),
        },
        "is_stale": (time.time() - row["ts"]) > config.SENSOR_STALE_SECONDS,
    }


# ----------------------------------------------------------------------
# WebSocket - živé vysielanie
# ----------------------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, payload: dict):
        dead = []
        message = json.dumps(payload, default=str)
        for ws in self.active:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


@app.on_event("startup")
def on_startup():
    db.init_db()


# ----------------------------------------------------------------------
# Príjem dát z ESP32 (pozri firmware/teplomer_I2C.ino - sekcia WiFi POST)
# ----------------------------------------------------------------------
@app.post("/api/ingest")
async def ingest(
    temp: Optional[float] = Form(None),
    hum: Optional[float] = Form(None),
    pressure: Optional[float] = Form(None),
    eco2: Optional[float] = Form(None),
    tvoc: Optional[float] = Form(None),
    aqi: Optional[float] = Form(None),
    bat_v: Optional[float] = Form(None),
    bat_ma: Optional[float] = Form(None),
    bat_mw: Optional[float] = Form(None),
):
    # ESP32 posiela -1 pre "hodnota nedostupná" (jednoduchší firmvér než
    # posielanie prázdneho reťazca) - prevedieme na None, rovnaký princíp
    # ako v pôvodnom serial_io.py (parse_float -> None pri NaN).
    def clean(v):
        return None if (v is None or math.isnan(v) or v <= -999) else v

    temp, hum, pressure = clean(temp), clean(hum), clean(pressure)
    eco2, tvoc, aqi = clean(eco2), clean(tvoc), clean(aqi)
    bat_v, bat_ma, bat_mw = clean(bat_v), clean(bat_ma), clean(bat_mw)

    now = time.time()
    if _state["first_reading_ts"] is None:
        _state["first_reading_ts"] = now
    _state["last_reading_ts"] = now

    # Kĺzavý priemer batérie (surové čítania INA226 z ESP32 kolíšu) - do DB
    # nižšie sa ale zapisujú NEsprimerované hodnoty (historická presnosť),
    # priemer sa počíta len pre živé zobrazenie (pozri get_smoothed_battery()).
    # Ak niektorá z trojice chýba (napr. INA226 na ESP32 nezapojený - všetky
    # tri prídu ako None), okno sa nemení, kým sa batéria znova nepripojí.
    if bat_v is not None and bat_ma is not None and bat_mw is not None:
        _state["batt_v_hist"].append(bat_v)
        _state["batt_c_hist"].append(bat_ma)
        _state["batt_p_hist"].append(bat_mw)

    db.insert_reading(temp, hum, pressure, eco2, tvoc, aqi, bat_v, bat_ma, bat_mw, ts=now)
    row = db.get_latest_reading()
    payload = build_current_payload(row)
    await manager.broadcast(payload)
    return {"ok": True}


# ----------------------------------------------------------------------
# REST API pre dashboard
# ----------------------------------------------------------------------
@app.get("/api/current")
def api_current():
    row = db.get_latest_reading()
    if row is None:
        return {"ok": False, "message": "Zatiaľ žiadne dáta zo senzora."}
    return {"ok": True, "data": build_current_payload(row)}


@app.get("/api/history")
def api_history(hours: float = 24):
    rows = db.get_history(hours=hours)
    altitude_m = db.get_altitude_m()
    for r in rows:
        r["pressure_sea_level"] = (
            station_to_sea_level(r["pressure_station"], altitude_m)
            if r.get("pressure_station") is not None else None
        )
    return {"ok": True, "data": rows}


@app.get("/api/daily")
def api_daily(days: int = 7):
    return {"ok": True, "data": db.get_daily_averages(days=days)}


@app.get("/api/alarms")
def api_alarms(limit: int = 100):
    return {"ok": True, "data": db.get_alarms(limit=limit)}


@app.post("/api/alarms/clear")
def api_alarms_clear():
    db.clear_alarms()
    return {"ok": True}


@app.get("/api/settings")
def api_get_settings():
    return {
        "ok": True,
        "data": {
            "altitude_m": db.get_altitude_m(),
            "reference_sea_level_pressure": db.get_reference_pressure(),
        },
    }


@app.post("/api/settings")
def api_set_settings(altitude_m: Optional[float] = Form(None), reference_sea_level_pressure: Optional[float] = Form(None)):
    if altitude_m is not None:
        if not (-500.0 <= altitude_m <= 9000.0):
            return {"ok": False, "message": "Nadmorská výška musí byť v rozsahu -500 až 9000 m."}
        db.set_setting("altitude_m", altitude_m)
    if reference_sea_level_pressure is not None:
        if not (800.0 <= reference_sea_level_pressure <= 1100.0):
            return {"ok": False, "message": "Referenčný tlak musí byť v rozsahu 800 až 1100 hPa."}
        db.set_setting("reference_sea_level_pressure", reference_sea_level_pressure)
    return {"ok": True}


# ----------------------------------------------------------------------
# Vzdialené vypnutie displeja/senzorov na ESP32 - appka tu len ULOŽÍ želaný
# stav (GET nižšie je to, čo si ESP32 pravidelne vyzdvihuje, pozri
# pollDeviceState() v teplomer_I2C.ino); appka na ESP32 samotné nič
# nevynucuje, len číta a rešpektuje aktuálnu hodnotu.
# ----------------------------------------------------------------------
@app.get("/api/device-state")
def api_get_device_state():
    return {
        "ok": True,
        "data": {
            "display_enabled": db.get_display_enabled(),
            "sensors_enabled": db.get_sensors_enabled(),
        },
    }


@app.post("/api/device-state")
def api_set_device_state(display_enabled: Optional[str] = Form(None), sensors_enabled: Optional[str] = Form(None)):
    if display_enabled is not None:
        db.set_display_enabled(display_enabled in ("1", "true", "True"))
    if sensors_enabled is not None:
        db.set_sensors_enabled(sensors_enabled in ("1", "true", "True"))
    return {
        "ok": True,
        "data": {
            "display_enabled": db.get_display_enabled(),
            "sensors_enabled": db.get_sensors_enabled(),
        },
    }


# ----------------------------------------------------------------------
# WebSocket endpoint pre dashboard (živé aktualizácie bez pollingu)
# ----------------------------------------------------------------------
@app.websocket("/ws/live")
async def ws_live(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Hneď po pripojení pošli aktuálny stav, nech dashboard nemusí čakať
        # na ďalšiu vzorku od ESP32 (tá môže prísť o pár sekúnd).
        row = db.get_latest_reading()
        if row is not None:
            await websocket.send_text(json.dumps(build_current_payload(row), default=str))
        while True:
            # Appka od klienta nič neočakáva - len držíme spojenie otvorené
            # a čakáme na jeho prípadné odpojenie.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ----------------------------------------------------------------------
# Periodické udržiavacie úlohy (mazanie starých vzoriek)
# ----------------------------------------------------------------------
async def _maintenance_loop():
    while True:
        await asyncio.sleep(6 * 3600)
        db.purge_old_readings()


@app.on_event("startup")
async def start_maintenance_task():
    asyncio.create_task(_maintenance_loop())


# ----------------------------------------------------------------------
# Periodické meranie odberu Raspberry Pi 5 (pozri app/pi_power.py) -
# nezávislé od vzoriek prichádzajúcich z ESP32, beží na vlastnom intervale
# (config.PI_POWER_SAMPLE_INTERVAL_S). Blokujúce volanie subprocessu ide
# cez asyncio.to_thread(), aby neblokovalo event loop appky.
# ----------------------------------------------------------------------
async def _pi_power_loop():
    while True:
        reading = await asyncio.to_thread(pi_power.read_pi_power)
        if reading is not None:
            _state["pi_power_ma_hist"].append(reading["current_ma"])
            _state["pi_power_w_hist"].append(reading["power_w"])
            _state["pi_power_last"] = {
                "current_ma": _avg(_state["pi_power_ma_hist"]),
                "power_w": _avg(_state["pi_power_w_hist"]),
            }
        # Ak vcgencmd zlyhalo (appka beží mimo RPi a pod.), _pi_power_last
        # ostáva None natrvalo - web dashboard v tom prípade celý riadok
        # "Raspberry Pi 5" v karte Batéria jednoducho nezobrazí.
        await asyncio.sleep(config.PI_POWER_SAMPLE_INTERVAL_S)


@app.on_event("startup")
async def start_pi_power_task():
    asyncio.create_task(_pi_power_loop())


# ----------------------------------------------------------------------
# Statický web dashboard
# ----------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=f"{config.BASE_DIR}/static"), name="static")


@app.get("/")
def index():
    return FileResponse(f"{config.BASE_DIR}/static/index.html")
