//  RearVue - Bangle.js 2 DIY Varia/RearVue app
//  HLK-LD2451 BLE rear sensor display

(function() {
  // --- Configuration ---
  const SERVICE_UUID = "fff0";          // 0xFFF0
  const CHAR_UUID = "fff1";             // 0xFFF1
  const DEVICE_NAME_PREFIX = "HLK";  //  module advertises like this
  
  const FRAME_HEADER = [0xF4, 0xF3, 0xF2, 0xF1];
  const FRAME_TAIL = [0xF8, 0xF7, 0xF6, 0xF5];

  const MIN_ANGLE_DEG = -60;
  const MAX_ANGLE_DEG = 60;
  const MAX_DISTANCE_M = 100;

  const BOX_W = 20;
  const BOX_H = 12;

  const TIMEOUT_NO_TARGETS_MS = 5000;   // Screen off after no targets
  const TIMEOUT_BRIGHT_MS = 2000;       // Brief bright screen on new target

  // --- Globals ---
  let gatt = null;
  let characteristic = null;
  let connected = false;
  let scanning = false;

  let latestParsed = null;
  let lastTargetTime = 0;
  let screenBright = false;

  const SCREEN_W = 240;
  const SCREEN_H = 240;

  // --- Graphics helpers ---
  function resetG() {
    g.reset();
  }

  function clearScreen() {
    g.clear();
  }

  function drawWaiting() {
    resetG();
    clearScreen();
    g.setFont("6x8", 2);
    g.setFontAlign(0, 0);
    g.drawString("RearVue", SCREEN_W / 2 - 20, SCREEN_H / 2 - 20, true);
    g.setFont("6x8", 1);
    g.drawString("Scanning for HLK-LD2451...", SCREEN_W / 2 - 20, SCREEN_H / 2 + 10, true);
  }

  function drawNoTargets() {
    resetG();
    clearScreen();
    g.setFont("6x8", 2);
    g.setFontAlign(0, 0);
    g.drawString("RearVue", SCREEN_W / 2 - 20, SCREEN_H / 2 - 20, true);
    g.setFont("6x8", 1);
    g.drawString("No targets", SCREEN_W / 2 - 20, SCREEN_H / 2 + 10, true);
  }

  function drawTargets(parsed) {
    resetG();
    clearScreen();

    g.setFont("6x8", 2);
    g.setFontAlign(0, 0);
    g.drawString("RearVue", SCREEN_W / 2 - 20, 20, true);

    g.setFont("6x8", 1);
    g.drawString(`Targets: ${parsed.target_count}`, SCREEN_W / 2 - 20, 40, true);

    // Draw each target
    for (let i = 0; i < parsed.targets.length; i++) {
      const t = parsed.targets[i];
      drawTargetOverlay(t, i);
    }
  }

  function mapTargetToScreen(t) {
    const angle = t.angle_deg;
    const dist = t.distance_m;

    // X: angle from MIN_ANGLE_DEG to MAX_ANGLE_DEG -> 0..SCREEN_W
    let x = ((angle - MIN_ANGLE_DEG) / (MAX_ANGLE_DEG - MIN_ANGLE_DEG)) * SCREEN_W;
    // Y: distance 0..MAX_DISTANCE_M -> 0..SCREEN_H (0 = top, SCREEN_H = bottom)
    let y = (dist / MAX_DISTANCE_M) * SCREEN_H;

    // Clamp
    x = Math.max(0, Math.min(SCREEN_W - 1, x));
    y = Math.max(0, Math.min(SCREEN_H - 1, y));

    return { x, y };
  }

  function drawTargetOverlay(t, idx) {
    const pos = mapTargetToScreen(t);
    const x = pos.x;
    const y = pos.y;

    const color = t.direction === "toward" ? [0, 1, 0] : [1, 0.65, 0]; // green / orange

    // Box
    const x1 = Math.max(0, x - BOX_W);
    const x2 = Math.min(SCREEN_W - 1, x + BOX_W);
    const y1 = Math.max(0, y - BOX_H);
    const y2 = Math.min(SCREEN_H - 1, y + BOX_H);

    g.setColor(color[0], color[1], color[2]);
    g.drawRect(x1, y1, x2, y2);

    // Center dot
    g.fillCircle(x, y, 3);

    // Text
    g.setFont("6x8", 1);
    g.setColor(1, 1, 1);
    g.setFontAlign(-1, -1);

    const label1 = `T${t.target} ${t.angle_deg}° ${t.distance_m}m`;
    const label2 = `${t.direction} ${t.speed_kmh}km/h SNR${t.snr}`;

    // Avoid going off top
    const textY = Math.max(10, y1 - 2);

    g.drawString(label1, x1, textY, false);
    g.drawString(label2, x1, textY + 10, false);
  }

  // --- Frame parsing (same logic as Python) ---
  function extractFrames(buffer) {
    const frames = [];
    let i = 0;

    while (i < buffer.length - 7) {
      // Find header
      let start = -1;
      for (let j = i; j < buffer.length - 7; j++) {
        if (
          buffer[j] === FRAME_HEADER[0] &&
          buffer[j + 1] === FRAME_HEADER[1] &&
          buffer[j + 2] === FRAME_HEADER[2] &&
          buffer[j + 3] === FRAME_HEADER[3]
        ) {
          start = j;
          break;
        }
      }

      if (start < 0) break;

      // Check minimum length
      if (buffer.length - start < 10) {
        console.log("(buf len - start) < 10");
        break;
      }

      // Length: 2 bytes little-endian at start+4, start+5
      const length = buffer[start + 4] + (buffer[start + 5] << 8);

      const totalLen = 4 + 2 + length + 4;
      if (totalLen < 10) {
        i = start + 1;
        continue;
      }

      if (buffer.length - start < totalLen) break;

      // Check tail
      let tailOk = true;
      for (let k = 0; k < 4; k++) {
        if (buffer[start + totalLen - 4 + k] !== FRAME_TAIL[k]) {
          tailOk = false;
          break;
        }
      }

      if (!tailOk) {
        i = start + 1;
        continue;
      }

      const frame = [];
      for (let k = 0; k < totalLen; k++) {
        frame.push(buffer[start + k]);
      }

      frames.push(frame);
      i = start + totalLen;
    }

    return frames;
  }

  function parseFrame(frame) {
    if (frame.length < 10) {
      console.log("frame len < 10");
      return null;
    }

    // Header
    for (let i = 0; i < 4; i++) {
      if (frame[i] !== FRAME_HEADER[i]) {
        console.log("frame header mismatch");
        return null;
      }
    }
    // Tail
    for (let i = 0; i < 4; i++) {
      if (frame[frame.length - 4 + i] !== FRAME_TAIL[i]) {
        console.log("frame tail mismatch");
        return null;
      }
    }

    const length = frame[4] + (frame[5] << 8);
    if (length !== frame.length - 10) {
      console.log("frame length mismatch");
      return null;
    }

    if (length < 2) {
      console.log(" No payload ");
      return {
        length: 0,
        target_count: 0,
        alarm_info: 0,
        targets: []
      };
    }

    const payload = frame.slice(6, 6 + length);

    const target_count = payload[0];
    const alarm_info = payload[1];

    const targets = [];
    let offset = 2;

    for (let i = 0; i < target_count; i++) {
      if (offset + 5 > payload.length) break;

      const angle_raw = payload[offset];
      const distance = payload[offset + 1];
      const speed_dir = payload[offset + 2];
      const speed_val = payload[offset + 3];
      const snr = payload[offset + 4];

      const angle = angle_raw - 0x80;
      const direction = speed_dir ? "away" : "toward";

      targets.push({
        target: i + 1,
        angle_deg: angle,
        distance_m: distance,
        direction: direction,
        speed_kmh: speed_val,
        snr: snr
      });

      offset += 5;
    }

    return {
      length: length,
      target_count: target_count,
      alarm_info: alarm_info,
      targets: targets
    };
  }

  function parseMessage(buffer) {
    const frames = extractFrames(buffer);
    for (const frame of frames) {
      const parsed = parseFrame(frame);
      if (parsed) {
        console.log("Parsed:", parsed);
        latestParsed = parsed;
        lastTargetTime = Date.now();

        if (parsed.target_count > 0) {
          // Turn on screen, bright if new target
          if (!screenBright) {
            screenBright = true;
            Bangle.setLCDPower(1);
            Bangle.setLCDTimeout(0);
          }
          // Vibrate if any target toward
          for (const t of parsed.targets) {
            if (t.direction === "toward") {
              Bangle.buzz(150);
              break;
            }
          }
        }
      }
    }
  }

  // --- BLE connection ---
  function startScanning() {
    if (scanning) return;
    scanning = true;

    drawWaiting();

    console.log("now trying findDevices");
    NRF.findDevices(function(devices) {
      console.log(devices);
    }, {
      timeout : 5000, 
      //active : true,
      filters : [
        {namePrefix: DEVICE_NAME_PREFIX },
        //{namePrefix: 'HLK'},
        //{namePrefix: 'HLK-2451'},
        {name: 'HLK-2451_7505'},
        //{services: ["0000fff1-0000-1000-8000-00805f9b34fb"]}, // the characteristic
        //{services: ["0000fff0-0000-1000-8000-00805f9b34fb"]},
        {services: ['0000fff0-0000-1000-8000-00805f9b34fb']},
        {serviceData: {'0xfff0':{}}}
      ] 
    });

    
    console.log("now trying requestDevice");

    NRF.requestDevice({
      timeout: 10000,
      active: true,
      filters: [
        //{namePrefix: DEVICE_NAME_PREFIX},
        //{namePrefix: 'HLK'},
        //{namePrefix: 'HLK-2451'},
        //{name: 'HLK-2451_7505'},
        //{services: ["0000fff1-0000-1000-8000-00805f9b34fb"]}, // the characteristic
        //{services: ["0000fff0-0000-1000-8000-00805f9b34fb"]},
        {services: ['0000fff0-0000-1000-8000-00805f9b34fb']} //,
        //{serviceData: {SERVICE_UUID:{}}}
      ]
    }).then(function(device) {
      scanning = false;
      console.log("Found device:", device.name);
      return device.gatt.connect({ minInterval: 7.5, maxInterval: 7.5 });
    }).then(function(g) {
      console.log("Connected");
      connected = true;
      gatt = g;
      return gatt.getPrimaryService(SERVICE_UUID);
    }).then(function(service) {
      console.log("Got service");
      return service.getCharacteristic(CHAR_UUID);
    }).then(function(c) {
      console.log("Got characteristic");
      characteristic = c;
      characteristic.on("characteristicvaluechanged", function(event) {
        const buf = event.target.value.buffer;
        // Convert to array
        const arr = [];
        for (let i = 0; i < buf.byteLength; i++) {
          arr.push(buf.getUint8(i));
        }
        parseMessage(arr);
      });
      return characteristic.startNotifications();
    }).then(function() {
      console.log("Notifications started");
      scanLoop();
    }).catch(function(error) {
      console.log("Error:", error);
      connected = false;
      scanning = false;
      gatt = null;
      characteristic = null;
      setTimeout(startScanning, 2000);
    });
  }

  function scanLoop() {
    function update() {
      const now = Date.now();

      if (latestParsed) {
        if (latestParsed.target_count > 0) {
          drawTargets(latestParsed);
          // Keep screen on
          if (!screenBright) {
            screenBright = true;
            Bangle.setLCDPower(1);
            Bangle.setLCDTimeout(0);
          }
        } else {
          // No targets
          drawNoTargets();
          if (now - lastTargetTime > TIMEOUT_NO_TARGETS_MS) {
            screenBright = false;
            Bangle.setLCDPower(0);
            Bangle.setLCDTimeout(TIMEOUT_BRIGHT_MS);
          }
        }
      } else {
        drawWaiting();
      }

      setTimeout(update, 200);
    }

    update();
  }

  // --- App lifecycle ---
  drawWaiting();
  Bangle.loadWidgets();
  Bangle.drawWidgets();

  // Start scanning when LCD is on
  Bangle.on("lcdPower", function(on) {
    if (on && !connected) {
      startScanning();
    }
  });

  // If initially off, start when turned on
  if (Bangle.isLCDOn()) {
    startScanning();
  }

})();
