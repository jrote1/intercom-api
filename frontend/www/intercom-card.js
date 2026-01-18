/**
 * Intercom Card v2.0.0 - Lovelace custom card for intercom_native integration
 *
 * P2P Mode: Browser <-> Home Assistant <-> ESP
 * - Card editor: select which intercom device this card represents
 * - Runtime: Call/Hangup button for bidirectional audio
 *
 * PTMP Mode: ESP <-> Home Assistant <-> ESP (Point-to-MultiPoint)
 * - Card editor: select device + mode
 * - Runtime: Destination selector + Call/Hangup button
 * - Audio bridged through HA between two ESP devices
 */

const INTERCOM_CARD_VERSION = "2.0.0";

class IntercomCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._active = false;
    this._ringing = false;  // ESP is ringing, waiting for local answer
    this._stopping = false;
    this._starting = false;
    this._audioContext = null;
    this._mediaStream = null;
    this._workletNode = null;
    this._source = null;
    this._playbackContext = null;
    this._gainNode = null;
    this._nextPlayTime = 0;
    this._chunksDropped = 0;
    this._unsubscribeAudio = null;
    this._unsubscribeState = null;
    this._chunksSent = 0;
    this._chunksReceived = 0;
    this._activeDeviceInfo = null;  // Device info during active call
    // PTMP mode
    this._availableDevices = [];    // List of all intercom devices for destination select
    this._selectedDestination = null;  // Selected destination device in PTMP mode
  }

  setConfig(config) {
    if (!config.entity_id && !config.device_id) {
      // Allow unconfigured card in editor
      this.config = config;
      this._render();
      return;
    }
    this.config = config;
    this._render();
  }

  _getConfigDeviceId() {
    return this.config?.entity_id || this.config?.device_id;
  }

  _isPtmpMode() {
    return this.config?.mode === "ptmp";
  }

  set hass(hass) {
    this._hass = hass;
    // Load available devices for PTMP destination selector
    if (hass && this._isPtmpMode() && this._availableDevices.length === 0) {
      this._loadAvailableDevices();
    }
  }

  async _loadAvailableDevices() {
    if (!this._hass) return;
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/list_devices",
      });
      if (result && result.devices) {
        // Exclude the current device from destinations
        const currentDeviceId = this._getConfigDeviceId();
        this._availableDevices = result.devices.filter(d => d.device_id !== currentDeviceId);
        this._render();
      }
    } catch (err) {
      console.error("Failed to load available devices:", err);
    }
  }

  _render() {
    const name = this.config?.name || "Intercom";
    const deviceId = this._getConfigDeviceId();

    if (!deviceId) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }
          .card {
            background: var(--ha-card-background, var(--card-background-color, white));
            border-radius: var(--ha-card-border-radius, 12px);
            box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
            padding: 16px;
          }
          .header { font-size: 1.2em; font-weight: 500; margin-bottom: 16px; color: var(--primary-text-color); }
          .unconfigured {
            text-align: center;
            color: var(--secondary-text-color);
            padding: 20px;
            font-style: italic;
          }
          .version { font-size: 0.65em; color: #999; text-align: right; margin-top: 8px; }
        </style>
        <div class="card">
          <div class="header">${name}</div>
          <div class="unconfigured">
            Please configure the card to select an intercom device.
          </div>
          <div class="version">v${INTERCOM_CARD_VERSION}</div>
        </div>
      `;
      return;
    }

    const statusText = this._starting ? "Connecting..." :
                       this._stopping ? "Ending call..." :
                       this._ringing ? "Ringing..." :
                       this._active ? "In Call" : "Ready";
    const statusClass = this._starting || this._stopping ? "transitioning" :
                        this._ringing ? "ringing" :
                        this._active ? "connected" : "disconnected";

    // Build destination options for PTMP mode
    const isPtmp = this._isPtmpMode();
    const destinationOptions = isPtmp
      ? this._availableDevices.map(d =>
          `<option value="${d.device_id}" ${this._selectedDestination === d.device_id ? 'selected' : ''}>${d.name}</option>`
        ).join('')
      : '';

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, white));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
          padding: 16px;
        }
        .header { font-size: 1.2em; font-weight: 500; margin-bottom: 16px; color: var(--primary-text-color); }

        .destination-selector {
          margin-bottom: 16px;
        }
        .destination-selector label {
          display: block;
          font-size: 0.85em;
          color: var(--secondary-text-color);
          margin-bottom: 4px;
        }
        .destination-selector select {
          width: 100%;
          padding: 8px 12px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 8px;
          background: var(--card-background-color, white);
          color: var(--primary-text-color);
          font-size: 1em;
        }
        .mode-badge {
          display: inline-block;
          font-size: 0.7em;
          padding: 2px 6px;
          border-radius: 4px;
          margin-left: 8px;
          vertical-align: middle;
        }
        .mode-badge.p2p { background: #4caf50; color: white; }
        .mode-badge.ptmp { background: #2196f3; color: white; }

        .button-container { display: flex; justify-content: center; margin-bottom: 16px; }
        .intercom-button {
          width: 100px; height: 100px; border-radius: 50%; border: none; cursor: pointer;
          font-size: 1em; font-weight: bold; transition: all 0.2s ease;
          display: flex; align-items: center; justify-content: center;
        }
        .intercom-button.call { background: #4caf50; color: white; }
        .intercom-button.hangup { background: #f44336; color: white; animation: pulse 1.5s infinite; }
        .intercom-button.ringing { background: #ff9800; color: white; animation: ring-pulse 1s infinite; }
        .intercom-button:disabled { opacity: 0.5; cursor: not-allowed; animation: none; }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(244, 67, 54, 0.4); }
          70% { box-shadow: 0 0 0 15px rgba(244, 67, 54, 0); }
          100% { box-shadow: 0 0 0 0 rgba(244, 67, 54, 0); }
        }
        @keyframes ring-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.05); }
        }
        .status { text-align: center; color: var(--secondary-text-color); font-size: 0.9em; }
        .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
        .status-indicator.connected { background: #4caf50; }
        .status-indicator.disconnected { background: #9e9e9e; }
        .status-indicator.transitioning { background: #ff9800; animation: blink 0.5s infinite; }
        .status-indicator.ringing { background: #ff9800; animation: blink 0.5s infinite; }
        @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        .stats { font-size: 0.75em; color: #666; margin-top: 8px; text-align: center; }
        .error { color: #f44336; font-size: 0.85em; text-align: center; margin-top: 8px; }
        .version { font-size: 0.65em; color: #999; text-align: right; margin-top: 8px; }
      </style>
      <div class="card">
        <div class="header">
          ${name}
          <span class="mode-badge ${isPtmp ? 'ptmp' : 'p2p'}">${isPtmp ? 'PTMP' : 'P2P'}</span>
        </div>
        ${isPtmp ? `
        <div class="destination-selector">
          <label>Destination</label>
          <select id="destination-select">
            <option value="">-- Select destination --</option>
            ${destinationOptions}
          </select>
        </div>
        ` : ''}
        <div class="button-container">
          <button class="intercom-button ${this._active ? "hangup" : this._ringing ? "ringing" : "call"}" id="btn"
                  ${this._starting || this._stopping || (isPtmp && !this._selectedDestination && !this._active) ? "disabled" : ""}>
            ${this._stopping ? "..." : this._active || this._ringing ? "Hangup" : isPtmp ? "Bridge" : "Call"}
          </button>
        </div>
        <div class="status">
          <span class="status-indicator ${statusClass}"></span>
          ${statusText}
        </div>
        <div class="stats" id="stats">${isPtmp ? 'Bridge ready' : 'Sent: 0 | Recv: 0'}</div>
        <div class="error" id="err"></div>
        <div class="version">v${INTERCOM_CARD_VERSION}</div>
      </div>
    `;

    const btn = this.shadowRoot.getElementById("btn");
    if (btn) btn.onclick = () => this._toggle();

    // PTMP destination selector
    const destSelect = this.shadowRoot.getElementById("destination-select");
    if (destSelect) {
      destSelect.onchange = (e) => {
        this._selectedDestination = e.target.value || null;
        this._render();
      };
    }
  }

  _updateStats() {
    const el = this.shadowRoot?.getElementById("stats");
    if (el) el.textContent = `Sent: ${this._chunksSent} | Recv: ${this._chunksReceived}`;
  }

  _showError(msg) {
    const el = this.shadowRoot?.getElementById("err");
    if (el) el.textContent = msg;
  }

  async _toggle() {
    if (this._starting || this._stopping) return;
    if (this._active || this._ringing) {
      await this._hangup();
    } else if (this._isPtmpMode()) {
      await this._bridge();
    } else {
      await this._call();
    }
  }

  async _call() {
    // Get device info for the configured entity
    const deviceInfo = await this._getDeviceInfo();
    if (!deviceInfo || !deviceInfo.host) {
      this._showError("Device IP not available");
      return;
    }
    this._activeDeviceInfo = deviceInfo;

    this._starting = true;
    this._render();
    this._showError("");
    this._chunksSent = 0;
    this._chunksReceived = 0;

    try {
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      if (this._audioContext.state === "suspended") await this._audioContext.resume();

      await this._audioContext.audioWorklet.addModule(`/local/intercom-processor.js?v=${INTERCOM_CARD_VERSION}`);
      this._source = this._audioContext.createMediaStreamSource(this._mediaStream);
      this._workletNode = new AudioWorkletNode(this._audioContext, "intercom-processor");
      this._workletNode.port.onmessage = (e) => {
        if (e.data.type === "audio") this._sendAudio(new Int16Array(e.data.buffer));
      };
      this._source.connect(this._workletNode);

      this._playbackContext = new (window.AudioContext || window.webkitAudioContext)();
      this._gainNode = this._playbackContext.createGain();
      this._gainNode.gain.value = 1.0;
      this._gainNode.connect(this._playbackContext.destination);

      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/start",
        device_id: deviceInfo.device_id,
        host: deviceInfo.host,
      });
      if (!result.success) throw new Error("Start failed");

      // Subscribe to audio events
      this._unsubscribeAudio = await this._hass.connection.subscribeEvents(
        (e) => this._handleAudioEvent(e), "intercom_audio"
      );

      // Subscribe to state events (ringing, streaming, disconnected)
      this._unsubscribeState = await this._hass.connection.subscribeEvents(
        (e) => this._handleStateEvent(e), "intercom_state"
      );

      // Handle initial state based on response
      if (result.state === "ringing") {
        // ESP has auto_answer OFF, waiting for local answer
        this._ringing = true;
        this._active = false;
      } else {
        // Streaming started immediately
        this._active = true;
        this._ringing = false;
      }

      this._starting = false;
      this._render();
    } catch (err) {
      this._showError(err.message || String(err));
      await this._cleanup();
      this._starting = false;
      this._render();
    }
  }

  async _getDeviceInfo() {
    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/list_devices",
      });
      if (result && result.devices) {
        const configId = this.config.entity_id || this.config.device_id;
        return result.devices.find(d =>
          d.device_id === configId ||
          d.esphome_id === configId ||
          d.name === configId ||
          d.name?.toLowerCase().replace(/\s+/g, '-') === configId
        );
      }
    } catch (err) {
      console.error("Failed to get device info:", err);
    }
    return null;
  }

  async _bridge() {
    // PTMP mode: bridge audio between source ESP and destination ESP
    const sourceDeviceInfo = await this._getDeviceInfo();
    if (!sourceDeviceInfo || !sourceDeviceInfo.host) {
      this._showError("Source device IP not available");
      return;
    }

    const destDevice = this._availableDevices.find(d => d.device_id === this._selectedDestination);
    if (!destDevice || !destDevice.host) {
      this._showError("Destination device not selected or IP not available");
      return;
    }

    this._activeDeviceInfo = sourceDeviceInfo;
    this._starting = true;
    this._render();
    this._showError("");

    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/bridge",
        source_device_id: sourceDeviceInfo.device_id,
        source_host: sourceDeviceInfo.host,
        dest_device_id: destDevice.device_id,
        dest_host: destDevice.host,
      });

      if (!result.success) throw new Error(result.error || "Bridge failed");

      // Subscribe to state events for bridge status
      this._unsubscribeState = await this._hass.connection.subscribeEvents(
        (e) => this._handleBridgeStateEvent(e), "intercom_bridge_state"
      );

      this._active = true;
      this._starting = false;
      this._render();
    } catch (err) {
      this._showError(err.message || String(err));
      this._starting = false;
      this._render();
    }
  }

  _handleBridgeStateEvent(event) {
    if (!event.data || !this._activeDeviceInfo) return;
    // Check if this event is for our bridge session
    if (event.data.source_device_id !== this._activeDeviceInfo.device_id &&
        event.data.dest_device_id !== this._selectedDestination) return;

    const state = event.data.state;
    if (state === "connected") {
      this._active = true;
      this._render();
    } else if (state === "disconnected") {
      this._hangup();
    }
  }

  async _hangup() {
    this._stopping = true;
    this._render();
    try {
      if (this._activeDeviceInfo) {
        await this._hass.connection.sendMessagePromise({
          type: "intercom_native/stop",
          device_id: this._activeDeviceInfo.device_id,
        });
      }
    } catch (err) {}
    await this._cleanup();
    this._active = false;
    this._ringing = false;
    this._stopping = false;
    this._activeDeviceInfo = null;
    this._render();
  }

  async _cleanup() {
    if (this._unsubscribeAudio) { this._unsubscribeAudio(); this._unsubscribeAudio = null; }
    if (this._unsubscribeState) { this._unsubscribeState(); this._unsubscribeState = null; }
    if (this._mediaStream) { this._mediaStream.getTracks().forEach(t => t.stop()); this._mediaStream = null; }
    if (this._workletNode) { this._workletNode.disconnect(); this._workletNode = null; }
    if (this._source) { this._source.disconnect(); this._source = null; }
    if (this._audioContext) { await this._audioContext.close().catch(() => {}); this._audioContext = null; }
    if (this._playbackContext) { await this._playbackContext.close().catch(() => {}); this._playbackContext = null; }
    this._gainNode = null;
    this._nextPlayTime = 0;
    this._chunksDropped = 0;
    this._ringing = false;
  }

  _sendAudio(int16Array) {
    if (!this._active || !this._activeDeviceInfo) return;
    const bytes = new Uint8Array(int16Array.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    this._hass.connection.sendMessage({
      type: "intercom_native/audio",
      device_id: this._activeDeviceInfo.device_id,
      audio: btoa(binary),
    });
    this._chunksSent++;
    if (this._chunksSent % 25 === 0) this._updateStats();
  }

  _handleStateEvent(event) {
    if (!event.data || !this._activeDeviceInfo) return;
    if (event.data.device_id !== this._activeDeviceInfo.device_id) return;

    const state = event.data.state;

    if (state === "streaming") {
      this._ringing = false;
      this._active = true;
      this._render();
    } else if (state === "ringing") {
      this._ringing = true;
      this._active = false;
      this._render();
    } else if (state === "disconnected") {
      this._hangup();
    }
  }

  _handleAudioEvent(event) {
    if (!event.data || !this._activeDeviceInfo) return;
    if (event.data.device_id !== this._activeDeviceInfo.device_id) return;
    if (!this._active || !this._playbackContext) return;

    this._chunksReceived++;
    if (this._chunksReceived % 50 === 0) this._updateStats();

    try {
      const binary = atob(event.data.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

      this._playScheduled(float32);
    } catch (err) {}
  }

  _playScheduled(float32) {
    if (!this._playbackContext || !this._gainNode) return;
    try {
      const buffer = this._playbackContext.createBuffer(1, float32.length, 16000);
      buffer.getChannelData(0).set(float32);
      const now = this._playbackContext.currentTime;
      if (this._nextPlayTime < now) this._nextPlayTime = now + 0.01;
      if (this._nextPlayTime - now > 0.2) { this._chunksDropped++; this._nextPlayTime = now + 0.02; return; }
      const src = this._playbackContext.createBufferSource();
      src.buffer = buffer;
      src.connect(this._gainNode);
      src.start(this._nextPlayTime);
      this._nextPlayTime += buffer.duration;
    } catch (err) {}
  }

  getCardSize() { return 3; }

  static getConfigElement() {
    return document.createElement("intercom-card-editor");
  }

  static getStubConfig() {
    return { name: "Intercom" };
  }
}

// Card editor for visual config
class IntercomCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._devices = [];
    this._devicesLoaded = false;
  }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (hass && !this._devicesLoaded) {
      this._loadDevices();
    }
  }

  async _loadDevices() {
    if (!this._hass || this._devicesLoaded) return;

    try {
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/list_devices",
      });

      if (result && result.devices) {
        this._devices = result.devices;
        this._devicesLoaded = true;
        this._render();
      }
    } catch (err) {
      console.error("Failed to load intercom devices:", err);
    }
  }

  _render() {
    const deviceOptions = this._devices.map(d =>
      `<option value="${d.device_id}" ${this._config.entity_id === d.device_id ? 'selected' : ''}>
        ${d.name}
      </option>`
    ).join('');

    const currentMode = this._config.mode || 'p2p';

    this.innerHTML = `
      <style>
        .form-group {
          margin-bottom: 16px;
        }
        .form-group label {
          display: block;
          margin-bottom: 4px;
          font-weight: 500;
          color: var(--primary-text-color);
        }
        .form-group input,
        .form-group select {
          width: 100%;
          padding: 8px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 4px;
          background: var(--card-background-color, white);
          color: var(--primary-text-color);
          font-size: 1em;
          box-sizing: border-box;
        }
        .form-group input:focus,
        .form-group select:focus {
          outline: none;
          border-color: var(--primary-color, #03a9f4);
        }
        .info {
          color: var(--secondary-text-color);
          font-size: 0.85em;
          margin-top: 8px;
        }
        .mode-info {
          background: var(--secondary-background-color, #f5f5f5);
          border-radius: 8px;
          padding: 12px;
          margin-top: 16px;
        }
        .mode-info h4 {
          margin: 0 0 8px 0;
          color: var(--primary-text-color);
        }
        .mode-info p {
          margin: 0;
          color: var(--secondary-text-color);
          font-size: 0.9em;
        }
        .mode-selector {
          display: flex;
          gap: 8px;
          margin-top: 8px;
        }
        .mode-btn {
          flex: 1;
          padding: 12px;
          border: 2px solid var(--divider-color, #ccc);
          border-radius: 8px;
          background: var(--card-background-color, white);
          cursor: pointer;
          text-align: center;
          transition: all 0.2s;
        }
        .mode-btn:hover {
          border-color: var(--primary-color, #03a9f4);
        }
        .mode-btn.selected {
          border-color: var(--primary-color, #03a9f4);
          background: var(--primary-color, #03a9f4);
          color: white;
        }
        .mode-btn .mode-title {
          font-weight: bold;
          font-size: 1.1em;
        }
        .mode-btn .mode-desc {
          font-size: 0.8em;
          opacity: 0.8;
          margin-top: 4px;
        }
      </style>
      <div style="padding: 16px;">
        <div class="form-group">
          <label>Intercom Device</label>
          <select id="entity-select">
            <option value="">-- Select device --</option>
            ${deviceOptions}
          </select>
          <div class="info">
            ${this._devicesLoaded
              ? (this._devices.length === 0 ? 'No intercom devices found' : 'Select the intercom device for this card')
              : 'Loading devices...'}
          </div>
        </div>
        <div class="form-group">
          <label>Card Name (optional)</label>
          <input type="text" id="name-input" value="${this._config.name || ''}" placeholder="Intercom">
        </div>
        <div class="form-group">
          <label>Mode</label>
          <div class="mode-selector">
            <div class="mode-btn ${currentMode === 'p2p' ? 'selected' : ''}" id="mode-p2p">
              <div class="mode-title">P2P</div>
              <div class="mode-desc">Browser ↔ ESP</div>
            </div>
            <div class="mode-btn ${currentMode === 'ptmp' ? 'selected' : ''}" id="mode-ptmp">
              <div class="mode-title">PTMP</div>
              <div class="mode-desc">ESP ↔ ESP</div>
            </div>
          </div>
        </div>
        <div class="mode-info">
          ${currentMode === 'p2p' ? `
            <h4>P2P Mode</h4>
            <p>Direct audio streaming between this browser and the selected ESP device.</p>
          ` : `
            <h4>PTMP Mode (Point-to-MultiPoint)</h4>
            <p>Bridge audio between the selected ESP device and another ESP device.</p>
            <p style="margin-top: 8px;">The card will show a destination selector at runtime.</p>
          `}
        </div>
      </div>
    `;

    const entitySelect = this.querySelector('#entity-select');
    if (entitySelect) {
      entitySelect.onchange = (e) => this._valueChanged('entity_id', e.target.value);
    }

    const nameInput = this.querySelector('#name-input');
    if (nameInput) {
      nameInput.onchange = (e) => this._valueChanged('name', e.target.value);
    }

    const modeP2p = this.querySelector('#mode-p2p');
    const modePtmp = this.querySelector('#mode-ptmp');
    if (modeP2p) modeP2p.onclick = () => this._valueChanged('mode', 'p2p');
    if (modePtmp) modePtmp.onclick = () => this._valueChanged('mode', 'ptmp');
  }

  _valueChanged(key, value) {
    if (!this._config) return;
    const newConfig = { ...this._config };
    if (value) {
      newConfig[key] = value;
    } else {
      delete newConfig[key];
    }
    const event = new CustomEvent("config-changed", {
      detail: { config: newConfig },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }
}

customElements.define("intercom-card", IntercomCard);
customElements.define("intercom-card-editor", IntercomCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "intercom-card",
  name: "Intercom Card",
  description: "Bidirectional audio intercom with ESP32 (P2P and PTMP modes)",
  preview: true,
});
