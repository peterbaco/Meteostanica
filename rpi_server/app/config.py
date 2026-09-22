# -*- coding: utf-8 -*-
"""
Konfigurácia servera meteostanice pre Raspberry Pi 5.

Rovnaké princípy/hodnoty ako pôvodný config.py z Windows appky - LEN dáta,
žiadna logika. Väčšina prahov je zámerne prevzatá 1:1 (TVOC pásma, komfortná
zóna, barometrická formula), aby sa web dashboard správal rovnako ako
predchádzajúca desktopová appka.
"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "..", "data", "meteostanica.db")

# --- SIEŤ / SERVER ---
SERVER_HOST = "0.0.0.0"
SERVER_PORT = 8000

# --- BAROMETRICKÁ FORMULA (rovnaké hodnoty ako pressure_service.py) ---
BAROMETRIC_EXPONENT = 5.255
BAROMETRIC_SCALE_HEIGHT_M = 44330.0
DEFAULT_ALTITUDE_M = 0.0
DEFAULT_REFERENCE_SEA_LEVEL_PRESSURE = 1013.25

# --- TVOC (ENS160) - rovnaká klasifikácia ako v pôvodnej appke ---
TVOC_BOUNDARIES = [220, 660, 2200, 5500]  # ppb
TVOC_LABELS = ["Vynikajúca", "Dobrá", "Priemerná", "Zlá", "Nebezpečná"]
TVOC_HYSTERESIS = 15.0
AIR_QUALITY_BAND_COLORS = ["#16A34A", "#65A30D", "#D97706", "#D2492B", "#9A3412"]
ALARM_TRIGGER_BAND_INDEX = 3  # "Zlá" alebo horšie
ALARM_LOG_MAX_ENTRIES = 300

# --- ENS160 ZAHRIEVANIE ---
# Server odvodzuje zahrievanie od PRVEJ prijatej vzorky po reštarte ESP32
# (rovnaký princíp ako connection_time v pôvodnej appke, len namiesto
# otvorenia sériového portu je referenčným bodom prvý úspešný POST po
# reštarte/reconnecte WiFi na strane ESP32 - pozri database.py).
ENS160_WARMUP_SECONDS = 180

# --- KOMFORTNÁ ZÓNA (teplota/vlhkosť) ---
COMFORT_TEMP_LOW = 18.0
COMFORT_TEMP_HIGH = 25.0
COMFORT_HUM_DRY = 30.0
COMFORT_HUM_IDEAL_LOW = 40.0
COMFORT_HUM_IDEAL_HIGH = 60.0
COMFORT_HUM_OK_HIGH = 70.0

# --- TREND TLAKU ---
PRESSURE_TREND_WINDOW_HOURS = 3
PRESSURE_TREND_RAPID_HPA = 6.0
PRESSURE_TREND_MODERATE_HPA = 1.6

# --- UCHOVÁVANIE HISTÓRIE ---
# Po koľkých dňoch sa staré záznamy z DB zahodia (aby databáza nerástla
# donekonečna pri behu appky mesiace/roky). História pre grafy sa načítava
# vždy len za posledných pár hodín/dní, staršie surové vzorky nemajú pre
# bežné zobrazenie význam.
READINGS_RETENTION_DAYS = 30

# Po koľkých sekundách bez novej vzorky od ESP32 sa dashboard/stav považuje
# za "offline" (WiFi výpadok, reštart ESP32 a pod.).
SENSOR_STALE_SECONDS = 30
