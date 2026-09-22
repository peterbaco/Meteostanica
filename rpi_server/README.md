# Meteostanica - server pre Raspberry Pi 5

Nahrádza pôvodnú Windows desktop appku. ESP32 (`firmware/teplomer_I2C.ino`)
posiela dáta cez WiFi na tento server, ktorý ich ukladá do SQLite a
zobrazuje vo webovom dashboarde (živé aktualizácie cez WebSocket).

## 1. Inštalácia na RPi5 (Raspberry Pi OS, 64-bit)

```bash
# skopíruj celý priečinok rpi_server na RPi5, napr. do /home/pi/rpi_server
cd /home/pi/rpi_server

python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 2. Skúšobné spustenie (ručne, v termináli)

```bash
source venv/bin/activate
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

Dashboard potom otvoríš v prehliadači na `http://<IP_ADRESA_RPi>:8000`
(IP adresu RPi zistíš príkazom `hostname -I`).

## 3. Zistenie IP adresy RPi5 (potrebné pre firmvér ESP32)

```bash
hostname -I
```

Odporúčam nastaviť RPi5 na **statickú IP** (DHCP rezervácia na routeri
podľa MAC adresy RPi) - inak sa IP môže časom zmeniť a ESP32 prestane vedieť,
kam posielať dáta. Túto IP potom zadaj do `firmware/teplomer_I2C.ino`
(`SERVER_HOST`).

## 4. Automatický štart pri zapnutí RPi5 (systemd)

```bash
sudo cp meteostanica.service /etc/systemd/system/
sudo nano /etc/systemd/system/meteostanica.service   # uprav cesty a používateľa, ak treba
sudo systemctl daemon-reload
sudo systemctl enable meteostanica.service
sudo systemctl start meteostanica.service

# kontrola behu / logy:
sudo systemctl status meteostanica.service
journalctl -u meteostanica.service -f
```

## 5. Firmvér ESP32 (`firmware/teplomer_I2C.ino`)

Pred nahraním do Arduino IDE uprav na začiatku súboru:

```cpp
const char *WIFI_SSID = "TVOJA_WIFI_SIET";
const char *WIFI_PASSWORD = "TVOJE_WIFI_HESLO";
const char *SERVER_HOST = "192.168.0.XXX";   // IP adresa RPi5 (pozri krok 3)
```

Zvyšok firmvéru (senzory, OLED, INA226) je bezo zmeny - len namiesto
posielania CSV cez USB appka teraz posiela tie isté dáta cez WiFi (HTTP POST
na `/api/ingest`). Sériový výstup (USB) ostáva zachovaný len pre lokálne
ladenie cez Arduino Serial Monitor.

## 6. Dáta a nastavenia

- Databáza sa vytvorí automaticky v `data/meteostanica.db` pri prvom
  spustení.
- Nadmorská výška a referenčný tlak sa nastavujú cez `POST /api/settings`
  (zatiaľ bez UI v dashboarde - dá sa doplniť neskôr, alebo zavolať priamo
  cez `curl`, napr.:
  `curl -X POST http://localhost:8000/api/settings -d "altitude_m=250"`).

## 7. Čo (zámerne) EŠTE CHÝBA - ďalšie kroky

Toto je funkčný základ (živé dáta, história, graf, alarmy TVOC, denné
priemery) - nasledovné časti pôvodnej appky sem ešte neboli prenesené a
budeme ich dopĺňať postupne:

- **Exteriérový senzor** (CozyLife / plánovaný 433MHz Nexus-TH decoder) -
  zatiaľ nie je v tomto serveri zapojený vôbec.
- **7,5" e-ink displej** - keď dorazí, doplníme modul `eink_display.py`
  (SPI, Waveshare driver) - vypisoval by podobný súhrn ako OLED na ESP32,
  len s väčším rozlíšením priamo z dát na RPi (netreba čakať na
  senzor cez WiFi, dáta už sú v SQLite).
- **Nastavenia vo webe** (výška/referenčný tlak cez formulár, nie len cez
  API) - endpointy už existujú (`/api/settings`), chýba k nim UI.
- **Historický klik na deň** (ako v pôvodnej appke - kliknutie na deň v
  "Posledných 7 dní" zobrazí jeho podrobný graf) - momentálne dashboard
  ukazuje len priemery, nie detail dňa.
- **Zabezpečenie** - server aktuálne beží úplne otvorene na lokálnej sieti
  bez hesla. Ak plánuješ prístup aj mimo domácej siete (odkiaľkoľvek "online"),
  NEODPORÚČAM presmerovať port 8000 priamo na internet - namiesto toho buď
  Tailscale/WireGuard VPN do domácej siete, alebo reverzný proxy (nginx/
  Caddy) s HTTPS a heslom. Môžeme to doriešiť v ďalšom kroku.
