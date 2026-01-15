# Claude Code Project Context - Intercom API

## CRITICAL SETUP INFO - DO NOT FORGET

- **HA External URL**: `https://514d1f563e4e1ad4.sn.mynetname.net`
- **HA Token**: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJlMTc5YzQ2ZmVkOGM0ZjU1OTQyOWRkNDg1OTI4ZDk2MiIsImlhdCI6MTc2ODQ5MTE3NywiZXhwIjoyMDgzODUxMTc3fQ.W6iHGkX1rLKNkmVjZgeTukWRUuBSqIupU2L1VYEOgWY`
- **Test Card**: `/lovelace/test`
- **Home Assistant**: `root@192.168.1.10` (LXC container, HA installed via pip)
- **ESPHome**: venv in `/home/daniele/cc/claude/intercom-api/` on THIS PC
- **ESP32 IP**: 192.168.1.18
- **HA Config Path**: `/home/homeassistant/.homeassistant/`
- **Deploy HA files**: `scp -r homeassistant/custom_components/intercom_native root@192.168.1.10:/home/homeassistant/.homeassistant/custom_components/`
- **Deploy frontend**: `scp frontend/www/*.js root@192.168.1.10:/home/homeassistant/.homeassistant/www/`
- **Restart HA**: `ssh root@192.168.1.10 'systemctl restart homeassistant'`
- **HA Logs**: `ssh root@192.168.1.10 'journalctl -u homeassistant -f'`
- **Compile & Upload ESP**: `source venv/bin/activate && esphome compile intercom-mini.yaml && esphome upload intercom-mini.yaml --device 192.168.1.18`

## Overview

Sistema intercom bidirezionale full-duplex che usa TCP invece di UDP/WebRTC.
Sostituisce `esphome-intercom` (legacy UDP) con un approccio più robusto.

## Repository

- **Questo repo**: `/home/daniele/cc/claude/intercom-api/`
- **Legacy (non sviluppare)**: `/home/daniele/cc/claude/esphome-intercom/`

---

## STATO ATTUALE (Milestone 2026-01-15)

### Funziona
- Full duplex Browser ↔ HA ↔ ESP stabile (testato 60+ secondi)
- Audio ESP→Browser arriva (2000+ pacchetti)
- Audio Browser→ESP arriva (stabilizzato dopo fix TCP drain)
- Nessun crash/disconnect a 5 secondi (bug PING risolto)
- Stop pulito senza spam "Audio TX failed"

### Problemi da risolvere
1. **Audio glitchy** - suona tipo "cc-ii-aa-oo" con pezzi mancanti (stuttering)
2. **Latenza** - migliorata con scheduled playback, da testare
3. **Task RTOS non ottimizzati** - attualmente un solo task fa sia TX che RX

### Fix applicati
1. `send_mutex_` - Thread safety per tx_buffer_ (race condition PING vs AUDIO)
2. No PING durante streaming - Evita interferenze
3. Partial send handling - Gestisce TCP congestion
4. Protocol desync fix HA - Chiude connessione invece di corrompere stream
5. MAX_MESSAGE_SIZE aumentato - Browser manda chunk 2048 bytes
6. **Scheduled WebAudio playback** (v4.3.0) - Sostituisce queue-based, fix latenza browser
7. **Graceful stop** - Check `active_` prima di send, delay prima di close socket
8. **TCP drain optimization** (v4.2.0) - Drain ogni 10 pacchetti invece di ogni pacchetto

---

## Architettura

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Browser   │◄──WS───►│     HA      │◄──TCP──►│    ESP32    │
│             │         │             │  6054   │             │
└─────────────┘         └─────────────┘         └─────────────┘
     │                        │                       │
  AudioWorklet            tcp_client.py          FreeRTOS Tasks
  16kHz mono              async TCP              server_task (Core 1)
  2048B chunks            512B chunks            audio_task (Core 0)
```

## Componenti

### 1. ESPHome: `intercom_api`
- **Porta**: TCP 6054 (audio streaming)
- **Controllo**: via ESPHome API normale (6053) - switch, number entities
- **Modalità**: Server (attende connessioni) + Client (per ESP→ESP)
- **Task RTOS**:
  - `server_task_` (Core 1, priority 5) - TCP accept, receive, control messages
  - `audio_task_` (Core 0, priority 6) - mic→network TX, speaker buffer→speaker RX

### 2. HA Integration: `intercom_native`
- **WebSocket API**: `intercom_native/start`, `intercom_native/stop`, `intercom_native/audio`
- **TCP client**: Async verso ESP porta 6054
- **Versione**: 4.2.0 (tcp_client.py)

### 3. Frontend: `intercom-card.js`
- **Lovelace card** custom
- **getUserMedia** + AudioWorklet (16kHz)
- **WebSocket** JSON + base64 audio verso HA
- **Versione**: 4.3.0 (scheduled playback)

---

## Protocollo TCP (Porta 6054)

### Header (4 bytes)

```
┌──────────────┬──────────────┬──────────────────────┐
│ Type (1 byte)│ Flags (1 byte)│ Length (2 bytes LE) │
└──────────────┴──────────────┴──────────────────────┘
```

### Message Types

| Type | Name | Direction | Payload |
|------|------|-----------|---------|
| 0x01 | AUDIO | Both | PCM 16-bit mono 16kHz |
| 0x02 | START | Client→Server | - |
| 0x03 | STOP | Both | - |
| 0x04 | PING | Both | - |
| 0x05 | PONG | Both | - |
| 0x06 | ERROR | Server→Client | Error code (1 byte) |

### Audio Format

| Parameter | Value |
|-----------|-------|
| Sample Rate | 16000 Hz |
| Bit Depth | 16-bit signed PCM |
| Channels | Mono |
| ESP Chunk Size | 512 bytes (256 samples = 16ms) |
| Browser Chunk Size | 2048 bytes (1024 samples = 64ms) |

---

## Struttura File

```
intercom-api/
├── esphome/
│   └── components/
│       └── intercom_api/
│           ├── __init__.py           # ESPHome component config
│           ├── intercom_api.h        # Header + class definition
│           ├── intercom_api.cpp      # TCP server + audio handling
│           ├── intercom_protocol.h   # Protocol constants
│           ├── switch.py             # Switch entity
│           └── number.py             # Volume entity
│
├── homeassistant/
│   └── custom_components/
│       └── intercom_native/
│           ├── __init__.py           # Integration setup
│           ├── manifest.json         # HA manifest
│           ├── config_flow.py        # Config UI
│           ├── websocket_api.py      # WS commands + session manager
│           ├── tcp_client.py         # Async TCP client (v4.2.0)
│           └── const.py              # Constants
│
├── frontend/
│   └── www/
│       ├── intercom-card.js          # Lovelace card
│       └── intercom-processor.js     # AudioWorklet
│
├── intercom-mini.yaml                # ESP32-S3 config
├── CLAUDE.md                         # This file
└── README.md                         # User documentation
```

---

## Development

```bash
# Compile e upload ESP
source venv/bin/activate
esphome compile intercom-mini.yaml
esphome upload intercom-mini.yaml --device 192.168.1.18

# Deploy HA integration
scp -r homeassistant/custom_components/intercom_native root@192.168.1.10:/home/homeassistant/.homeassistant/custom_components/
ssh root@192.168.1.10 'systemctl restart homeassistant'

# Monitor logs
ssh root@192.168.1.10 'journalctl -u homeassistant -f'
```

---

## TODO - Prossimi step

### Priorità Alta (Latenza)
- [ ] Separare task RTOS: `tx_task` (Core 0) + `rx_task` (Core 1)
- [ ] Ridurre buffer sizes per minimizzare latenza
- [ ] Analizzare dove si accumula il delay (8-9s inaccettabile, target <500ms)

### Priorità Media (Audio Quality)
- [ ] Fix audio glitchy (stuttering) - probabilmente buffer underrun
- [ ] Verificare sample rate mismatch browser (48kHz) vs ESP (16kHz)
- [ ] Ottimizzare chunk sizes

### Priorità Bassa
- [ ] ESP→ESP direct mode
- [ ] Echo cancellation (AEC)

---

## Note Tecniche

### Perché TCP invece di UDP?

| UDP (legacy) | TCP (nuovo) |
|--------------|-------------|
| Problemi NAT/firewall | Passa attraverso HA |
| Packet loss | Reliable delivery |
| Richiede port forwarding | Nessuna config rete |
| go2rtc/WebRTC complesso | Protocollo semplice |

### Voice Assistant Reference

ESPHome Voice Assistant usa architettura simile con:
- Ring buffers FreeRTOS per decoupling
- Task separati per mic e speaker
- Counting semaphores per reference counting
- Event groups per comunicazione task→main loop

### Latenza Target

- Chunk size: 512 bytes = 16ms di audio
- Round-trip target: < 500ms (attualmente 8-9s!)
- Buffer playback: 2-3 chunks = 32-48ms
