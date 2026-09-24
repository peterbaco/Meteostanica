#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <Adafruit_AHTX0.h>
#include <DFRobot_ENS160.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <INA226.h>
#include <WiFi.h>
#include <HTTPClient.h>

// --- ARCHITEKTÚRA (zmenené - pozri projekt "rpi_server") ---
// ESP32 už neposiela dáta appke cez USB/sériový port - appka teraz beží ako
// server na Raspberry Pi 5 a dáta prijíma cez WiFi (HTTP POST na /api/ingest,
// pozri sekciu "WIFI + ODOSIELANIE NA SERVER" nižšie). Sériový port
// (Serial.print) ostáva zachovaný LEN pre lokálne ladenie cez USB kábel
// (Arduino IDE Serial Monitor) - appka naň už nie je nijako naviazaná.
// Všetka lokálna funkcionalita (OLED, INA226, senzory) je bezo zmeny.

#define PIN_I2C_SDA 4
#define PIN_I2C_SCL 5

// --- WIFI + ODOSIELANIE NA SERVER (Raspberry Pi 5) ---
// UPRAV podľa svojej siete pred nahraním na dosku:
const char *WIFI_SSID = "TVOJA_WIFI_SIET";
const char *WIFI_PASSWORD = "TVOJE_WIFI_HESLO";
// IP adresa (alebo hostname) RPi5 v lokálnej sieti - najlepšie nastav RPi
// na STATICKÚ IP (DHCP reservation na routeri), inak sa táto adresa časom
// môže zmeniť a ESP32 prestane vedieť kam posielať dáta.
const char *SERVER_HOST = "192.168.0.XXX";
const uint16_t SERVER_PORT = 8000;
const char *SERVER_PATH = "/api/ingest";
// Vzdialené vypnutie displeja/senzorov z webu (Nastavenia) - appka sem
// pravidelne posiela GET a rešpektuje, čo server vráti. Účel: dá sa
// appku "utlmiť" cez noc (menší odber, nie však nulový - pozri poznámku
// pri pollDeviceState() nižšie), bez nutnosti fyzicky odpájať batériu.
const char *DEVICE_STATE_PATH = "/api/device-state";
const unsigned long DEVICE_STATE_POLL_INTERVAL_MS = 5000UL;
unsigned long lastDeviceStatePollMs = 0;
bool displayEnabled = true;   // posledný známy stav z webu (predvolene zapnuté)
bool sensorsEnabled = true;   // posledný známy stav z webu (predvolene zapnuté)
bool oledBlanked = false;     // sleduje, či je OLED aktuálne zhasnutý kvôli displayEnabled=false
// Ako dlho (ms) čakať na WiFi pripojenie pri štarte/reconnecte, kým sa appka
// vzdá a skúsi znova o chvíľu neskôr (loop() medzitým pokračuje ďalej -
// senzory/OLED fungujú aj bez WiFi, len sa dáta nikam neodošlú).
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 10000UL;
// Ako často (ms) sa má appka pokúsiť o reconnect, ak je WiFi odpojené.
const unsigned long WIFI_RECONNECT_INTERVAL_MS = 15000UL;
unsigned long lastWifiAttemptMs = 0;
 
// Po koľkých po sebe idúcich neúspešných čítaniach sa má skúsiť reconnect
#define MAX_FAILS_BEFORE_RECONNECT 5
 
// Adresa ENS160 podľa zapojenia ADD pinu:
//   ADD -> 3V3 (alebo nezapojene s pull-upom)  => 0x53
//   ADD -> GND                                  => 0x52
#define ENS160_I2C_ADDR 0x53

// --- OLED (0,91", SSD1306, 128x32, I2C, zdieľa rovnakú I2C zbernicu ako
// senzory - Wire.begin() nižšie v setup()) ---
// POZOR: vstavaný font Adafruit_GFX (classic 5x7) nepozná slovenskú
// diakritiku (á/č/ď/é/í/ľ/ĺ/ň/ó/ô/š/ť/ú/ý/ž) - texty pre OLED sú preto
// zámerne bez diakritiky (Adafruit_SSD1306 vypíše namiesto neznámeho znaku
// prázdne/skreslené políčko). Ak by bola diakritika na displeji niekedy
// potrebná, treba prejsť na U8g2lib s vlastným UTF-8 fontom.
#define OLED_WIDTH 128
#define OLED_HEIGHT 32
#define OLED_RESET -1
#define OLED_I2C_ADDR 0x3C

// --- INA226 (monitor batérie - napätie/prúd/výkon, zapojený za TP4056)---
// Modul má vlastnú I2C adresu (default 0x40 pri A0/A1 na GND, pozri
// wiring poznámku nižšie pri initIna()) - nekoliduje so žiadnym z ostatných
// I2C zariadení na tejto zbernici (BME280 0x76/0x77, AHT21 0x38,
// ENS160 0x53/0x52, OLED 0x3C).
#define INA226_I2C_ADDR 0x40
// Hodnota shuntu podľa KONKRÉTNEHO INA226 modulu - bežné hotové breakout
// dosky majú vstavaný 0.1 Ohm shunt (over si to na svojej doske/v jej
// datasheete, prípadne odmeraj multimetrom - pozri README knižnice
// RobTillaart/INA226). Ak je iný, uprav TU.
const float INA226_SHUNT_OHM = 0.1f;
// Maximálny očakávaný prúd cez shunt - ESP32-C3 + senzory + OLED bežne
// berú rádovo desiatky až nízke stovky mA. INA226 vie hardvérovo merať
// napätie na shunte len do ±81.9 mV (pozri INA226_ERR_SHUNTVOLTAGE_HIGH
// v knižnici RobTillaart/INA226) - pri shunte 0.1Ω je preto NAJVYŠŠIA
// možná hodnota tu 0.819A (0.1Ω × 0.819A = 81.9mV). 0.8A je bezpečná
// rezerva pod týmto limitom (pôvodná hodnota 1.0A limit prekračovala,
// setMaxCurrentShunt() preto tichoúspešne NEkalibroval a getCurrent_mA()/
// getPower_mW() vracali natvrdo 0 - pozri diagnostický výpis v initIna()).
const float INA226_MAX_CURRENT_A = 0.8f;
 
Adafruit_BME280 bme;
Adafruit_AHTX0 aht;
DFRobot_ENS160_I2C ens160(&Wire, ENS160_I2C_ADDR);
Adafruit_SSD1306 oled(OLED_WIDTH, OLED_HEIGHT, &Wire, OLED_RESET);
INA226 ina226(INA226_I2C_ADDR, &Wire);
 
uint8_t bmeAddress = 0x76;   // adresa, na ktorej sa BME280 naposledy našiel
 
bool bmeOk = false;          // je BME280 aktuálne inicializovaný a funkčný?
bool ahtOk = false;          // je AHT21 aktuálne inicializovaný a funkčný?
bool ensOk = false;          // je ENS160 aktuálne inicializovaný a funkčný?
bool oledOk = false;         // je OLED aktuálne inicializovaný a funkčný?
bool inaOk = false;          // je INA226 aktuálne inicializovaný a funkčný?
 
uint8_t bmeFailCount = 0;    // počítadlo po sebe idúcich zlyhaní čítania BME280
uint8_t ahtFailCount = 0;    // počítadlo po sebe idúcich zlyhaní čítania AHT21
uint8_t ensFailCount = 0;    // počítadlo po sebe idúcich zlyhaní čítania ENS160
uint8_t inaFailCount = 0;    // počítadlo po sebe idúcich zlyhaní čítania INA226

// --- OLED: rotácia obrazoviek ---
// 0=domov (teplota+vlhkosť), 1=Adamov (290m + trend), 2=Brno (210m + trend),
// 3=kvalita ovzdušia, 4=batéria (INA226) - tlak sa na domovskej karte už
// nezobrazuje (má vlastné dve karty Adamov/Brno, samostatná karta
// "Trend tlaku" bola zrušená).
const uint8_t OLED_SCREEN_COUNT = 5;
const unsigned long OLED_SCREEN_INTERVAL_MS = 4000UL;
uint8_t oledScreenIndex = 0;
unsigned long oledLastSwitchMs = 0;

// --- OLED: zahrievanie ENS160 (vlastný odpočet vo firmvéri, nezávislý od
// appky - appka svoj odpočet odvodzuje od otvorenia sériového portu, tu ide
// o odpočet od úspešnej inicializácie senzora, pozri initEns()). Rovnaká
// hodnota (180 s) ako ENS160_WARMUP_SECONDS v config.py appky - ak sa tam
// zmení, zosynchronizuj aj tu. ---
const unsigned long ENS160_WARMUP_MS = 180000UL;
unsigned long ensWarmupStartMs = 0;

// --- OLED: hodinová história tlaku pre 6-hodinový trend (rovnaký princíp
// ako PressureMixin.update_forecast() v appke - okno = posledných 6 hodín,
// vzorka raz za hodinu, teda 7 slotov vrátane oboch koncov okna). Appka má
// svoju vlastnú (nezávislú, presnejšiu) históriu z celého dňa prijímaného
// cez sériový port - toto je len zjednodušená kópia PRIAMO vo firmvéri, aby
// OLED vedel ukázať trend aj bez pripojeného PC.
//
// POZOR: história drží SUROVÝ (stanicový) tlak, nie prepočítaný na
// Adamov/Brno - trend (ZMENA tlaku za 6h) je ale na nadmorskej výške
// prakticky nezávislý (rovnaký princíp/zdôvodnenie ako v komentári pri
// update_forecast() v pressure_service.py appky), takže obe karty
// Adamov aj Brno môžu bezpečne zdieľať TENTO ISTÝ trend, len s vlastnou
// (rozdielnou) aktuálnou hodnotou tlaku. ---
const uint8_t PRESSURE_HISTORY_SIZE = 7;
const unsigned long PRESSURE_SAMPLE_INTERVAL_MS = 3600000UL; // 1 hodina
float pressureHistory[PRESSURE_HISTORY_SIZE];
uint8_t pressureHistoryFilled = 0;
unsigned long lastPressureSampleMs = 0;

// --- Prepočet surového (stanicového) tlaku na tlak zodpovedajúci INEJ
// nadmorskej výške - rovnaká medzinárodná barometrická formula ako
// station_to_sea_level() v pressure_service.py appky:
//   P0 = P / (1 - h/BAROMETRIC_SCALE_HEIGHT_M) ** BAROMETRIC_EXPONENT
// Použité na obrazovkách "Adamov"/"Brno" nižšie - berie ROVNAKÉ surové
// čítanie z lokálneho senzora a prepočíta ho, ako keby senzor stál v danej
// nadmorskej výške (rovnaký princíp ako nastavenie "Výška (m)" v Nastaveniach
// appky, len tu naraz pre dve pevné hodnoty namiesto jednej nastaviteľnej). ---
const float BAROMETRIC_EXPONENT = 5.255f;
const float BAROMETRIC_SCALE_HEIGHT_M = 44330.0f;
const float ADAMOV_ALTITUDE_M = 290.0f;
const float BRNO_ALTITUDE_M = 210.0f;
// Bez diakritiky (obe mená sú už aj tak bez nej) - pozri poznámku pri
// OLED_WIDTH vyššie.
const char *ADAMOV_LABEL = "Adamov (290m)";
const char *BRNO_LABEL = "Brno (210m)";

float stationToSeaLevel(float stationPressure, float altitudeM) {
  return stationPressure / pow(1.0f - altitudeM / BAROMETRIC_SCALE_HEIGHT_M, BAROMETRIC_EXPONENT);
}

// --- Prahy pre klasifikáciu eCO2/TVOC (rovnaké hodnoty ako
// ECO2_BOUNDARIES/TVOC_BOUNDARIES v config.py appky - ak sa tam zmenia,
// zosynchronizuj aj tu; firmvér config.py priamo nečíta). Bez hysterézy
// (appka ju má pre plynulé UI, tu pre jednoduchosť stačí čistá
// klasifikácia - drobné blikanie hlásenia na hranici pásma na malom OLED
// displeji nevadí). ---
const uint16_t ECO2_BOUNDARIES[4] = {800, 1000, 1500, 2500};
const uint16_t TVOC_BOUNDARIES[4] = {220, 660, 2200, 5500};
// Bez diakritiky - pozri poznámku pri OLED_WIDTH vyššie.
const char *QUALITY_LABELS[5] = {"Vynikajuca", "Dobra", "Priemerna", "Zla", "Nebezpecna"};
 
// --- Pripojenie na WiFi - NEBLOKUJÚCE voči zvyšku appky: ak sa nepodarí do
// WIFI_CONNECT_TIMEOUT_MS, appka sa jednoducho vzdá a pokračuje ďalej
// (senzory/OLED bežia nezávisle) - ďalší pokus príde až v loop() cez
// ensureWifiConnected(), najskôr po WIFI_RECONNECT_INTERVAL_MS. ---
void connectWifi() {
  Serial.print("Pripajam WiFi (");
  Serial.print(WIFI_SSID);
  Serial.print(")...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < WIFI_CONNECT_TIMEOUT_MS) {
    delay(300);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(" OK, IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(" zlyhalo, skusim znova neskor.");
  }
}

// --- Volať pravidelne z loop() - ak WiFi vypadlo (napr. reštart routera),
// obnoví spojenie bez potreby reštartu ESP32. Throttlované cez
// WIFI_RECONNECT_INTERVAL_MS, aby loop() neblokoval na WiFi.begin() pri
// KAŽDOM cykle, kým je sieť dlhšie nedostupná. ---
void ensureWifiConnected() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }
  unsigned long now = millis();
  if (lastWifiAttemptMs != 0 && (now - lastWifiAttemptMs) < WIFI_RECONNECT_INTERVAL_MS) {
    return;
  }
  lastWifiAttemptMs = now;
  connectWifi();
}

// --- Volať pravidelne z loop() (nezávisle od toho, či sú senzory zapnuté) -
// zistí z webu (Nastavenia), či majú byť displej/senzory zapnuté alebo
// vypnuté (napr. vypnutie cez noc namiesto fyzického odpojenia batérie -
// pozri main.py /api/device-state a database.py get_display_enabled/
// get_sensors_enabled). Throttlované cez DEVICE_STATE_POLL_INTERVAL_MS,
// GET request je krátky/lacný, appka ho zvláda popri bežnom 2s cykle.
//
// Appka zámerne neparsuje plnohodnotný JSON (rovnaký dôvod ako pri
// sendReadingToServer - žiadna ArduinoJson knižnica navyše) - server vždy
// posiela OBE polia v odpovedi, stačí preto vyhľadať podreťazec
// "pole":false; ak sa nenájde, appka predpokladá true (zapnuté).
void pollDeviceState() {
  if (WiFi.status() != WL_CONNECTED) {
    return; // bez WiFi niet ako stav zistiť - necháme posledný známy
  }
  unsigned long now = millis();
  if (lastDeviceStatePollMs != 0 && (now - lastDeviceStatePollMs) < DEVICE_STATE_POLL_INTERVAL_MS) {
    return;
  }
  lastDeviceStatePollMs = now;

  HTTPClient http;
  char url[96];
  snprintf(url, sizeof(url), "http://%s:%u%s", SERVER_HOST, SERVER_PORT, DEVICE_STATE_PATH);
  http.begin(url);
  http.setTimeout(2000);
  int httpCode = http.GET();
  if (httpCode == 200) {
    String body = http.getString();
    displayEnabled = body.indexOf("\"display_enabled\":false") < 0;
    sensorsEnabled = body.indexOf("\"sensors_enabled\":false") < 0;
  }
  // Pri zlyhaní (server nedostupný, timeout a pod.) necháme posledný známy
  // stav bezo zmeny - appka to skúsi znova pri ďalšom polle o pár sekúnd.
  http.end();
}

// --- Odoslanie jednej vzorky na RPi server (POST, application/x-www-form-
// urlencoded - zámerne namiesto JSON, aby appka nepotrebovala navyše
// ArduinoJson knižnicu len kvôli pár číslam). Chýbajúce/nedostupné hodnoty
// (napr. INA226 nezapojený) sa posielajú ako -1 - server (app/main.py,
// funkcia ingest()) ich prevedie späť na None, rovnaký princíp ako predtým
// NaN cez serial_io.py. Volať LEN keď je WiFi.status() == WL_CONNECTED. ---
void sendReadingToServer(float temp, float hum, float pressure,
                          uint16_t eco2, uint16_t tvoc, uint8_t aqi,
                          float batVoltage, float batCurrent_mA, float batPower_mW, bool inaDataOk) {
  HTTPClient http;
  char url[96];
  snprintf(url, sizeof(url), "http://%s:%u%s", SERVER_HOST, SERVER_PORT, SERVER_PATH);
  http.begin(url);
  http.addHeader("Content-Type", "application/x-www-form-urlencoded");
  // Krátky timeout - ak RPi server práve nereaguje (reštart appky a pod.),
  // appka sa nesmie na tomto POST-e zaseknúť dlhšie než na pár sekúnd (OLED
  // a senzory musia bežať ďalej bez ohľadu na dostupnosť servera).
  http.setTimeout(3000);

  char body[220];
  snprintf(
      body, sizeof(body),
      "temp=%.2f&hum=%.2f&pressure=%.2f&eco2=%u&tvoc=%u&aqi=%u&bat_v=%.3f&bat_ma=%.1f&bat_mw=%.1f",
      temp, hum, pressure, eco2, tvoc, aqi,
      inaDataOk ? batVoltage : -1.0f,
      inaDataOk ? batCurrent_mA : -1.0f,
      inaDataOk ? batPower_mW : -1.0f
  );

  int httpCode = http.POST(body);
  if (httpCode <= 0) {
    Serial.print("CHYBA: POST na server zlyhal: ");
    Serial.println(http.errorToString(httpCode));
  } else if (httpCode != 200) {
    Serial.print("CHYBA: server odpovedal HTTP ");
    Serial.println(httpCode);
  }
  http.end();
}

bool initBme() {
  if (bme.begin(0x76)) {
    bmeAddress = 0x76;
    return true;
  }
  if (bme.begin(0x77)) {
    bmeAddress = 0x77;
    return true;
  }
  return false;
}
 
bool initAht() {
  return aht.begin();
}
 
bool initEns() {
  if (ens160.begin() != NO_ERR) {
    return false;
  }
  ens160.setPWRMode(ENS160_STANDARD_MODE);
  // Nová (úspešná) inicializácia = nový začiatok odpočtu zahrievania -
  // platí rovnako pri prvom štarte aj pri reconnecte po výpadku.
  ensWarmupStartMs = millis();
  return true;
}

bool initOled() {
  if (!oled.begin(SSD1306_SWITCHCAPVCC, OLED_I2C_ADDR)) {
    return false;
  }
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.display();
  return true;
}

// --- INA226 (napätie/prúd/výkon batérie GEB 855085 za TP4056) ---
// ZAPOJENIE (over si podľa priloženej schémy zapojenia):
//   USB 5V  -> TP4056 IN+/IN-
//   Batéria GEB 855085 (JST, 3.7V LiPo) -> TP4056 BAT+/BAT-
//   TP4056 BAT+/BAT- (tie isté vývody, na ktorých visí aj batéria) ->
//     INA226 VIN+ (cez vstavaný shunt modulu) -> INA226 VIN- -> napájací
//     vstup ESP32 dosky (over si, či tvoja doska zvláda priamo surové
//     napätie LiPo ~3.0-4.2V na svojom "5V"/"VIN" vstupe - mnohé lacné
//     ESP32-C3 "supermini" dosky majú AMS1117 regulátor s úbytkom ~1.1V,
//     ktorý pri čiastočne vybitej batérii pod cca 4.7V už nedá stabilných
//     3.3V; ak si nie si istý, použi radšej dedikovaný LiPo->3.3V
//     regulátor/boost modul medzi INA226 a doskou).
//   INA226 SDA/SCL -> zdieľaná I2C zbernica (PIN_I2C_SDA/PIN_I2C_SCL,
//     rovnaká ako BME280/AHT21/ENS160/OLED), INA226 VCC -> 3.3V logika
//     ESP32 dosky (LEN napájanie čipu INA226, NIE meraná vetva!), GND
//     všetkých modulov (TP4056, INA226, ESP32, batéria-) spoločná.
bool initIna() {
  if (!ina226.begin()) {
    return false;
  }
  int calResult = ina226.setMaxCurrentShunt(INA226_MAX_CURRENT_A, INA226_SHUNT_OHM);
  // DIAGNOSTIKA: 0 = kalibrácia OK, čokoľvek iné = problém (napr. nesedí
  // INA226_SHUNT_OHM so skutočným shuntom na module) - getCurrent_mA()/
  // getPower_mW() bez úspešnej kalibrácie vždy vrátia 0, aj keď reálne
  // tečie prúd. Tento riadok je len na dočasné ladenie, po overení sa dá
  // pokojne odstrániť/zakomentovať.
  Serial.print("INA226 kalibracia (0=OK): ");
  Serial.println(calResult);
  return true;
}

// --- Pomocná funkcia: zaradí hodnotu do jedného z 5 pásiem podľa 4 hraníc
// (rovnaký princíp ako _classify_band() v appke, bez hysterézy - pozri
// poznámku vyššie). Vráti index 0-4 (0=Vynikajúca, 4=Nebezpečná). ---
uint8_t classifyBand(float value, const uint16_t boundaries[4]) {
  uint8_t band = 0;
  for (uint8_t i = 0; i < 4; i++) {
    if (value >= boundaries[i]) {
      band++;
    } else {
      break;
    }
  }
  return band;
}

// --- Aktualizuje hodinovú históriu tlaku (posuvné okno PRESSURE_HISTORY_SIZE
// vzoriek) - volať raz za hodinu s AKTUÁLNYM surovým (stanicovým) tlakom. ---
void updatePressureHistory(float stationPressure) {
  unsigned long now = millis();
  // millis() pretečie cca po 49 dňoch behu - "now - lastPressureSampleMs"
  // funguje správne aj cez pretečenie vďaka unsigned aritmetike (rovnaký
  // trik ako všade inde vo firmvéri, kde sa porovnáva pomocou odčítania,
  // nie priameho porovnania hodnôt).
  if (lastPressureSampleMs != 0 && (now - lastPressureSampleMs) < PRESSURE_SAMPLE_INTERVAL_MS) {
    return;
  }
  lastPressureSampleMs = now;

  // Posun poľa o jednu pozíciu doľava (zahodí najstaršiu vzorku) a novú
  // hodnotu pridá na koniec - jednoduché pole namiesto kruhového bufferu,
  // pri veľkosti 4 prvkov je to zanedbateľne lacná operácia.
  for (uint8_t i = 0; i < PRESSURE_HISTORY_SIZE - 1; i++) {
    pressureHistory[i] = pressureHistory[i + 1];
  }
  pressureHistory[PRESSURE_HISTORY_SIZE - 1] = stationPressure;
  if (pressureHistoryFilled < PRESSURE_HISTORY_SIZE) {
    pressureHistoryFilled++;
  }
}

// --- Zostaví krátky text trendu tlaku ("+0.3/6h Pekne" a pod.) do
// zadaného bufferu - zdieľané oboma kartami Adamov/Brno (pozri
// drawOledScreenAltitude), aby sa rovnaká logika nekopírovala dvakrát.
// Prahy rovnaké ako PRESSURE_TREND_RAPID_HPA/PRESSURE_TREND_MODERATE_HPA
// v config.py appky (6,0 / 1,6 hPa - teraz vyhodnocované za 6h okno). ---
void getPressureTrendText(char *buffer, size_t bufferSize) {
  if (pressureHistoryFilled < PRESSURE_HISTORY_SIZE) {
    snprintf(buffer, bufferSize, "Zbieram udaje...");
    return;
  }
  float change = pressureHistory[PRESSURE_HISTORY_SIZE - 1] - pressureHistory[0];
  const char *label;
  if (change <= -6.0f) {
    label = "Burka";
  } else if (change <= -1.6f) {
    label = "Dazd";
  } else if (change >= 6.0f) {
    label = "Sucho";
  } else if (change >= 1.6f) {
    label = "Pekne";
  } else {
    label = "Premenlivo";
  }
  snprintf(buffer, bufferSize, "%+.1f/6h %s", change, label);
}

// --- Obrazovka 1: Domov - už len teplota a vlhkosť (tlak sa presunul na
// vlastné karty Adamov/Brno, žiadna trendová pomlčka). Displej má presne
// 32 px výšky, rozdelené na 2 rovnaké riadky po 16 px (veľkosť fontu 2 =
// 16 px vysoký text), každý vycentrovaný - teplota hore, vlhkosť dole. ---
void drawOledScreenHome(float temp, float hum) {
  oled.clearDisplay();
  oled.setTextSize(2);
  int16_t x1, y1;
  uint16_t w, h;

  char tempLine[16];
  if (!isnan(temp)) {
    snprintf(tempLine, sizeof(tempLine), "%.1f C", temp);
  } else {
    snprintf(tempLine, sizeof(tempLine), "--.- C");
  }
  oled.getTextBounds(tempLine, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 0);
  oled.print(tempLine);

  char humLine[16];
  if (!isnan(hum)) {
    snprintf(humLine, sizeof(humLine), "%.1f %% RH", hum);
  } else {
    snprintf(humLine, sizeof(humLine), "--.- %% RH");
  }
  oled.getTextBounds(humLine, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 16);
  oled.print(humLine);

  oled.display();
}

// --- Obrazovky "Adamov (290m)" / "Brno (210m)": rovnaké surové čítanie
// tlaku prepočítané na dve pevné nadmorské výšky (pozri stationToSeaLevel
// vyššie), vrátane trendu (predtým samostatná karta "Trend tlaku", zrušená).
// Rozloženie na presne 32 px výšky:
//   riadok 1 (y=0,  veľkosť 1): názov obce + výška
//   riadok 2 (y=8,  veľkosť 2): prepočítaný tlak
//   riadok 3 (y=24, veľkosť 1): trend za posledných 6h
void drawOledScreenAltitude(float stationPressure, float altitudeM, const char *label) {
  oled.clearDisplay();
  int16_t x1, y1;
  uint16_t w, h;

  oled.setTextSize(1);
  oled.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 0);
  oled.print(label);

  oled.setTextSize(2);
  char valueLine[16];
  if (!isnan(stationPressure)) {
    float converted = stationToSeaLevel(stationPressure, altitudeM);
    snprintf(valueLine, sizeof(valueLine), "%.0fhPa", converted);
  } else {
    snprintf(valueLine, sizeof(valueLine), "--hPa");
  }
  oled.getTextBounds(valueLine, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 8);
  oled.print(valueLine);

  oled.setTextSize(1);
  char trendLine[20];
  getPressureTrendText(trendLine, sizeof(trendLine));
  oled.setCursor(0, 24);
  oled.print(trendLine);

  oled.display();
}

// --- Obrazovka: Kvalita ovzdušia - v strede hore najhorší z 3 stavov
// (CO2/TVOC/AQI), dole tri konkrétne hodnoty. Počas zahrievania ENS160
// namiesto klasifikácie hlási "Zahrievanie" + odpočet, hodnoty (ak už boli
// prečítané zo senzora) sa aj tak zobrazia - presne ako v appke
// (update_live_display) - len sa neklasifikujú. ---
void drawOledScreenAirQuality(uint16_t eco2, uint16_t tvoc, uint8_t aqi, bool ensDataOk) {
  oled.clearDisplay();

  unsigned long warmupElapsed = millis() - ensWarmupStartMs;
  bool warmingUp = ensWarmupStartMs != 0 && warmupElapsed < ENS160_WARMUP_MS;

  int16_t x1, y1;
  uint16_t w, h;

  if (warmingUp) {
    unsigned long remainingSec = (ENS160_WARMUP_MS - warmupElapsed) / 1000UL;
    oled.setTextSize(1);
    const char *headline = "Zahrievanie";
    oled.getTextBounds(headline, 0, 0, &x1, &y1, &w, &h);
    oled.setCursor((OLED_WIDTH - w) / 2, 0);
    oled.print(headline);

    oled.setTextSize(2);
    char countdownLine[8];
    snprintf(countdownLine, sizeof(countdownLine), "%lu:%02lu", remainingSec / 60UL, remainingSec % 60UL);
    oled.getTextBounds(countdownLine, 0, 0, &x1, &y1, &w, &h);
    oled.setCursor((OLED_WIDTH - w) / 2, 14);
    oled.print(countdownLine);
  } else if (ensDataOk) {
    uint8_t co2Band = classifyBand((float)eco2, ECO2_BOUNDARIES);
    uint8_t tvocBand = classifyBand((float)tvoc, TVOC_BOUNDARIES);
    // AQI (1-5) je z ENS160 už hotový diskrétny index - prevedieme priamo
    // na index 0-4 (rovnaký princíp ako v appke, aqi_idx - 1).
    uint8_t aqiBand = (aqi >= 1 && aqi <= 5) ? (aqi - 1) : 0;
    uint8_t worst = co2Band;
    if (tvocBand > worst) worst = tvocBand;
    if (aqiBand > worst) worst = aqiBand;

    oled.setTextSize(2);
    oled.getTextBounds(QUALITY_LABELS[worst], 0, 0, &x1, &y1, &w, &h);
    oled.setCursor((OLED_WIDTH - w) / 2, 0);
    oled.print(QUALITY_LABELS[worst]);

    oled.setTextSize(1);
    oled.setCursor(0, 24);
    char row[24];
    snprintf(row, sizeof(row), "CO2%u TVOC%u AQI%u", eco2, tvoc, aqi);
    oled.print(row);
  } else {
    oled.setTextSize(1);
    const char *msg = "Bez udajov";
    oled.getTextBounds(msg, 0, 0, &x1, &y1, &w, &h);
    oled.setCursor((OLED_WIDTH - w) / 2, 12);
    oled.print(msg);
  }

  oled.display();
}

// --- Percento nabitia batérie z napätia (INA226) ---
// Vybíjacia krivka LiPo článku NIE JE lineárna (rýchly pokles z 4.2V, potom
// dlhá plochá časť okolo 3.7-3.9V, rýchly pokles pod 3.6V) - lineárna
// interpolácia priamo medzi 4.2V a 3.0V by preto bola dosť nepresná (napr.
// 3.8V by lineárne vyšlo len na cca 42%, hoci batéria je v skutočnosti ešte
// zhruba na polovici). Tabuľka nižšie je bežne používaná aproximácia
// vybíjacej krivky NAPRÁZDNO (bez záťaže) pre 1-článkový 3.7V/4.2V LiPo.
//
// POZOR: appka meria napätie POD ZÁŤAŽOU (ESP32+senzory+OLED odoberajú
// prúd), takže výsledné percento môže byť mierne podhodnotené oproti
// skutočnému stavu nabitia (úbytok napätia na vnútornom odpore článku pri
// odbere) - ide o orientačný odhad, nie o presné meranie kapacity (na to
// by bol potrebný dedikovaný "fuel gauge" čip s coulomb counting, napr.
// MAX17048 - INA226 samotný históriu prúdu/kapacity nesčítava).
const float BATTERY_CURVE_VOLTAGE[] = {
  4.20f, 4.15f, 4.11f, 4.08f, 4.02f, 3.98f, 3.95f, 3.91f, 3.87f, 3.85f,
  3.84f, 3.82f, 3.80f, 3.79f, 3.77f, 3.75f, 3.73f, 3.71f, 3.69f, 3.61f, 3.27f
};
const float BATTERY_CURVE_PERCENT[] = {
  100, 95, 90, 85, 80, 75, 70, 65, 60, 55,
  50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0
};
const uint8_t BATTERY_CURVE_SIZE = sizeof(BATTERY_CURVE_VOLTAGE) / sizeof(BATTERY_CURVE_VOLTAGE[0]);

float batteryPercentFromVoltage(float voltage) {
  if (isnan(voltage)) {
    return NAN;
  }
  if (voltage >= BATTERY_CURVE_VOLTAGE[0]) {
    return 100.0f;
  }
  if (voltage <= BATTERY_CURVE_VOLTAGE[BATTERY_CURVE_SIZE - 1]) {
    return 0.0f;
  }
  // Lineárna interpolácia MEDZI dvoma najbližšími bodmi tabuľky - krivka
  // ako celok je nelineárna, ale medzi dvoma susednými (blízkymi) bodmi je
  // lineárna aproximácia dostatočne presná.
  for (uint8_t i = 0; i < BATTERY_CURVE_SIZE - 1; i++) {
    float vHigh = BATTERY_CURVE_VOLTAGE[i];
    float vLow = BATTERY_CURVE_VOLTAGE[i + 1];
    if (voltage <= vHigh && voltage >= vLow) {
      float pHigh = BATTERY_CURVE_PERCENT[i];
      float pLow = BATTERY_CURVE_PERCENT[i + 1];
      float ratio = (voltage - vLow) / (vHigh - vLow);
      return pLow + ratio * (pHigh - pLow);
    }
  }
  return 0.0f; // nedosiahnuteľné (pokryté hraničnými prípadmi vyššie), poistka
}

// --- Obrazovka: Batéria (INA226) - percento nabitia veľkým fontom, prúd
// a výkon pod ním (na jednom riadku, na 128px šírku sa obe zmestia).
// Rozloženie na presne 32 px výšky, rovnaký princíp ako ostatné obrazovky:
//   riadok 1 (y=0,  veľkosť 1): nadpis "Bateria"
//   riadok 2 (y=8,  veľkosť 2): percento nabitia (dopočítané z napätia,
//     pozri batteryPercentFromVoltage - orientačný odhad, nie presné %)
//   riadok 3 (y=24, veľkosť 1): prúd (mA) + výkon (W), znamienko podľa
//     smeru zapojenia shuntu INA226 - kladné/záporné treba overiť na
//     svojom zapojení (napr. kladné = batéria sa vybíja do záťaže).
void drawOledScreenBattery(float voltage, float current_mA, float power_mW, bool inaDataOk) {
  oled.clearDisplay();
  int16_t x1, y1;
  uint16_t w, h;

  oled.setTextSize(1);
  const char *headline = "Bateria";
  oled.getTextBounds(headline, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 0);
  oled.print(headline);

  if (!inaDataOk) {
    oled.setTextSize(1);
    const char *msg = "Bez udajov";
    oled.getTextBounds(msg, 0, 0, &x1, &y1, &w, &h);
    oled.setCursor((OLED_WIDTH - w) / 2, 14);
    oled.print(msg);
    oled.display();
    return;
  }

  float percent = batteryPercentFromVoltage(voltage);

  oled.setTextSize(2);
  char percentLine[16];
  snprintf(percentLine, sizeof(percentLine), "%.0f%%", percent);
  oled.getTextBounds(percentLine, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 8);
  oled.print(percentLine);

  oled.setTextSize(1);
  char currPowerLine[24];
  // Výkon zámerne vo Watoch (nie mW) - kratší text, lepšie sa zmestí popri
  // prúde na jeden riadok pri malom OLED displeji.
  snprintf(currPowerLine, sizeof(currPowerLine), "%+.0fmA %.2fW", current_mA, power_mW / 1000.0f);
  oled.getTextBounds(currPowerLine, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 24);
  oled.print(currPowerLine);

  oled.display();
}

// --- Obrazovka: senzory sú vypnuté cez web (Nastavenia) - zobrazí sa
// namiesto bežnej rotácie obrazoviek, kým je sensorsEnabled == false a
// displej pritom zapnutý (displayEnabled == true). ---
void drawOledScreenSensorsOff() {
  oled.clearDisplay();
  int16_t x1, y1;
  uint16_t w, h;

  oled.setTextSize(1);
  const char *line1 = "Senzory vypnute";
  oled.getTextBounds(line1, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 8);
  oled.print(line1);

  const char *line2 = "(web - Nastavenia)";
  oled.getTextBounds(line2, 0, 0, &x1, &y1, &w, &h);
  oled.setCursor((OLED_WIDTH - w) / 2, 20);
  oled.print(line2);

  oled.display();
}

// --- Riadi rotáciu obrazoviek a volá príslušnú kresliacu funkciu. Volaná
// z loop() pri KAŽDOM cykle (nie len raz za OLED_SCREEN_INTERVAL_MS) -
// vnútri sa sama rozhodne, či je čas na prekreslenie (prepnutie obrazovky)
// alebo nie, aby aktuálne hodnoty (napr. odpočet zahrievania) priebežne
// ubiehali aj v rámci jednej zobrazenej obrazovky. `pressure` je SUROVÉ
// (stanicové) čítanie zo senzora - obrazovky "Adamov"/"Brno" si z neho samy
// dopočítajú prepočet na danú nadmorskú výšku (pozri stationToSeaLevel);
// domovská obrazovka tlak vôbec nepoužíva. ---
void updateOledDisplay(float temp, float hum, float pressure,
                        uint16_t eco2, uint16_t tvoc, uint8_t aqi, bool ensDataOk,
                        float batVoltage, float batCurrent_mA, float batPower_mW, bool inaDataOk) {
  if (!oledOk) {
    return;
  }

  // --- Vzdialené vypnutie displeja (web - Nastavenia) - OLED sa len
  // zhasne (clearDisplay+display), čo pri OLED technológii znamená takmer
  // nulový odber (na rozdiel od LCD s podsvietením OLED odoberá prúd len
  // na rozsvietené pixely). Príkaz sa posiela len RAZ pri zmene stavu, nie
  // pri každom volaní tejto funkcie. ---
  if (!displayEnabled) {
    if (!oledBlanked) {
      oled.clearDisplay();
      oled.display();
      oledBlanked = true;
    }
    return;
  }
  if (oledBlanked) {
    // displej sa práve znova zapol - vynúť okamžité prekreslenie namiesto
    // čakania na najbližšie OLED_SCREEN_INTERVAL_MS.
    oledLastSwitchMs = 0;
    oledBlanked = false;
  }

  unsigned long now = millis();
  if (oledLastSwitchMs == 0 || (now - oledLastSwitchMs) >= OLED_SCREEN_INTERVAL_MS) {
    oledScreenIndex = (oledScreenIndex + 1) % OLED_SCREEN_COUNT;
    oledLastSwitchMs = now;
  }

  switch (oledScreenIndex) {
    case 0:
      drawOledScreenHome(temp, hum);
      break;
    case 1:
      drawOledScreenAltitude(pressure, ADAMOV_ALTITUDE_M, ADAMOV_LABEL);
      break;
    case 2:
      drawOledScreenAltitude(pressure, BRNO_ALTITUDE_M, BRNO_LABEL);
      break;
    case 3:
      drawOledScreenAirQuality(eco2, tvoc, aqi, ensDataOk);
      break;
    case 4:
      drawOledScreenBattery(batVoltage, batCurrent_mA, batPower_mW, inaDataOk);
      break;
  }
}
 
void setup() {
  Serial.begin(115200);
  delay(1000);
 
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);

  for (uint8_t i = 0; i < PRESSURE_HISTORY_SIZE; i++) {
    pressureHistory[i] = NAN;
  }
 
  bmeOk = initBme();
  Serial.println(bmeOk ? "BME280 najdeny." : "BME280 sa nenasiel. Skusam znova v loop().");
 
  ahtOk = initAht();
  Serial.println(ahtOk ? "AHT21 najdeny." : "AHT21 sa nenasiel. Skusam znova v loop().");
 
  ensOk = initEns();
  Serial.println(ensOk ? "ENS160 najdeny." : "ENS160 sa nenasiel. Skusam znova v loop().");
  if (ensOk) {
    Serial.println("POZOR: ENS160 potrebuje cca 3 min na zahriatie po startupe (a az 1 hodinu pri uplne prvom spusteni). Hodnoty eCO2/TVOC budu spociatku nepresne.");
  }

  oledOk = initOled();
  Serial.println(oledOk ? "OLED najdeny." : "OLED sa nenasiel - pokracujem bez neho.");

  inaOk = initIna();
  Serial.println(inaOk ? "INA226 najdeny." : "INA226 sa nenasiel - pokracujem bez merania baterie.");

  connectWifi();
 
  Serial.println("Format: TEPLOTA,VLHKOST,TLAK_hPa,ECO2,TVOC,AQI");
  Serial.println("Format (ak je INA226 pripojeny, samostatny riadok): BAT,napatie_V,prud_mA,vykon_mW");
  Serial.println("POZOR: uvedene formaty su uz len pre lokalny Serial Monitor (ladenie) -");
  Serial.println("appke na RPi5 sa data odosielaju cez WiFi (POST /api/ingest), pozri sendReadingToServer().");
}
 
void loop() {
  // WiFi a vzdialený stav (displej/senzory) sa kontrolujú VŽDY ako prvé,
  // nezávisle od toho, či sú senzory práve zapnuté/vypnuté - inak by appka
  // po vypnutí senzorov už nikdy nezistila, že ich má znova zapnúť.
  ensureWifiConnected();
  pollDeviceState();

  if (!sensorsEnabled) {
    // Senzory vypnuté z webu (Nastavenia) - žiadne čítanie/reconnecty
    // senzorov, žiadne odosielanie na server. OLED (ak je zapnutý) ukáže
    // len informačnú obrazovku namiesto bežnej rotácie; ak je vypnutý aj
    // displej, len sa raz zhasne (rovnaký princíp ako v updateOledDisplay()).
    if (!displayEnabled) {
      if (oledOk && !oledBlanked) {
        oled.clearDisplay();
        oled.display();
        oledBlanked = true;
      }
    } else if (oledOk) {
      oledBlanked = false;
      drawOledScreenSensorsOff();
    }
    delay(2000);
    return;
  }

  // Ak niektory senzor nie je inicializovany, skus reconnect a medzitym nic neposielaj
  if (!bmeOk || !ahtOk || !ensOk) {
    if (!bmeOk) {
      Serial.println("CHYBA: BME280 nedostupny, pokus o reconnect...");
      bmeOk = initBme();
      if (bmeOk) {
        bmeFailCount = 0;
        Serial.println("BME280 znova pripojeny.");
      }
    }
    if (!ahtOk) {
      Serial.println("CHYBA: AHT21 nedostupny, pokus o reconnect...");
      ahtOk = initAht();
      if (ahtOk) {
        ahtFailCount = 0;
        Serial.println("AHT21 znova pripojeny.");
      }
    }
    if (!ensOk) {
      Serial.println("CHYBA: ENS160 nedostupny, pokus o reconnect...");
      ensOk = initEns();
      if (ensOk) {
        ensFailCount = 0;
        Serial.println("ENS160 znova pripojeny.");
      }
    }
    delay(2000);
    return;
  }

  // --- INA226 je NEKRITICKÝ doplnok (rovnako ako OLED) - jeho prípadné
  // zlyhanie/nepripojenie nesmie zablokovať hlavný CSV riadok so
  // senzormi vyššie, preto sa reconnect rieši MIMO bloku vyššie (ktorý by
  // inak pri chýbajúcom INA226 navždy "return"-oval bez posielania dát). ---
  if (!inaOk) {
    inaOk = initIna();
  }
 
  // --- Citanie BME280 (teplota, vlhkost, tlak) ---
  float temp = bme.readTemperature();
  float hum = bme.readHumidity();
  float pressure = bme.readPressure() / 100.0;
  bool bmeReadFailed = isnan(temp) || isnan(hum) || isnan(pressure);
 
  // --- Citanie AHT21 (pouzije sa aj ako kompenzacia pre ENS160) ---
  sensors_event_t ahtHumEvent, ahtTempEvent;
  aht.getEvent(&ahtHumEvent, &ahtTempEvent);
  float ahtTemp = ahtTempEvent.temperature;
  float ahtHum = ahtHumEvent.relative_humidity;
  bool ahtReadFailed = isnan(ahtTemp) || isnan(ahtHum);
 
  // --- Citanie ENS160 (eCO2, TVOC, AQI) ---
  bool ensReadFailed = true;
  uint16_t eco2 = 0;
  uint16_t tvoc = 0;
  uint8_t aqi = 0;
 
  if (!ahtReadFailed) {
    // Presnejsia kompenzacia teploty/vlhkosti pre vypocet plynovych hodnot
    ens160.setTempAndHum(ahtTemp, ahtHum);
  }
 
  uint8_t ensStatus = ens160.getENS160Status();
  // Status: 0-normalna prevadzka, 1-warm-up (~3 min), 2-initial startup (~1 hod), 3-neplatny vystup
  if (ensStatus != 3) {
    eco2 = ens160.getECO2();
    tvoc = ens160.getTVOC();
    aqi = ens160.getAQI();
    ensReadFailed = false;
  }

  // --- Citanie INA226 (napatie/prud/vykon batérie, ak je pripojený) ---
  // POZOR: knižnica INA226 nemá per-čítanie chybový návratový kód -
  // dostupnosť čipu na zbernici sa preto overuje cez isConnected() a pri
  // opakovanom zlyhaní sa (rovnako ako pri ostatných senzoroch) skúsi
  // reinicializácia.
  bool inaReadFailed = true;
  float batVoltage = NAN;
  float batCurrent_mA = NAN;
  float batPower_mW = NAN;
  if (inaOk) {
    if (ina226.isConnected()) {
      batVoltage = ina226.getBusVoltage();
      batCurrent_mA = ina226.getCurrent_mA();
      batPower_mW = ina226.getPower_mW();
      inaReadFailed = false;
    }
  }
 
  // --- Vyhodnotenie chyb a pripadny reconnect po viacerych zlyhaniach ---
  if (bmeReadFailed) {
    bmeFailCount++;
    Serial.print("CHYBA: neplatne citanie z BME280 (");
    Serial.print(bmeFailCount);
    Serial.println("x po sebe)");
    if (bmeFailCount >= MAX_FAILS_BEFORE_RECONNECT) {
      bmeOk = initBme();
      bmeFailCount = 0;
      Serial.println(bmeOk ? "BME280 znova pripojeny." : "Reconnect BME280 zlyhal, skusim znova neskor.");
    }
  } else {
    bmeFailCount = 0;
  }
 
  if (ahtReadFailed) {
    ahtFailCount++;
    Serial.print("CHYBA: neplatne citanie z AHT21 (");
    Serial.print(ahtFailCount);
    Serial.println("x po sebe)");
    if (ahtFailCount >= MAX_FAILS_BEFORE_RECONNECT) {
      ahtOk = initAht();
      ahtFailCount = 0;
      Serial.println(ahtOk ? "AHT21 znova pripojeny." : "Reconnect AHT21 zlyhal, skusim znova neskor.");
    }
  } else {
    ahtFailCount = 0;
  }
 
  if (ensReadFailed) {
    ensFailCount++;
    Serial.print("CHYBA: neplatne citanie z ENS160 (");
    Serial.print(ensFailCount);
    Serial.println("x po sebe)");
    if (ensFailCount >= MAX_FAILS_BEFORE_RECONNECT) {
      ensOk = initEns();
      ensFailCount = 0;
      Serial.println(ensOk ? "ENS160 znova pripojeny." : "Reconnect ENS160 zlyhal, skusim znova neskor.");
    }
  } else {
    ensFailCount = 0;
  }

  // INA226 je nekritický - chyba sa zaloguje, ale bez zbytočného spamu pri
  // úplne nezapojenom module (inaOk by bolo false, reconnect sa skúša
  // tichým initIna() volaním úplne hore v loop()).
  if (inaOk && inaReadFailed) {
    inaFailCount++;
    if (inaFailCount >= MAX_FAILS_BEFORE_RECONNECT) {
      Serial.println("CHYBA: INA226 prestal odpovedat, pokus o reconnect...");
      inaOk = initIna();
      inaFailCount = 0;
    }
  } else {
    inaFailCount = 0;
  }

  // --- OLED sa aktualizuje VŽDY (aj keď niektorý senzor v tomto cykle
  // zlyhal) - na rozdiel od sériového výstupu nižšie, ktorý sa pri zlyhaní
  // zámerne vynecháva celý. Displej má vlastnú logiku "--" pre chýbajúcu
  // hodnotu (pozri drawOledScreenHome a pod.), takže krátkodobý výpadok
  // jedného senzora nezhasne celý displej, len tú jednu hodnotu. ---
  float tempForOled = bmeReadFailed ? NAN : temp;
  float humForOled = bmeReadFailed ? NAN : hum;
  float pressureForOled = bmeReadFailed ? NAN : pressure;
  if (!bmeReadFailed) {
    updatePressureHistory(pressure);
  }
  updateOledDisplay(tempForOled, humForOled, pressureForOled, eco2, tvoc, aqi, !ensReadFailed,
                     batVoltage, batCurrent_mA, batPower_mW, !inaReadFailed);
 
  // Ak zlyhal hociktory senzor v tomto cykle, neposielaj neuplny/nevalidny CSV riadok
  if (bmeReadFailed || ahtReadFailed || ensReadFailed) {
    delay(2000);
    return;
  }
 
  // --- Uspesne citanie zo vsetkych senzorov - lokalny CSV vypis do Serial
  // Monitora (LEN pre ladenie cez USB, appka na RPi5 na tento port uz nie
  // je naviazana) ---
  Serial.print(temp, 1);
  Serial.print(",");
  Serial.print(hum, 1);
  Serial.print(",");
  Serial.print(pressure, 1);
  Serial.print(",");
  Serial.print(eco2);
  Serial.print(",");
  Serial.print(tvoc);
  Serial.print(",");
  Serial.println(aqi);

  if (!inaReadFailed) {
    Serial.print("BAT,");
    Serial.print(batVoltage, 3);
    Serial.print(",");
    Serial.print(batCurrent_mA, 1);
    Serial.print(",");
    Serial.println(batPower_mW, 1);
  }

  // --- Odoslanie tej istej vzorky na RPi server cez WiFi (pozri
  // sendReadingToServer() vyššie) - appka na RPi5 z tohto POST-u prijme
  // uplne rovnake data, ake predtym chodili cez USB Serial. Ak WiFi prave
  // nie je pripojene, vzorka sa jednoducho vynecha (ensureWifiConnected()
  // sa o reconnect postara na pozadi, ziadne buferovanie/odosielanie
  // spatne zamiesnutych vzoriek zatial appka nerobi). ---
  if (WiFi.status() == WL_CONNECTED) {
    sendReadingToServer(temp, hum, pressure, eco2, tvoc, aqi,
                         batVoltage, batCurrent_mA, batPower_mW, !inaReadFailed);
  } else {
    Serial.println("WiFi nepripojene - vzorka sa neodoslala na server.");
  }
 
  delay(2000);
}
