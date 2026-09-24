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
# Okno vyhodnocovania predĺžené z pôvodných 3h na 6h (2025-09) - klasifikácia
# Búrka/Dážď/Pekne/Sucho/Premenlivo teraz porovnáva vzorku spred 6h s aktuálnou.
# Rovnaké okno (6h) používa aj firmvér ESP32 pre OLED (pozri PRESSURE_HISTORY_SIZE
# v teplomer_I2C.ino) - ak sa toto číslo niekedy zmení, zosynchronizuj aj tam.
# POZOR: prahy RAPID/MODERATE (v hPa) sú stále rovnaké hodnoty ako predtým pri
# 3h okne - pri 6h okne bude klasifikácia o niečo menej citlivá (rovnaká zmena
# tlaku rozložená na 2x dlhší čas je menej "prudká"). Ak sa ukáže, že appka
# hlási "Búrka/Dážď" príliš zriedka (alebo naopak, bežný denný chod tlaku
# spôsobuje falošné hlásenia), treba prahy prekalibrovať pre 6h okno.
PRESSURE_TREND_WINDOW_HOURS = 6
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

# --- BATÉRIA ESP32 (INA226) - percento z napätia + vyhladzovanie ---
# Rovnaká vybíjacia krivka LiPo ako vo firmvéri (teplomer_I2C.ino,
# batteryPercentFromVoltage) - ak sa zmení tam, zosynchronizuj aj tu.
BATTERY_CURVE_VOLTAGE = [
    4.20, 4.15, 4.11, 4.08, 4.02, 3.98, 3.95, 3.91, 3.87, 3.85,
    3.84, 3.82, 3.80, 3.79, 3.77, 3.75, 3.73, 3.71, 3.69, 3.61, 3.27,
]
BATTERY_CURVE_PERCENT = [
    100, 95, 90, 85, 80, 75, 70, 65, 60, 55,
    50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0,
]
# Počet posledných vzoriek napätia/prúdu/výkonu batérie, z ktorých appka počíta
# kĺzavý priemer pre zobrazenie (surové čítania INA226 z ESP32 medzi vzorkami
# dosť kolíšu). Pri vzorkovaní ESP32 ~2s => 6 vzoriek ~ 12s okno.
BATTERY_AVG_SAMPLES = 6

# --- ODBER RASPBERRY PI 5 (len ODHAD, cez vstavaný PMIC) - pozri app/pi_power.py ---
# PMIC meria len interné napájacie vetvy dosky (CPU jadro, RAM...), NIE plný
# odber na 5V USB-C vstupe (USB periférie/HAT/NVMe nie sú plne zarátané) -
# korekcia nižšie je len približná kalibrácia zo zdroja pri PI_POWER_CORRECTION_*.
PI_POWER_SAMPLE_INTERVAL_S = 3       # ako často appka spustí `vcgencmd pmic_read_adc`
PI_POWER_AVG_SAMPLES = 10            # kĺzavý priemer (~30s pri 3s intervale) - čítania PMIC dosť kolíšu
PI_POWER_CORRECTION_SLOPE = 1.1451   # empirická korekcia (súčet vetiev PMIC podhodnocuje skutočný odber)
PI_POWER_CORRECTION_OFFSET = 0.5879  # zdroj: github.com/jfikar/RPi5-power (zmerané USB-C wattmetrom)
