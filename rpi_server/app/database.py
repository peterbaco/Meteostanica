# -*- coding: utf-8 -*-
"""
Databázová vrstva (SQLite) pre server bežiaci na Raspberry Pi 5.

Nahrádza pôvodný JSON súbor (data_store.py z Windows appky) - SQLite je tu
vhodnejší, keďže dáta teraz prijíma HTTP endpoint (viacero súbežných
požiadaviek je bežné: POST z ESP32 + GET z web dashboardu + WS klienti) a
appka beží ako dlhodobo bežiaci server, nie jednorazovo spúšťaná desktopová
appka. sqlite3 z štandardnej knižnice stačí - objem dát (1 vzorka ~ raz za
2-5s) je na SQLite triviálny, netreba plnohodnotný DB server.

Prístup k DB je chránený jedným threading.Lock() - FastAPI endpointy bežia
v jednom procese, prípadné súbežné zápisy (POST z ESP32) a čítania (GET z
dashboardu) sa takto jednoducho serializujú. Pri tomto objeme dát to nie je
výkonnostné obmedzenie.
"""
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timedelta

from . import config

_lock = threading.Lock()
_conn = None


def _get_conn():
    global _conn
    if _conn is None:
        import os
        os.makedirs(os.path.dirname(config.DB_PATH), exist_ok=True)
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
    return _conn


@contextmanager
def _cursor():
    with _lock:
        conn = _get_conn()
        cur = conn.cursor()
        try:
            yield cur
            conn.commit()
        finally:
            cur.close()


def init_db():
    with _cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS readings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                temp REAL,
                hum REAL,
                pressure_station REAL,
                eco2 REAL,
                tvoc REAL,
                aqi REAL,
                bat_voltage REAL,
                bat_current_ma REAL,
                bat_power_mw REAL
            )
            """
        )
        cur.execute("CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings (ts)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS alarms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL NOT NULL,
                trigger_text TEXT NOT NULL,
                band_idx INTEGER,
                temp REAL,
                hum REAL,
                pressure REAL,
                tvoc REAL
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
    # Predvolené nastavenia, ak ešte neexistujú (pozri get_setting/set_setting nižšie)
    if get_setting("altitude_m") is None:
        set_setting("altitude_m", str(config.DEFAULT_ALTITUDE_M))
    if get_setting("reference_sea_level_pressure") is None:
        set_setting("reference_sea_level_pressure", str(config.DEFAULT_REFERENCE_SEA_LEVEL_PRESSURE))


# ----------------------------------------------------------------------
# Nastavenia (výška, referenčný tlak - ekvivalent Nastavení z Windows appky)
# ----------------------------------------------------------------------
def get_setting(key, default=None):
    with _cursor() as cur:
        cur.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cur.fetchone()
        return row["value"] if row else default


def set_setting(key, value):
    with _cursor() as cur:
        cur.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )


def get_altitude_m():
    return float(get_setting("altitude_m", config.DEFAULT_ALTITUDE_M))


def get_reference_pressure():
    return float(get_setting("reference_sea_level_pressure", config.DEFAULT_REFERENCE_SEA_LEVEL_PRESSURE))


# ----------------------------------------------------------------------
# Vzorky zo senzorov
# ----------------------------------------------------------------------
def insert_reading(temp, hum, pressure_station, eco2, tvoc, aqi,
                    bat_voltage=None, bat_current_ma=None, bat_power_mw=None, ts=None):
    ts = ts if ts is not None else time.time()
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO readings
                (ts, temp, hum, pressure_station, eco2, tvoc, aqi, bat_voltage, bat_current_ma, bat_power_mw)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (ts, temp, hum, pressure_station, eco2, tvoc, aqi, bat_voltage, bat_current_ma, bat_power_mw),
        )
        return cur.lastrowid


def get_latest_reading():
    with _cursor() as cur:
        cur.execute("SELECT * FROM readings ORDER BY ts DESC LIMIT 1")
        row = cur.fetchone()
        return dict(row) if row else None


def get_history(hours=24, max_points=2000):
    """Vráti vzorky za posledných `hours` hodín, chronologicky. Pri veľmi
    dlhom okne (napr. 7 dní) sa dáta rovnomerne preriedia na max_points, aby
    graf na webe nedostal desaťtisíce bodov naraz."""
    since = time.time() - hours * 3600
    with _cursor() as cur:
        cur.execute("SELECT COUNT(*) as c FROM readings WHERE ts >= ?", (since,))
        total = cur.fetchone()["c"]
        step = max(1, total // max_points)
        cur.execute(
            """
            SELECT * FROM readings
            WHERE ts >= ? AND (id % ?) = 0
            ORDER BY ts ASC
            """,
            (since, step),
        )
        return [dict(r) for r in cur.fetchall()]


def get_pressure_trend_window(hours=None):
    """Vzorky tlaku za posledné PRESSURE_TREND_WINDOW_HOURS - pre výpočet
    trendu (rovnaký princíp ako update_forecast() v pôvodnej appke)."""
    hours = hours or config.PRESSURE_TREND_WINDOW_HOURS
    since = time.time() - hours * 3600
    with _cursor() as cur:
        cur.execute(
            "SELECT ts, pressure_station FROM readings "
            "WHERE ts >= ? AND pressure_station IS NOT NULL ORDER BY ts ASC",
            (since,),
        )
        return [dict(r) for r in cur.fetchall()]


def purge_old_readings():
    cutoff = time.time() - config.READINGS_RETENTION_DAYS * 86400
    with _cursor() as cur:
        cur.execute("DELETE FROM readings WHERE ts < ?", (cutoff,))


# ----------------------------------------------------------------------
# Alarmy kvality ovzdušia (ekvivalent record_alarm() z Windows appky)
# ----------------------------------------------------------------------
def insert_alarm(trigger_text, band_idx, temp, hum, pressure, tvoc):
    with _cursor() as cur:
        cur.execute(
            """
            INSERT INTO alarms (ts, trigger_text, band_idx, temp, hum, pressure, tvoc)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (time.time(), trigger_text, band_idx, temp, hum, pressure, tvoc),
        )
        cur.execute(
            "DELETE FROM alarms WHERE id NOT IN "
            "(SELECT id FROM alarms ORDER BY ts DESC LIMIT ?)",
            (config.ALARM_LOG_MAX_ENTRIES,),
        )


def get_alarms(limit=100):
    with _cursor() as cur:
        cur.execute("SELECT * FROM alarms ORDER BY ts DESC LIMIT ?", (limit,))
        return [dict(r) for r in cur.fetchall()]


def clear_alarms():
    with _cursor() as cur:
        cur.execute("DELETE FROM alarms")


def get_daily_averages(days=7):
    """Denné priemery teploty/vlhkosti za posledných `days` dní - ekvivalent
    karty 'Posledných 7 dní' z Windows appky. Skupinuje podľa lokálneho
    kalendárneho dňa (strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime'))."""
    since = time.time() - days * 86400
    with _cursor() as cur:
        cur.execute(
            """
            SELECT
                strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
                AVG(temp) AS avg_temp,
                AVG(hum) AS avg_hum,
                MIN(temp) AS min_temp,
                MAX(temp) AS max_temp
            FROM readings
            WHERE ts >= ? AND temp IS NOT NULL
            GROUP BY day
            ORDER BY day ASC
            """,
            (since,),
        )
        return [dict(r) for r in cur.fetchall()]
