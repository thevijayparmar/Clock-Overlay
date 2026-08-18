/**
 * clock-overlay.js — Idle Digital/Analog Clock Overlay
 * ===================================================================
 * A drop-in, full-screen idle clock overlay for any website. Shows a
 * digital or analog clock (five display themes), a live sky with
 * weather-driven atmospheric effects, and a 3D-textured sun/moon —
 * all with zero required dependencies (Three.js loads from a CDN
 * only for the 3D sun/moon, and degrades gracefully to a flat 2D
 * disc if that fails to load).
 *
 * FILES:
 *   clock-overlay.js         — this file, the engine. Don't edit it.
 *   clock-overlay.config.js  — your settings. Edit this one instead.
 *   demo.html                — a self-contained working example.
 *
 * TRIGGERS:
 *   - Idle: no scroll for `idleTimeoutMs` (default 3 minutes) → the
 *     clock opens automatically.
 *   - Manual: call window.ClockOverlay.show() / .hide() / .toggle()
 *     from your own site's UI — a button, a keyboard shortcut,
 *     whatever you like. See the PUBLIC API section near the end of
 *     this file.
 *
 * Include (config first, then the engine):
 *   <script src="clock-overlay.config.js"></script>
 *   <script src="clock-overlay.js" defer></script>
 *
 * MIT License — see LICENSE.
 */
(function () {
  'use strict';

  if (window.__clockOverlayWired) return;
  window.__clockOverlayWired = true;

  /* ════════════════════════════════════════════════════
     CONFIG
     Reads window.ClockOverlayConfig (see clock-overlay.config.js).
     Every field is optional — anything not provided falls back to
     the default already in effect throughout this file.
  ════════════════════════════════════════════════════ */
  var cfg = window.ClockOverlayConfig || {};

  /* ════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════ */
  var IDLE_MS = (typeof cfg.idleTimeoutMs === 'number') ? cfg.idleTimeoutMs : 3 * 60 * 1000;
  var MONTHS  = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

  /* ── Celestial body size. 1.0 = original size. Currently 1.2 = +20%.
     Change this single number to resize both the sun and moon (and their
     glow/aura, which scale off the same radius). ── */
  var CELESTIAL_SIZE = (typeof cfg.celestialSize === 'number') ? cfg.celestialSize : 1.2;

  /* ════════════════════════════════════════════════════
     STATE
  ════════════════════════════════════════════════════ */
  var idleTimer;
  var clockTick;
  var isVisible   = false;
  var isMinimized = false;
  var colorTheme  = cfg.defaultColorTheme || 'live';        /* light | dark | live | grey  — overall page theme */
  var clockTheme  = cfg.defaultClockTheme || 'digital';     /* digital | digital-big | hybrid | analog | analog-big */

  /* API health tracking, surfaced in the debug panel */
  var apiStatus = {
    geo:     { ok: null, detail: 'Not yet checked' },
    weather: { ok: null, detail: 'Not yet checked' },
    aqi:     { ok: null, detail: 'Not yet checked' }
  };

  /* Weather + sky-effect state (Chunk 4) */
  var weatherFetched = false;
  var geoData     = null;  /* { lat, lon, city } */
  var weatherData = null;  /* { temp, windKph, code, isDay } */
  var aqiData     = null;  /* { aqi, label } */

  /* ── Debug time override (only active while debug panel open + checked) ──
     When active, getClockNow() returns a synthetic Date built from today's
     date but with the overridden hour/minute, so the clock, sky position,
     phase, and gradient all follow the slider. Auto-disables on panel close.
     Backed by the `dbg` object declared further down (single source of truth);
     these accessors are declared early because many functions call them. */
  function isTimeOverridden() {
    return !!(window.__clkDbg && window.__clkDbg.open && window.__clkDbg.manualTime);
  }

  function getClockNow() {
    if (isTimeOverridden()) {
      var h = window.__clkDbg.manualHours;          /* 0..24 float */
      var hh = Math.floor(h);
      var mm = Math.round((h - hh) * 60);
      if (mm === 60) { mm = 0; hh = (hh + 1) % 24; }
      var d = new Date();
      d.setHours(hh, mm, 0, 0);
      return d;
    }
    return new Date();
  }

  /* Milliseconds version for phase math — respects the same override so the
     moon phase scrubs with the time slider too. */
  function getClockNowMs() {
    return getClockNow().getTime();
  }

  /* Which sky effects are currently enabled. Master 🌏 toggle turns all
     on/off at once but remembers individual picks underneath. */
  var skyEffects = Object.assign({
    master: true,
    cloud: false, rain: false, breeze: true, thunder: false,
    snow: false, fog: false, wave: true, night: true
  }, cfg.skyEffects || {});

  /* ════════════════════════════════════════════════════
     STYLES
  ════════════════════════════════════════════════════ */
  var styleEl = document.createElement('style');
  styleEl.textContent = `
#clk-overlay{
  position:fixed;inset:0;z-index:29000;
  display:none;align-items:center;justify-content:center;
  transition:opacity .4s ease;overflow:hidden;
}
#clk-overlay.clk-visible{display:flex;}
#clk-overlay.clk-light{background:#f8faff;}
#clk-overlay.clk-dark{background:rgba(10,16,40,.97);}
#clk-overlay.clk-live,#clk-overlay.clk-grey{background:#0a1020;}

/* Sky layers sit BELOW the clock text (z-index 0 / 1). The clock content
   is z-index 2+, so a bright full moon or sun can never sit on top of the
   time readout. */
#clk-sky{position:absolute;inset:0;width:100%;height:100%;display:none;pointer-events:none;z-index:0;}
#clk-overlay.clk-live #clk-sky,#clk-overlay.clk-grey #clk-sky{display:block;}
#clk-sky3d{position:absolute;inset:0;width:100%;height:100%;display:none;pointer-events:none;z-index:1;}
#clk-overlay.clk-live #clk-sky3d,#clk-overlay.clk-grey #clk-sky3d{display:block;}

/* ── Top-right shell controls (always visible, never hidden by minimize —
   BUT auto-fades after 5s of no mouse/touch activity, per site owner's
   request, so they don't visually clutter a clean full-screen clock) ── */
#clk-shell-top{
  position:absolute;top:20px;right:20px;z-index:5;
  display:flex;gap:8px;
  transition:opacity .4s ease;
}
#clk-shell-top.clk-idle-hidden{opacity:0;pointer-events:none;}
.clk-shell-btn{
  width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;
  font-size:1.05rem;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  display:flex;align-items:center;justify-content:center;
  transition:transform .2s;-webkit-tap-highlight-color:transparent;
}
.clk-shell-btn:hover{transform:scale(1.1);}
#clk-overlay.clk-light .clk-shell-btn{background:rgba(26,79,214,.12);color:#0f1e36;}
#clk-overlay.clk-dark .clk-shell-btn,
#clk-overlay.clk-live .clk-shell-btn,
#clk-overlay.clk-grey .clk-shell-btn{background:rgba(255,255,255,.12);color:#fff;}

/* ── Left panel: theme grid + tools + clock-theme picker (hidden when minimized) ── */
#clk-panel{
  position:absolute;left:20px;top:50%;transform:translateY(-50%);
  display:flex;flex-direction:column;gap:8px;z-index:5;
  transition:opacity .25s,transform .25s;
}
#clk-panel.clk-hidden{opacity:0;pointer-events:none;transform:translateY(-50%) translateX(-20px);}

.clk-pnl-btn{
  width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;font-size:1.2rem;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  transition:transform .2s;display:flex;align-items:center;justify-content:center;
  -webkit-tap-highlight-color:transparent;position:relative;
}
.clk-pnl-btn:hover{transform:scale(1.1);}
#clk-overlay.clk-light .clk-pnl-btn{background:rgba(26,79,214,.12);color:#0f1e36;}
#clk-overlay.clk-dark .clk-pnl-btn,
#clk-overlay.clk-live .clk-pnl-btn,
#clk-overlay.clk-grey .clk-pnl-btn{background:rgba(255,255,255,.12);color:#fff;}
.clk-pnl-btn.clk-active{box-shadow:0 0 0 2px #1a4fd6;}
.clk-pnl-sep{height:1px;background:rgba(128,128,128,.25);margin:4px 8px;}

/* ── Developer-panel button (pill-shaped, lives inside the settings
   panel — replaces the old hidden 5-tap gesture) ── */
.clk-devpanel-btn{width:auto !important;border-radius:22px;padding:0 16px;font-size:.72rem;font-weight:700;letter-spacing:.2px;gap:6px;white-space:nowrap;}
/* ── Clock-theme submenu (opens from 🕰️) ── */
#clk-theme-menu{
  position:absolute;left:64px;top:0;
  display:none;flex-direction:column;gap:6px;
  background:rgba(20,28,50,.92);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-radius:14px;padding:10px;min-width:170px;
  box-shadow:0 8px 32px rgba(0,0,0,.35);
}
#clk-overlay.clk-light #clk-theme-menu{background:rgba(255,255,255,.96);}
#clk-theme-menu.show{display:flex;}
.clk-theme-opt{
  padding:9px 12px;border-radius:8px;border:none;background:transparent;
  font-size:.82rem;font-weight:600;text-align:left;cursor:pointer;
  color:#0f1e36;font-family:'Inter',system-ui,sans-serif;transition:background .15s;
}
#clk-overlay.clk-dark .clk-theme-opt,
#clk-overlay.clk-live .clk-theme-opt,
#clk-overlay.clk-grey .clk-theme-opt{color:#fff;}
.clk-theme-opt:hover{background:rgba(26,79,214,.15);}
.clk-theme-opt.clk-active{background:rgba(26,79,214,.25);}

/* ── Content area ── */
#clk-content{position:relative;z-index:2;text-align:center;user-select:none;
  display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;height:100%;
  justify-content:center;}

/* ── Soft dark halo behind the clock text ──────────────────────────────
   Layered wide-blur shadows form a gentle vignette around each glyph.
   Against a plain dark night sky or a plain bright day sky this is
   essentially invisible; it only becomes perceptible when something
   high-contrast (a full moon, or the sun) passes behind the text, which
   is exactly when the text needs the separation. Applied only to the
   live/grey sky themes, since the flat light/dark themes have no
   celestial body behind the text to fight with.
   TUNABLE: raise the alpha values for a stronger halo, lower for subtler. */
#clk-overlay.clk-live #clk-content,
#clk-overlay.clk-grey #clk-content{
  text-shadow:
    0 0 12px rgba(0,0,0,.30),
    0 0 28px rgba(0,0,0,.24),
    0 0 56px rgba(0,0,0,.18);
}
/* The analog canvas can't take a text-shadow, so it gets an equivalent
   soft drop-shadow filter instead. */
#clk-overlay.clk-live #clk-analog-canvas,
#clk-overlay.clk-grey #clk-analog-canvas{
  filter:drop-shadow(0 0 14px rgba(0,0,0,.32)) drop-shadow(0 0 34px rgba(0,0,0,.22));
}

/* Digital clock */
#clk-digital-view{display:none;flex-direction:column;align-items:center;gap:10px;}
#clk-digital-view.active{display:flex;}
#clk-time{
  font-family:'Inter',system-ui,sans-serif;font-weight:800;letter-spacing:-.02em;
  line-height:1;color:inherit;display:flex;align-items:flex-start;gap:2px;
  font-size:clamp(3rem,14vmin,10rem);
}
#clk-overlay.clk-digital-big #clk-time{font-size:min(30vw,42vh);}
#clk-sec-wrap{display:flex;flex-direction:column;align-items:flex-start;margin-left:6px;}
#clk-sec{font-size:.28em;font-weight:600;opacity:.55;font-variant-numeric:tabular-nums;line-height:1;}
#clk-ampm{font-size:.28em;font-weight:600;opacity:.7;margin-top:2px;}

/* Analog clock */
#clk-analog-view{display:none;flex-direction:column;align-items:center;gap:14px;}
#clk-analog-view.active{display:flex;}
#clk-analog-canvas{display:block;}

/* Hybrid (analog + digital combined) — compact digital readout below the analog face */
#clk-hybrid-digital{
  display:none;align-items:flex-start;gap:2px;justify-content:center;
  font-family:'Inter',system-ui,sans-serif;font-weight:700;letter-spacing:-.01em;
  line-height:1;color:inherit;
  font-size:clamp(1.3rem,4vmin,2.4rem);
}
#clk-overlay.clk-hybrid-active #clk-hybrid-digital{display:flex;}
#clk-hyb-sec-wrap{display:flex;flex-direction:column;align-items:flex-start;margin-left:4px;}
#clk-hyb-sec{font-size:.32em;font-weight:600;opacity:.55;font-variant-numeric:tabular-nums;line-height:1;}
#clk-hyb-ampm{font-size:.32em;font-weight:600;opacity:.7;margin-top:1px;}

/* Date + meta row (shared across all clock themes) */
#clk-date{
  font-family:'Inter',system-ui,sans-serif;font-weight:500;opacity:.78;letter-spacing:.03em;
  font-size:clamp(.85rem,2.6vmin,1.7rem);
}
#clk-meta{
  font-family:'Inter',system-ui,sans-serif;font-weight:400;opacity:.6;
  display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;
  font-size:clamp(.7rem,1.7vmin,1.05rem);
}
#clk-overlay.clk-light #clk-time,#clk-overlay.clk-light #clk-date,
#clk-overlay.clk-light #clk-meta,#clk-overlay.clk-light #clk-analog-view{color:#0f1e36;}
#clk-overlay.clk-dark #clk-time,#clk-overlay.clk-dark #clk-date,
#clk-overlay.clk-dark #clk-meta,#clk-overlay.clk-dark #clk-analog-view,
#clk-overlay.clk-live #clk-time,#clk-overlay.clk-live #clk-date,
#clk-overlay.clk-live #clk-meta,#clk-overlay.clk-live #clk-analog-view,
#clk-overlay.clk-grey #clk-time,#clk-overlay.clk-grey #clk-date,
#clk-overlay.clk-grey #clk-meta,#clk-overlay.clk-grey #clk-analog-view{color:#fff;}

/* ── Debug panel ── */
#clk-debug{
  position:absolute;bottom:60px;right:20px;z-index:6;
  width:280px;max-width:calc(100vw - 40px);
  background:rgba(15,25,50,.96);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  border-radius:14px;padding:16px;box-shadow:0 8px 32px rgba(0,0,0,.4);
  display:none;color:#fff;font-family:'Inter',system-ui,sans-serif;
}
#clk-overlay.clk-light #clk-debug{background:rgba(255,255,255,.98);color:#0f1e36;
  box-shadow:0 8px 32px rgba(15,30,54,.18);}
#clk-debug.show{display:block;}
#clk-debug-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
#clk-debug-title{font-size:.8rem;font-weight:700;letter-spacing:.4px;text-transform:uppercase;opacity:.85;}
#clk-debug-close{
  width:24px;height:24px;border-radius:50%;border:none;cursor:pointer;
  background:rgba(255,255,255,.12);color:inherit;font-size:.85rem;
  display:flex;align-items:center;justify-content:center;
}
#clk-overlay.clk-light #clk-debug-close{background:rgba(26,79,214,.12);}
.clk-debug-row{
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:8px 0;border-bottom:1px solid rgba(128,128,128,.18);font-size:.78rem;
}
.clk-debug-row:last-child{border-bottom:none;}
.clk-debug-label{font-weight:600;opacity:.85;}
.clk-debug-detail{font-size:.68rem;opacity:.6;max-width:150px;text-align:right;}
.clk-debug-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.clk-debug-dot.ok{background:#00d67a;box-shadow:0 0 6px rgba(0,214,122,.6);}
.clk-debug-dot.fail{background:#ff4d4d;box-shadow:0 0 6px rgba(255,77,77,.6);}
.clk-debug-dot.pending{background:#ffb020;box-shadow:0 0 6px rgba(255,176,32,.6);}

/* ── Debug: 3D / phase live readout + time override controls ── */
#clk-dbg-time-slider{width:100%;margin:8px 0 2px;cursor:pointer;accent-color:#1a4fd6;}
.clk-dbg-mono{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.66rem;line-height:1.5;opacity:.75;white-space:pre-wrap;word-break:break-word;
}
.clk-dbg-time-val{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  font-size:.78rem;font-weight:700;opacity:.95;
}
.clk-dbg-check{
  display:flex;align-items:center;gap:8px;cursor:pointer;
  font-size:.75rem;font-weight:600;opacity:.9;
}
.clk-dbg-check input{width:16px;height:16px;cursor:pointer;}

/* ── Weather effect toggle button (🌏) + circular ring menu ── */
#clk-weather-toggle-wrap{position:relative;}
#clk-weather-ring-menu{
  position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
  width:220px;height:220px;pointer-events:none;opacity:0;
  transition:opacity .25s;z-index:20;
}
#clk-weather-ring-menu.show{opacity:1;pointer-events:auto;}
.clk-wring-center,.clk-wring-item{
  position:absolute;width:46px;height:46px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;font-size:1.15rem;
  cursor:pointer;transition:transform .18s;-webkit-tap-highlight-color:transparent;
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
}
.clk-wring-center:hover,.clk-wring-item:hover{transform:scale(1.12);}
.clk-wring-center{top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;}
.clk-wring-center:hover{transform:translate(-50%,-50%) scale(1.12);}
#clk-overlay.clk-light .clk-wring-center,
#clk-overlay.clk-light .clk-wring-item{background:rgba(26,79,214,.14);color:#0f1e36;}
#clk-overlay.clk-dark .clk-wring-center,#clk-overlay.clk-dark .clk-wring-item,
#clk-overlay.clk-live .clk-wring-center,#clk-overlay.clk-live .clk-wring-item,
#clk-overlay.clk-grey .clk-wring-center,#clk-overlay.clk-grey .clk-wring-item{
  background:rgba(255,255,255,.14);color:#fff;
}
.clk-wring-item.off{opacity:.35;}
.clk-wring-center.off{opacity:.4;}

/* ── Weather meta additions ── */
.clk-meta-item{display:flex;align-items:center;gap:4px;}

@media(max-width:500px){
  #clk-panel{left:8px;gap:5px;}
  .clk-pnl-btn{width:38px;height:38px;font-size:1rem;}
  #clk-shell-top{top:12px;right:12px;}
  .clk-shell-btn{width:36px;height:36px;font-size:.95rem;}
  #clk-theme-menu{left:52px;}
  #clk-debug{
  ...
  right:12px;bottom:54px;width:240px;
  max-height:70vh;
  overflow-y:auto;
  ...
}
}
`;
  document.head.appendChild(styleEl);

  /* ════════════════════════════════════════════════════
     BUILD DOM
  ════════════════════════════════════════════════════ */
  var overlay = document.createElement('div');
  overlay.id  = 'clk-overlay';

  var sky = document.createElement('canvas');
  sky.id  = 'clk-sky';
  overlay.appendChild(sky);

  var sky3d = document.createElement('canvas');
  sky3d.id  = 'clk-sky3d';
  overlay.appendChild(sky3d);

  /* Top-right: fullscreen + close (never hidden) */
  var shellTop = document.createElement('div');
  shellTop.id  = 'clk-shell-top';
  shellTop.innerHTML = `
    <button class="clk-shell-btn" id="clk-fs-btn" title="Fullscreen">⛶</button>
    <button class="clk-shell-btn" id="clk-min-btn" title="Settings">⚙️</button>
    <button class="clk-shell-btn" id="clk-close-btn" title="Close">❌</button>
  `;
  overlay.appendChild(shellTop);

  /* Left panel: theme grid + tools + clock-theme picker */
  var panel = document.createElement('div');
  panel.id  = 'clk-panel';
  panel.innerHTML = `
    <button class="clk-pnl-btn" data-theme="light" title="Light theme">☀️</button>
    <button class="clk-pnl-btn" data-theme="dark"  title="Dark theme">🌑</button>
    <button class="clk-pnl-btn" data-theme="live"  title="Live sky">🌤️</button>
    <button class="clk-pnl-btn" data-theme="grey"  title="Grey sky">🌦️</button>
    <div style="position:relative" id="clk-weather-toggle-wrap">
      <button class="clk-pnl-btn" id="clk-weather-toggle-btn" title="Sky effects">🌏</button>
    </div>
    <div class="clk-pnl-sep"></div>
    <div style="position:relative">
      <button class="clk-pnl-btn" id="clk-theme-btn" title="Clock style">🕰️</button>
      <div id="clk-theme-menu">
        <button class="clk-theme-opt" data-clocktheme="digital">Digital clock</button>
        <button class="clk-theme-opt" data-clocktheme="digital-big">Big digital clock</button>
        <button class="clk-theme-opt" data-clocktheme="hybrid">Analog + digital</button>
        <button class="clk-theme-opt" data-clocktheme="analog">Analog clock</button>
        <button class="clk-theme-opt" data-clocktheme="analog-big">Big analog clock</button>
      </div>
    </div>
    <div class="clk-pnl-sep"></div>
    <button class="clk-pnl-btn clk-devpanel-btn" id="clk-dev-panel-btn" title="Developer panel">🛠️ Developer panel</button>
  `;
  overlay.appendChild(panel);

  /* Ring menu is appended directly to #clk-overlay, NOT inside #clk-panel.
     #clk-panel has a CSS transform (translateY), and per spec any
     transformed ancestor becomes the containing block for its
     position:fixed descendants — which was silently trapping the ring
     menu against the left-edge panel instead of centering on the real
     viewport. Living outside that ancestor fixes it for good. */
  var weatherRingMenu = document.createElement('div');
  weatherRingMenu.id  = 'clk-weather-ring-menu';
  overlay.appendChild(weatherRingMenu);

  /* Content */
  var content = document.createElement('div');
  content.id  = 'clk-content';
  content.innerHTML = `
    <div id="clk-digital-view" class="active">
      <div id="clk-time">
        <span id="clk-hm">12:00</span>
        <div id="clk-sec-wrap"><span id="clk-sec">00</span><span id="clk-ampm">AM</span></div>
      </div>
      <div id="clk-date">01-January-2026</div>
      <div id="clk-meta">
        <span id="clk-temp" style="display:none"></span>
        <span id="clk-city" style="display:none"></span>
        <span id="clk-wind" style="display:none"></span>
        <span id="clk-aqi"  style="display:none"></span>
      </div>
    </div>

    <div id="clk-analog-view">
      <canvas id="clk-analog-canvas"></canvas>
      <div id="clk-hybrid-digital">
        <span id="clk-hyb-hm">12:00</span>
        <div id="clk-hyb-sec-wrap"><span id="clk-hyb-sec">00</span><span id="clk-hyb-ampm">AM</span></div>
      </div>
      <div id="clk-date-analog" style="font-family:'Inter',system-ui,sans-serif;font-weight:500;opacity:.78;letter-spacing:.03em"></div>
      <div id="clk-meta-analog" style="font-family:'Inter',system-ui,sans-serif;font-weight:400;opacity:.6;display:flex;gap:10px;flex-wrap:wrap;justify-content:center"></div>
    </div>
  `;
  overlay.appendChild(content);

  /* Debug panel */
  var debugPanel = document.createElement('div');
  debugPanel.id  = 'clk-debug';
  debugPanel.innerHTML = `
    <div id="clk-debug-head">
      <span id="clk-debug-title">System status</span>
      <button id="clk-debug-close" aria-label="Close debug panel">✕</button>
    </div>
    <div class="clk-debug-row">
      <span class="clk-debug-label">📍 Geolocation (IP)</span>
      <span class="clk-debug-dot pending" id="clk-dbg-geo-dot"></span>
    </div>
    <div class="clk-debug-row">
      <span class="clk-debug-detail" id="clk-dbg-geo-detail" style="text-align:left;max-width:100%">Not yet checked</span>
    </div>
    <div class="clk-debug-row">
      <span class="clk-debug-label">🌤️ Weather API</span>
      <span class="clk-debug-dot pending" id="clk-dbg-weather-dot"></span>
    </div>
    <div class="clk-debug-row">
      <span class="clk-debug-detail" id="clk-dbg-weather-detail" style="text-align:left;max-width:100%">Not yet checked</span>
    </div>
    <div class="clk-debug-row">
      <span class="clk-debug-label">🫁 Air Quality API</span>
      <span class="clk-debug-dot pending" id="clk-dbg-aqi-dot"></span>
    </div>
    <div class="clk-debug-row">
      <span class="clk-debug-detail" id="clk-dbg-aqi-detail" style="text-align:left;max-width:100%">Not yet checked</span>
    </div>
    <div class="clk-debug-row" style="border-top:1px solid rgba(128,128,128,.25);margin-top:6px;padding-top:12px">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.75rem;font-weight:600;opacity:.9">
        <input type="checkbox" id="clk-dbg-gps-check" style="width:16px;height:16px;cursor:pointer"/>
        🌡️ Use my device location instead
      </label>
    </div>
    <div class="clk-debug-row">
      <span class="clk-debug-detail" id="clk-dbg-gps-detail" style="text-align:left;max-width:100%">If IP-based location keeps failing, check this box to allow your browser's GPS to provide it instead.</span>
    </div>

    <!-- ── Manual time override ─────────────────────────────── -->
    <div class="clk-debug-row" style="border-top:1px solid rgba(128,128,128,.25);margin-top:6px;padding-top:12px">
      <label class="clk-dbg-check">
        <input type="checkbox" id="clk-dbg-time-check"/>
        ⏱️ Manual time
      </label>
      <span class="clk-dbg-time-val" id="clk-dbg-time-val">--:--</span>
    </div>
    <div class="clk-debug-row" style="display:block">
      <input type="range" id="clk-dbg-time-slider" min="0" max="1439" step="1" value="169" disabled/>
      <span class="clk-debug-detail" style="text-align:left;max-width:100%">
        Overrides the clock, sky, and sun/moon position. Reverts to real time when unchecked or when this panel closes.
      </span>
    </div>

    <!-- ── 3D renderer diagnostics ──────────────────────────── -->
    <div class="clk-debug-row" style="border-top:1px solid rgba(128,128,128,.25);margin-top:6px;padding-top:12px">
      <span class="clk-debug-label">🌗 3D renderer</span>
      <span class="clk-debug-dot pending" id="clk-dbg-3d-dot"></span>
    </div>
    <div class="clk-debug-row" style="display:block">
      <span class="clk-dbg-mono" id="clk-dbg-3d-info">Not yet started</span>
    </div>
    <div class="clk-debug-row">
      <label class="clk-dbg-check">
        <input type="checkbox" id="clk-dbg-raw-check"/>
        🖼️ Show raw texture (no lighting)
      </label>
    </div>

  `;
  overlay.appendChild(debugPanel);

  document.body.appendChild(overlay);

  /* ════════════════════════════════════════════════════
     IDLE DETECTION — scroll only, per site owner's requirement
  ════════════════════════════════════════════════════ */
  function resetIdle() {
    if (isVisible) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(showClock, IDLE_MS);
  }
  window.addEventListener('scroll', resetIdle, { passive: true });
  resetIdle();

  /* ════════════════════════════════════════════════════
     SHOW / HIDE
  ════════════════════════════════════════════════════ */
  function showClock() {
    if (isVisible) return;
    isVisible = true;
    applyColorTheme(colorTheme);
    applyClockTheme(clockTheme);
    overlay.classList.add('clk-visible');
    startTick();
    if (!weatherFetched && cfg.enableWeather !== false) fetchWeatherAndAqi();
    startShellIdleWatch();
  }

  function hideClock() {
    if (!isVisible) return;
    isVisible = false;
    overlay.classList.remove('clk-visible');
    debugPanel.classList.remove('show');
    stopTick();
    cancelAnimationFrame(skyRaf);
    if (document.fullscreenElement) document.exitFullscreen().catch(function(){});
    stopShellIdleWatch();
    resetIdle();
  }

  /* ── Shell top-button (⛶ 🗖 ❌) auto-hide after 5s of no activity ──
     Only watches mouse/touch/scroll activity WHILE the clock overlay is
     open, and only affects those three buttons — never the left panel,
     never the clock face itself. Any movement/click/scroll/tap on the
     overlay instantly reveals them again. */
  var shellIdleTimer;
  function showShellButtons() {
    shellTop.classList.remove('clk-idle-hidden');
    clearTimeout(shellIdleTimer);
    shellIdleTimer = setTimeout(function () {
      shellTop.classList.add('clk-idle-hidden');
    }, 5000);
  }
  function startShellIdleWatch() {
    showShellButtons();
    ['mousemove', 'mousedown', 'touchstart', 'scroll', 'wheel'].forEach(function (ev) {
      overlay.addEventListener(ev, showShellButtons, { passive: true });
    });
  }
  function stopShellIdleWatch() {
    clearTimeout(shellIdleTimer);
    shellTop.classList.remove('clk-idle-hidden');
    ['mousemove', 'mousedown', 'touchstart', 'scroll', 'wheel'].forEach(function (ev) {
      overlay.removeEventListener(ev, showShellButtons);
    });
  }

  /* Exposed globally so any site UI — a custom button, a keyboard
     shortcut, anything — can open the clock programmatically. See
     also the window.ClockOverlay public API near the end of this file. */
  window.showClock = showClock;

  /* ════════════════════════════════════════════════════
     MINIMIZE / MAXIMIZE
  ════════════════════════════════════════════════════ */
  function setMinimized(min) {
    isMinimized = min;
    panel.classList.toggle('clk-hidden', min);
    document.getElementById('clk-theme-menu').classList.remove('show');
    document.getElementById('clk-min-btn').title = min ? 'Show settings' : 'Hide settings';
  }
  document.getElementById('clk-min-btn').addEventListener('click', function () {
    setMinimized(!isMinimized);
  });

  /* Start minimized so the very first open looks clean — the user can
     tap the ⚙️ gear to bring the settings panel out any time. */
  setMinimized(cfg.startMinimized === false ? false : true);

  /* ════════════════════════════════════════════════════
     CLOCK TICK (digital + analog both update from one loop)
  ════════════════════════════════════════════════════ */
  var hmEl   = document.getElementById('clk-hm');
  var secEl  = document.getElementById('clk-sec');
  var ampmEl = document.getElementById('clk-ampm');
  var dateEl = document.getElementById('clk-date');
  var dateAnalogEl = document.getElementById('clk-date-analog');
  var hybHmEl   = document.getElementById('clk-hyb-hm');
  var hybSecEl  = document.getElementById('clk-hyb-sec');
  var hybAmpmEl = document.getElementById('clk-hyb-ampm');

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function updateClock() {
    var now  = getClockNow();
    var h24  = now.getHours();
    var min  = now.getMinutes();
    var sec  = now.getSeconds();
    var ampm = h24 < 12 ? 'AM' : 'PM';
    var h12  = h24 % 12 || 12;

    hmEl.textContent   = pad(h12) + ':' + pad(min);
    secEl.textContent  = pad(sec);
    ampmEl.textContent = ampm;

    if (hybHmEl)   hybHmEl.textContent   = pad(h12) + ':' + pad(min);
    if (hybSecEl)  hybSecEl.textContent  = pad(sec);
    if (hybAmpmEl) hybAmpmEl.textContent = ampm;

    var dateStr = pad(now.getDate()) + '-' + MONTHS[now.getMonth()] + '-' + now.getFullYear();
    dateEl.textContent = dateStr;
    dateAnalogEl.textContent = dateStr;

    if (clockTheme === 'analog' || clockTheme === 'analog-big' || clockTheme === 'hybrid') {
      drawAnalogFace(now, h24, min, sec);
    }
  }

  function startTick() {
    updateClock();
    clockTick = setInterval(updateClock, 1000);
  }
  function stopTick() { clearInterval(clockTick); }

  /* ════════════════════════════════════════════════════
     COLOR THEME (page background: light/dark/live/grey)
  ════════════════════════════════════════════════════ */
  function applyColorTheme(t) {
    colorTheme = t;
    var classes = ['clk-visible', 'clk-' + t];
    if (clockTheme === 'digital-big') classes.push('clk-digital-big');
    overlay.className = classes.join(' ');
    document.querySelectorAll('.clk-pnl-btn[data-theme]').forEach(function (btn) {
      btn.classList.toggle('clk-active', btn.dataset.theme === t);
    });
    if (clockTheme === 'analog' || clockTheme === 'analog-big' || clockTheme === 'hybrid') {
      resizeAnalogCanvas();
      updateClock();
    }

    if (t === 'live' || t === 'grey') {
      startSkyEngine();
    } else {
      stopSkyEngine();
    }
  }
  panel.querySelectorAll('.clk-pnl-btn[data-theme]').forEach(function (btn) {
    btn.addEventListener('click', function () { applyColorTheme(btn.dataset.theme); });
  });

  /* ════════════════════════════════════════════════════
     CLOCK THEME (digital / digital-big / hybrid / analog / analog-big)
  ════════════════════════════════════════════════════ */
  var digitalView = document.getElementById('clk-digital-view');
  var analogView  = document.getElementById('clk-analog-view');

  function applyClockTheme(t) {
    clockTheme = t;

    var isDigital = (t === 'digital' || t === 'digital-big');
    var isAnalog  = (t === 'analog' || t === 'analog-big' || t === 'hybrid');

    digitalView.classList.toggle('active', isDigital);
    analogView.classList.toggle('active', isAnalog);

    overlay.classList.toggle('clk-digital-big', t === 'digital-big');
    overlay.classList.toggle('clk-hybrid-active', t === 'hybrid');

    document.querySelectorAll('.clk-theme-opt').forEach(function (btn) {
      btn.classList.toggle('clk-active', btn.dataset.clocktheme === t);
    });

    if (isAnalog) {
      resizeAnalogCanvas();
      updateClock();
    }

    document.getElementById('clk-theme-menu').classList.remove('show');
  }

  document.getElementById('clk-theme-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    document.getElementById('clk-theme-menu').classList.toggle('show');
  });
  document.querySelectorAll('.clk-theme-opt').forEach(function (btn) {
    btn.addEventListener('click', function () { applyClockTheme(btn.dataset.clocktheme); });
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#clk-theme-btn, #clk-theme-menu')) {
      document.getElementById('clk-theme-menu').classList.remove('show');
    }
  });

  /* ════════════════════════════════════════════════════
     ANALOG CLOCK RENDERER (canvas) — shared by analog,
     analog-big, and hybrid themes. Blue/white futuristic
     style matching the site's design language.
  ════════════════════════════════════════════════════ */
  var analogCanvas = document.getElementById('clk-analog-canvas');
  var actx = analogCanvas.getContext('2d');

  function analogSizeFor(theme) {
    if (theme === 'analog-big') {
      return Math.min(window.innerWidth * 0.72, window.innerHeight * 0.72);
    }
    if (theme === 'hybrid') {
      return Math.min(window.innerWidth * 0.42, window.innerHeight * 0.42, 380);
    }
    /* plain 'analog' — 50% viewport */
    return Math.min(window.innerWidth * 0.46, window.innerHeight * 0.46, 460);
  }

  function resizeAnalogCanvas() {
    var size = analogSizeFor(clockTheme);
    var dpr  = window.devicePixelRatio || 1;
    analogCanvas.style.width  = size + 'px';
    analogCanvas.style.height = size + 'px';
    analogCanvas.width  = size * dpr;
    analogCanvas.height = size * dpr;
    actx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', function () {
    if (clockTheme === 'analog' || clockTheme === 'analog-big' || clockTheme === 'hybrid') {
      resizeAnalogCanvas();
      updateClock();
    }
  });

  function drawAnalogFace(now, h24, min, sec) {
    var size = analogSizeFor(clockTheme);
    var cx = size / 2, cy = size / 2, R = size / 2 - size * 0.06;

    var light = (colorTheme === 'light');
    var isHybrid = (clockTheme === 'hybrid');

    var faceStroke = light ? 'rgba(26,79,214,.14)' : 'rgba(255,255,255,.10)';
    var faceFillIn = light ? 'rgba(255,255,255,.6)'  : 'rgba(255,255,255,.03)';
    var tickColor  = light ? 'rgba(15,30,54,.28)'   : 'rgba(255,255,255,.28)';
    var hourHand   = light ? '#0f1e36' : '#e8ecf5';
    var minHand    = light ? '#4a5578' : '#c4cbe0';
    var secHand    = '#4d5fe0';
    var centerDot  = '#4d5fe0';

    actx.clearRect(0, 0, size, size);

    /* Soft glow ring behind the face (subtle, matches reference's glow halo) */
    var glow = actx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.15);
    glow.addColorStop(0, light ? 'rgba(26,79,214,.05)' : 'rgba(77,95,224,.10)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    actx.beginPath();
    actx.arc(cx, cy, R * 1.15, 0, Math.PI * 2);
    actx.fillStyle = glow;
    actx.fill();

    /* Face circle, no numerals — minimalist per reference */
    actx.beginPath();
    actx.arc(cx, cy, R, 0, Math.PI * 2);
    actx.fillStyle = faceFillIn;
    actx.fill();
    actx.lineWidth = size * 0.006;
    actx.strokeStyle = faceStroke;
    actx.stroke();

    /* Only 4 short tick marks at 12/3/6/9, matching reference's minimalism */
    [0, 90, 180, 270].forEach(function (deg) {
      var a = (deg / 360) * Math.PI * 2 - Math.PI / 2;
      var r1 = R - size * 0.05;
      var r2 = R + size * 0.008;
      actx.beginPath();
      actx.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      actx.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
      actx.strokeStyle = tickColor;
      actx.lineWidth = size * 0.006;
      actx.lineCap = 'round';
      actx.stroke();
    });

    /* Hands — thin, tapered, minimalist */
    var secFrac  = sec / 60;
    var minFrac  = (min + secFrac) / 60;
    var hourFrac = ((h24 % 12) + minFrac) / 12;

    drawHand(hourFrac, R * 0.52, size * 0.018, hourHand);
    drawHand(minFrac,  R * 0.76, size * 0.014, minHand);
    if (!isHybrid) drawHand(secFrac, R * 0.84, size * 0.005, secHand);

    function drawHand(frac, len, width, color) {
      var ang = frac * Math.PI * 2 - Math.PI / 2;
      actx.beginPath();
      actx.moveTo(cx, cy);
      actx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
      actx.strokeStyle = color;
      actx.lineWidth = width;
      actx.lineCap = 'round';
      actx.stroke();
    }

    /* Center dot */
    actx.beginPath();
    actx.arc(cx, cy, size * 0.016, 0, Math.PI * 2);
    actx.fillStyle = centerDot;
    actx.fill();

    /* Small sun/moon indicator, top-right of face — matches reference exactly */
    var isNight = (h24 >= 19 || h24 < 6);
    var iconR = size * 0.075;
    var iconX = cx + R * 0.78, iconY = cy - R * 0.78;
    actx.beginPath();
    actx.arc(iconX, iconY, iconR, 0, Math.PI * 2);
    actx.fillStyle = light ? 'rgba(26,79,214,.06)' : 'rgba(255,255,255,.06)';
    actx.fill();

    if (isNight) {
      /* crescent moon */
      actx.beginPath();
      actx.arc(iconX, iconY, iconR * 0.55, 0, Math.PI * 2);
      actx.fillStyle = '#4d5fe0';
      actx.fill();
      actx.beginPath();
      actx.arc(iconX + iconR * 0.28, iconY - iconR * 0.12, iconR * 0.5, 0, Math.PI * 2);
      actx.fillStyle = light ? '#f8faff' : '#12182e';
      actx.fill();
    } else {
      /* small sun */
      actx.beginPath();
      actx.arc(iconX, iconY, iconR * 0.4, 0, Math.PI * 2);
      actx.fillStyle = '#f2a83c';
      actx.fill();
      for (var ri = 0; ri < 8; ri++) {
        var ra = (ri / 8) * Math.PI * 2;
        var rr1 = iconR * 0.58, rr2 = iconR * 0.78;
        actx.beginPath();
        actx.moveTo(iconX + Math.cos(ra) * rr1, iconY + Math.sin(ra) * rr1);
        actx.lineTo(iconX + Math.cos(ra) * rr2, iconY + Math.sin(ra) * rr2);
        actx.strokeStyle = '#f2a83c';
        actx.lineWidth = size * 0.004;
        actx.lineCap = 'round';
        actx.stroke();
      }
    }
  }

  /* ════════════════════════════════════════════════════
     FULLSCREEN + CLOSE
  ════════════════════════════════════════════════════ */
  document.getElementById('clk-close-btn').addEventListener('click', hideClock);
  document.getElementById('clk-fs-btn').addEventListener('click', function () {
    if (!document.fullscreenElement) {
      overlay.requestFullscreen && overlay.requestFullscreen().catch(function(){});
    } else {
      document.exitFullscreen && document.exitFullscreen().catch(function(){});
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isVisible) hideClock();
  });

  /* ════════════════════════════════════════════════════
     DEVELOPER PANEL — opened via the visible button inside the
     settings panel (no hidden tap gesture anymore).
  ════════════════════════════════════════════════════ */
  function openDeveloperPanel() {
    debugPanel.classList.add('show');
    dbg.open = true;
    refreshDebugPanel();
    startDebugReadout();
  }
  document.getElementById('clk-dev-panel-btn').addEventListener('click', openDeveloperPanel);
  document.getElementById('clk-debug-close').addEventListener('click', function () {
    debugPanel.classList.remove('show');
    closeDebugPanel();
  });

  /* Closing the panel must fully revert any debug-only state, per spec:
     the manual time override lives only as long as the panel is open. */
  function closeDebugPanel() {
    dbg.open = false;
    dbg.manualTime = false;
    dbg.rawTexture = false;
    var tc = document.getElementById('clk-dbg-time-check');
    var rc = document.getElementById('clk-dbg-raw-check');
    var ts = document.getElementById('clk-dbg-time-slider');
    if (tc) tc.checked = false;
    if (rc) rc.checked = false;
    if (ts) ts.disabled = true;
    stopDebugReadout();
  }

  /* ── Manual time override controls ── */
  (function wireTimeOverride() {
    var check  = document.getElementById('clk-dbg-time-check');
    var slider = document.getElementById('clk-dbg-time-slider');
    var valEl  = document.getElementById('clk-dbg-time-val');

    function minutesToLabel(mins) {
      var hh = Math.floor(mins / 60), mm = mins % 60;
      var ampm = hh >= 12 ? 'PM' : 'AM';
      var h12 = hh % 12; if (h12 === 0) h12 = 12;
      return (h12 < 10 ? '0' : '') + h12 + ':' + (mm < 10 ? '0' : '') + mm + ' ' + ampm;
    }

    function syncFromSlider() {
      var mins = parseInt(slider.value, 10) || 0;
      dbg.manualHours = mins / 60;          /* 0..24 float */
      valEl.textContent = minutesToLabel(mins);
    }

    check.addEventListener('change', function (e) {
      dbg.manualTime = e.target.checked;
      slider.disabled = !e.target.checked;
      if (e.target.checked) {
        /* Seed the slider at the current real time so it starts where you are */
        var n = new Date();
        slider.value = String(n.getHours() * 60 + n.getMinutes());
        syncFromSlider();
      } else {
        valEl.textContent = '--:--';
      }
    });

    slider.addEventListener('input', syncFromSlider);
  })();

  /* ── Raw texture toggle ── */
  document.getElementById('clk-dbg-raw-check').addEventListener('change', function (e) {
    dbg.rawTexture = e.target.checked;
  });

  /* ── Live 3D / phase diagnostics ──────────────────────────────────
     Updates ~4x/sec while the debug panel is open. This is what tells
     us whether Three.js loaded, whether each texture arrived, where the
     sphere is being placed, and what the lighting math is doing. */
  var dbgReadoutTimer = null;

  function phaseName(frac) {
    if (frac < 0.03 || frac > 0.97) return 'New';
    if (frac < 0.22) return 'Waxing crescent';
    if (frac < 0.28) return 'First quarter';
    if (frac < 0.47) return 'Waxing gibbous';
    if (frac < 0.53) return 'Full';
    if (frac < 0.72) return 'Waning gibbous';
    if (frac < 0.78) return 'Last quarter';
    return 'Waning crescent';
  }

  function updateDebugReadout() {
    var dot  = document.getElementById('clk-dbg-3d-dot');
    var info = document.getElementById('clk-dbg-3d-info');
    if (!dot || !info) return;

    /* Status light: green = 3D actively drawing, amber = loading,
       red = Three.js failed to load (stuck on 2D fallback). */
    var cls = 'pending', lines = [];
    if (!threeReady && !threeLoading) {
      cls = 'pending';
      lines.push('three.js: not started');
    } else if (!threeReady && threeLoading) {
      cls = 'pending';
      lines.push('three.js: loading…');
    } else if (threeReady && !threeRenderer) {
      cls = 'fail';
      lines.push('three.js: loaded, renderer FAILED');
    } else if (threeReady && threeRenderer) {
      var drawing = !!celestial3D &&
        ((celestial3D.type === 'moon' && moonTexReady) ||
         (celestial3D.type === 'sun'  && sunTexReady));
      cls = drawing ? 'ok' : 'pending';
      lines.push('three.js: ready  webgl: ok');
    }

    lines.push('moon texture: ' + (moonTexReady ? 'loaded' : 'MISSING (' + MOON_TEXTURE_URL + ')'));
    lines.push('sun texture:  ' + (sunTexReady  ? 'loaded' : 'MISSING (' + SUN_TEXTURE_URL + ')'));
    lines.push('size mult:    ' + CELESTIAL_SIZE_MULT.toFixed(2) + 'x');

    var n = getClockNow();
    lines.push('clock:        ' + (isTimeOverridden() ? 'MANUAL ' : 'device ') +
               ('0' + n.getHours()).slice(-2) + ':' + ('0' + n.getMinutes()).slice(-2));

    var frac  = getMoonPhaseFrac();
    var illum = getMoonIllum(frac);
    lines.push('phaseFrac:    ' + frac.toFixed(4) + '  (' + phaseName(frac) + ')');
    lines.push('illum:        ' + (illum * 100).toFixed(1) + '%');
    lines.push('hemisphere:   ' + (isSouthernHemi() ? 'southern' : 'northern'));

    var sd = getMoonSunDir();
    lines.push('sunDir:       ' +
      sd.x.toFixed(2) + ', ' + sd.y.toFixed(2) + ', ' + sd.z.toFixed(2));

    if (celestial3D) {
      lines.push('drawing:      ' + celestial3D.type +
                 ' @ ' + Math.round(celestial3D.x) + ',' + Math.round(celestial3D.y) +
                 '  r=' + celestial3D.r.toFixed(1));
    } else {
      lines.push('drawing:      (nothing on screen)');
    }

    var mr = (celestial3D && celestial3D.type === 'sun') ? sunManualRot : moonManualRot;
    lines.push('rotation:     y=' + (mr.y % (Math.PI * 2)).toFixed(2) +
               ' x=' + (mr.x % (Math.PI * 2)).toFixed(2) +
               (dragState.active ? '  [DRAGGING]' : ''));

    dot.className = 'clk-debug-dot ' + cls;
    info.textContent = lines.join('\n');
  }

  function startDebugReadout() {
    if (dbgReadoutTimer) return;
    updateDebugReadout();
    dbgReadoutTimer = setInterval(updateDebugReadout, 250);
  }
  function stopDebugReadout() {
    if (!dbgReadoutTimer) return;
    clearInterval(dbgReadoutTimer);
    dbgReadoutTimer = null;
  }

  /* GPS fallback checkbox — only used if the visitor manually opts in
     via the debug panel. IP-based lookup remains the silent default
     for everyone else; this never triggers on its own. */
  document.getElementById('clk-dbg-gps-check').addEventListener('change', function (e) {
    var gpsDetailEl = document.getElementById('clk-dbg-gps-detail');
    if (!e.target.checked) {
      gpsDetailEl.textContent = 'If IP-based location keeps failing, check this box to allow your browser\'s GPS to provide it instead.';
      return;
    }
    if (!navigator.geolocation) {
      gpsDetailEl.textContent = 'This browser does not support device location.';
      e.target.checked = false;
      return;
    }
    gpsDetailEl.textContent = 'Requesting device location…';
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        geoData = { lat: pos.coords.latitude, lon: pos.coords.longitude, city: 'Your device location' };
        gpsDetailEl.textContent = 'Device location acquired (' + pos.coords.latitude.toFixed(2) + ', ' + pos.coords.longitude.toFixed(2) + ')';
        setDebugRow('geo', true, 'Device GPS (' + pos.coords.latitude.toFixed(2) + ', ' + pos.coords.longitude.toFixed(2) + ')');
        var cityEl = document.getElementById('clk-city');
        if (cityEl) { cityEl.textContent = '📍 Your location'; cityEl.style.display = 'inline'; }
        fetchWeatherFromCoords(pos.coords.latitude, pos.coords.longitude);
      },
      function (err) {
        gpsDetailEl.textContent = 'Location request denied or failed: ' + err.message;
        e.target.checked = false;
      }
    );
  });

  function setDebugRow(key, ok, detail) {
    apiStatus[key] = { ok: ok, detail: detail };
    var dot = document.getElementById('clk-dbg-' + key + '-dot');
    var det = document.getElementById('clk-dbg-' + key + '-detail');
    if (dot) dot.className = 'clk-debug-dot ' + (ok === null ? 'pending' : ok ? 'ok' : 'fail');
    if (det) det.textContent = detail;
  }

  function refreshDebugPanel() {
    setDebugRow('geo', apiStatus.geo.ok, apiStatus.geo.detail);
    setDebugRow('weather', apiStatus.weather.ok, apiStatus.weather.detail);
    setDebugRow('aqi', apiStatus.aqi.ok, apiStatus.aqi.detail);
  }

  /* Exposed so the weather-fetch chunk (landing later) can report
     status here without needing to touch this file again. */
  window.__clkSetApiStatus = setDebugRow;

  /* ════════════════════════════════════════════════════
     WEATHER + AQI FETCH  (ipwho.is → open-meteo → open-meteo air-quality)
     All calls are best-effort: on any failure the relevant meta line
     simply stays hidden (never shows an error to the visitor), while
     the debug panel (5-tap logo) records exactly what happened for
     the site owner to check.

     SWAPPED from ip-api.com to ipwho.is: ip-api.com's free tier
     proved unreliable over HTTPS from real visitor networks (shared
     carrier-NAT IPs hitting free-tier rate limits). ipwho.is is fully
     free, HTTPS-native, no API key, with more generous limits.
  ════════════════════════════════════════════════════ */
  function fetchWeatherAndAqi() {
    weatherFetched = true;

    fetch('https://ipwho.is/')
      .then(function (r) { return r.json(); })
      .then(function (geo) {
        if (!geo.success) {
          setDebugRow('geo', false, 'ipwho.is responded but success was false');
          syncAnalogMeta();
          return;
        }
        geoData = { lat: geo.latitude, lon: geo.longitude, city: geo.city };
        setDebugRow('geo', true, geo.city + ' (' + geo.latitude.toFixed(2) + ', ' + geo.longitude.toFixed(2) + ')');

        var cityEl = document.getElementById('clk-city');
        if (cityEl) { cityEl.textContent = '📍 ' + geo.city; cityEl.style.display = 'inline'; }

        fetchWeatherFromCoords(geo.latitude, geo.longitude);
      })
      .catch(function () {
        setDebugRow('geo', false, 'ipwho.is request failed or was blocked');
        syncAnalogMeta();
      });
  }

  /* Shared weather + AQI fetch, used by both the automatic IP-based path
     above and the manual GPS fallback (debug panel 🌡️ checkbox) below.
     Takes explicit coordinates so either source can drive it. */
  function fetchWeatherFromCoords(lat, lon) {
    fetch(
      'https://api.open-meteo.com/v1/forecast?latitude=' + lat
      + '&longitude=' + lon
      + '&current_weather=true&windspeed_unit=kmh&temperature_unit=celsius'
    )
      .then(function (r) { return r.json(); })
      .then(function (wx) {
        if (!wx.current_weather) {
          setDebugRow('weather', false, 'open-meteo.com responded without current_weather field');
          syncAnalogMeta();
          return;
        }
        var cw = wx.current_weather;
        weatherData = {
          temp: Math.round(cw.temperature),
          windKph: Math.round(cw.windspeed),
          code: cw.weathercode,
          isDay: cw.is_day
        };
        setDebugRow('weather', true, weatherData.temp + '°C, ' + weatherData.windKph + 'km/h wind, code ' + weatherData.code);

        var tempEl = document.getElementById('clk-temp');
        var windEl = document.getElementById('clk-wind');
        if (tempEl) { tempEl.textContent = weatherData.temp + '°C'; tempEl.style.display = 'inline'; }
        if (windEl) { windEl.textContent = '💨 ' + weatherData.windKph + 'km/h'; windEl.style.display = 'inline'; }

        applyAutoEffectDefaults(weatherData.code);

        return fetch(
          'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lat
          + '&longitude=' + lon + '&current=us_aqi'
        );
      })
      .then(function (r) { return r && r.json(); })
      .then(function (aq) {
        if (!aq || !aq.current || typeof aq.current.us_aqi !== 'number') {
          setDebugRow('aqi', false, 'air-quality-api.open-meteo.com had no us_aqi value');
          syncAnalogMeta();
          return;
        }
        var val = Math.round(aq.current.us_aqi);
        var label = val <= 50 ? 'Good' : val <= 100 ? 'Moderate' : val <= 150 ? 'Unhealthy (SG)' :
                    val <= 200 ? 'Unhealthy' : val <= 300 ? 'Very unhealthy' : 'Hazardous';
        aqiData = { aqi: val, label: label };
        setDebugRow('aqi', true, 'AQI ' + val + ' — ' + label);

        var aqiEl = document.getElementById('clk-aqi');
        if (aqiEl) { aqiEl.textContent = '🫁 AQI ' + val; aqiEl.style.display = 'inline'; }
        syncAnalogMeta();
      })
      .catch(function () {
        /* Silent by design — no error shown to the visitor at any stage */
        syncAnalogMeta();
      });
  }

  /* The analog clock theme has its own separate meta row (#clk-meta-analog)
     since it sits below the canvas rather than below the digital display.
     This copies whatever weather data successfully loaded into that row too. */
  function syncAnalogMeta() {
    var wrap = document.getElementById('clk-meta-analog');
    if (!wrap) return;
    var parts = [];
    if (geoData) parts.push('📍 ' + geoData.city);
    if (weatherData) parts.push(weatherData.temp + '°C');
    if (weatherData) parts.push('💨 ' + weatherData.windKph + 'km/h');
    if (aqiData) parts.push('🫁 AQI ' + aqiData.aqi);
    wrap.innerHTML = parts.map(function (p) {
      return '<span class="clk-meta-item">' + p + '</span>';
    }).join('');
  }

  /* Weather-code-based suggested defaults. User can still override any
     individual effect via the ring menu afterward. */
  function applyAutoEffectDefaults(code) {
    var isRain    = (code >= 51 && code <= 67) || (code >= 80 && code <= 82);
    var isSnow    = (code >= 71 && code <= 77) || (code >= 85 && code <= 86);
    var isThunder = (code >= 95);
    var isFog     = (code === 45 || code === 48);
    var isClear   = (code === 0 || code === 1);

    skyEffects.rain    = isRain || isThunder;
    skyEffects.thunder = isThunder;
    skyEffects.snow    = isSnow;
    skyEffects.fog     = isFog;
    skyEffects.cloud   = !isClear;
    skyEffects.breeze  = true;
    skyEffects.wave    = true;
    skyEffects.night   = true;

    rebuildWeatherRingMenu();
  }

  /* ════════════════════════════════════════════════════
     🌏 CIRCULAR EFFECT RING MENU
  ════════════════════════════════════════════════════ */
  var RING_ITEMS = [
    { key: 'cloud',   icon: '☁️',  label: 'Cloud' },
    { key: 'rain',    icon: '🌧️', label: 'Rain' },
    { key: 'breeze',  icon: '💨',  label: 'Air breeze' },
    { key: 'thunder', icon: '⛈️', label: 'Thunder' },
    { key: 'snow',    icon: '❄️',  label: 'Snow' },
    { key: 'fog',     icon: '🌫️', label: 'Fog' },
    { key: 'wave',    icon: '🌊',  label: 'Ocean wave' },
    { key: 'night',   icon: '✨',  label: 'Night sky' }
  ];

  function rebuildWeatherRingMenu() {
    var menu = document.getElementById('clk-weather-ring-menu');
    menu.innerHTML = '';

    var center = document.createElement('div');
    center.className = 'clk-wring-center' + (skyEffects.master ? '' : ' off');
    center.textContent = '🌏';
    center.title = 'Toggle all sky effects';
    center.addEventListener('click', function (e) {
      e.stopPropagation();
      skyEffects.master = !skyEffects.master;
      center.classList.toggle('off', !skyEffects.master);
      menu.querySelectorAll('.clk-wring-item').forEach(function (el) {
        el.classList.toggle('off', !skyEffects.master);
      });
    });
    menu.appendChild(center);

    var radius = 88;
    RING_ITEMS.forEach(function (item, i) {
      var angle = (i / RING_ITEMS.length) * Math.PI * 2 - Math.PI / 2;
      var x = 110 + Math.cos(angle) * radius - 23;
      var y = 110 + Math.sin(angle) * radius - 23;

      var el = document.createElement('div');
      el.className = 'clk-wring-item' + (skyEffects[item.key] && skyEffects.master ? '' : ' off');
      el.style.left = x + 'px';
      el.style.top  = y + 'px';
      el.textContent = item.icon;
      el.title = item.label;
      el.addEventListener('click', function (e) {
        e.stopPropagation();
        skyEffects[item.key] = !skyEffects[item.key];
        el.classList.toggle('off', !(skyEffects[item.key] && skyEffects.master));
      });
      menu.appendChild(el);
    });
  }
  rebuildWeatherRingMenu();

  document.getElementById('clk-weather-toggle-btn').addEventListener('click', function (e) {
    e.stopPropagation();
    document.getElementById('clk-weather-ring-menu').classList.toggle('show');
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#clk-weather-toggle-wrap, #clk-weather-ring-menu')) {
      document.getElementById('clk-weather-ring-menu').classList.remove('show');
    }
  });

  /* Exposed globally so the Chunk 5 sky-effects renderer can read live
     state without this file needing to change again. */
  window.__clkGetSkyEffects = function () { return skyEffects; };
  window.__clkGetWeatherData = function () { return weatherData; };

  /* ════════════════════════════════════════════════════
     SKY ENGINE — 9 canvas weather/atmosphere effects
     Reads live toggle state from skyEffects and weatherData
     (both set up in Chunk 4). Runs only while colorTheme is
     'live' or 'grey', paused entirely otherwise for performance.
  ════════════════════════════════════════════════════ */
  var skyCtx, skyRaf, skyT = 0;
  var skyW = 0, skyH = 0;

  /* Sun/Moon hover + click interaction — celestialHit is recomputed every
     frame by drawSunMoon() so we always test against where it's actually
     drawn right now, not a stale position. */
  var celestialHit   = null;  /* {type:'sun'|'moon', x, y, r} or null when neither is on screen */
  var celestialHover = null;  /* 'sun' | 'moon' | null */
  var celestialBurst = null;  /* {type, start} while a 2s click-burst is playing */

  function celestialBoost(type) {
    var scale = 1, glowMult = 1;
    if (celestialBurst && celestialBurst.type === type) {
      var el = (Date.now() - celestialBurst.start) / 1000;
      if (el <= 2) {
        var k = 1 - (el / 2); /* 1 → 0 over the 2s burst */
        scale    += 0.10 * k;
        glowMult += 1.00 * k; /* up to 2x brightness/spread right at click, easing out */
      } else {
        celestialBurst = null;
      }
    }
    if (celestialHover === type) {
      scale    += 0.04;
      glowMult += 0.6;
    }
    return { scale: scale, glowMult: glowMult };
  }

  var stars = [], clouds = [], rainDrops = [], snowFlakes = [];
  var comets = [], starTrails = [];
  var lastThunderCheck = 0, thunderFlashUntil = 0, nextThunderAt = 0;
  var thunderBoltX = 0, thunderBoltBig = false;
  var lastCometAt = 0, nextCometAt = 0;
  var lastTrailAt = 0, nextTrailAt = 0;

  function initSkyEngine() {
    skyCtx = sky.getContext('2d');
    resizeSky();
    window.addEventListener('resize', resizeSky);
    buildStars();
    buildClouds();
    scheduleThunder();
    scheduleComet();
    scheduleTrail();
  }

  function resizeSky() {
    skyW = window.innerWidth;
    skyH = window.innerHeight;
    sky.width  = skyW;
    sky.height = skyH;
    /* NOTE: cloud art is deliberately NOT invalidated here. A baked cloud
       texture is resolution-independent — it's scaled by drawImage — so a
       resize only changes how big it is drawn, not what it should look
       like. Re-baking on every resize event would stutter while the user
       drags a window edge; instead the cloud draw block re-bakes only if
       the detail scale has drifted far enough to actually be visible. */
    if (threeRenderer) resize3D();
  }

  function buildStars() {
    stars = [];
    for (var i = 0; i < 180; i++) {
      stars.push({
        x: Math.random(), y: Math.random() * 0.7,
        r: 0.4 + Math.random() * 1.3,
        tw: 0.5 + Math.random() * 1.6,
        ph: Math.random() * Math.PI * 2
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     CLOUDS — hybrid "puff silhouette + fBm noise" renderer.

     Each cloud's artwork is baked ONCE into a small offscreen canvas and
     then simply blitted each frame, so the per-frame cost is a single
     drawImage instead of the old five arc() calls + a canvas filter.
     The bake happens lazily, at most one cloud per frame (see the draw
     block), so opening the overlay never stalls on a burst of work.

     Sizing note: every cloud is sized from min(skyW, skyH). The previous
     code derived the "giant" size from skyH but expressed it as a
     fraction of skyW, which on a portrait phone produced a cloud wider
     than the screen. Sizing off the smaller axis is orientation-proof.
  ═══════════════════════════════════════════════════════════════════ */
  var CLOUD_TEX_W = 208, CLOUD_TEX_H = 104;  // bake resolution (GPU upscales)
  var CLOUD_ASPECT = 2.6;                    // drawn width = height * this

  function buildClouds() {
    clouds = [];
    /* Cloud HEIGHT as a fraction of the SMALLER viewport axis:
       small ≈ 4.5–6.5%, medium ≈ 7–10%, giant ≈ 11–14%. */
    for (var i = 0; i < 8; i++) {
      var crossSec = 30 + Math.random() * 60;
      var roll = Math.random();
      var hFrac;
      if (roll < 0.45) {
        hFrac = 0.045 + Math.random() * 0.020;        // small
      } else if (roll < 0.85) {
        hFrac = 0.070 + Math.random() * 0.030;        // medium
      } else {
        hFrac = 0.110 + Math.random() * 0.030;        // giant
      }
      clouds.push({
        x: Math.random() * 1.3 - 0.15,
        y: 0.03 + Math.random() * 0.20,
        hf: hFrac,
        sp: 1.15 / (crossSec * 60),
        opPhase: Math.random() * Math.PI * 2,
        opSpeed: 0.05 + Math.random() * 0.12,
        seed: Math.random() * 100,
        tex: null,        // baked artwork (built lazily)
        texGrey: false,   // which theme the current bake was made for
        texFs: 0          // which detail scale the current bake was made for
      });
    }
  }

  /* Throw away baked cloud art so it re-bakes (lazily, one per frame). */
  function invalidateCloudTextures() {
    for (var i = 0; i < clouds.length; i++) clouds[i].tex = null;
  }

  /* fBm on top of the simplex noise already used by the fog engine. */
  function cloudFbm(x, y, z, oct) {
    var sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (var o = 0; o < oct; o++) {
      sum  += amp * fogNoise3D(x * freq, y * freq, z * freq);
      norm += amp;
      amp  *= 0.5;
      freq *= 2.03;
    }
    return sum / norm;                                   // ≈ -1 … 1
  }
  function cloudClamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  /* Bake one cloud:
       1. draw a random 12–18 puff cumulus silhouette WITH a blur applied,
          turning the hard vector shape into a soft 0–1 density field;
       2. erode that field with low-frequency fBm so the smooth vector edge
          dissolves into wisps while the dense core survives;
       3. add mid/high-frequency fBm for billow lumps and cotton grain;
       4. shade by depth below each column's lit crown, modulated by the
          same noise, so billows read as catching or missing the light. */
  function makeCloudTexture(w, h, seed, fs, grey) {
    var mask = document.createElement('canvas');
    mask.width = w; mask.height = h;
    var mctx = mask.getContext('2d');

    var n = 12 + Math.floor(Math.random() * 7), baseY = h * 0.70;
    mctx.filter = 'blur(' + (h * 0.085) + 'px)';
    mctx.beginPath();
    for (var p = 0; p < n; p++) {
      var t = p / (n - 1), arch = Math.sin(t * Math.PI);
      var r  = h * (0.13 + arch * 0.20) * (0.75 + Math.random() * 0.5);
      var px = w * (0.08 + t * 0.84) + (Math.random() - 0.5) * w * 0.05;
      var py = baseY - arch * h * 0.26 - Math.random() * h * 0.10;
      mctx.moveTo(px + r, py);
      mctx.arc(px, py, r, 0, Math.PI * 2);
    }
    mctx.rect(w * 0.06, baseY - h * 0.05, w * 0.88, h * 0.10);   // flat base
    mctx.fillStyle = '#fff';
    mctx.fill();

    var md  = mctx.getImageData(0, 0, w, h).data;
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var octx = out.getContext('2d');
    var img  = octx.createImageData(w, h), d = img.data;
    var alpha = new Float32Array(w * h), detail = new Float32Array(w * h);

    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        var idx = j * w + i, F = md[idx * 4 + 3] / 255;
        if (F <= 0.004) { alpha[idx] = 0; continue; }
        var nx = i / w, ny = j / h;
        var nLow  = (cloudFbm(nx * 2.9  * fs + seed,       ny * 1.7 * fs + seed * 0.6, seed * 1.7, 3) + 1) * 0.5;
        var nMid  = (cloudFbm(nx * 5.5  * fs + seed * 1.5, ny * 3.4 * fs + seed * 0.3, seed * 2.5, 3) + 1) * 0.5;
        var nHigh = (cloudFbm(nx * 11.0 * fs + seed * 2.1, ny * 7.0 * fs + seed,       seed * 3.3, 2) + 1) * 0.5;
        var dens = F * (0.56 + 0.94 * nLow) + (nMid - 0.5) * 0.32 + (nHigh - 0.5) * 0.12;
        var a = (dens - 0.40) / 0.15;
        if (ny > 0.60 && ny < 0.80) a += (1 - Math.abs(ny - 0.70) / 0.10) * 0.16;
        alpha[idx]  = cloudClamp(a, 0, 1);
        detail[idx] = nMid * 0.65 + nHigh * 0.35;
      }
    }

    /* top-lit volumetric shading */
    var topY = new Int16Array(w);
    for (var i2 = 0; i2 < w; i2++) {
      topY[i2] = -1;
      for (var j2 = 0; j2 < h; j2++) {
        if (alpha[j2 * w + i2] > 0.06) { topY[i2] = j2; break; }
      }
    }
    var tint = grey ? 0.90 : 1;                       // grey theme = cooler art
    for (var j3 = 0; j3 < h; j3++) {
      for (var i3 = 0; i3 < w; i3++) {
        var id2 = j3 * w + i3, av = alpha[id2], o = id2 * 4;
        if (av <= 0) { d[o + 3] = 0; continue; }
        var ty = topY[i3] < 0 ? j3 : topY[i3];
        var depth = cloudClamp((j3 - ty) / (h * 0.55), 0, 1);
        var lum = 1 - depth * 0.52;
        lum = cloudClamp(lum * (0.70 + 0.60 * detail[id2]), 0, 1);
        var shade = 0.62 + 0.38 * lum;
        d[o]     = cloudClamp((255 * lum * shade + 38 * (1 - lum)) * tint, 0, 255);
        d[o + 1] = cloudClamp(((252 - 6 * depth) * lum * shade + 44 * (1 - lum)) * tint, 0, 255);
        d[o + 2] = cloudClamp(((255 - 2 * depth) * lum * shade + 62 * (1 - lum)) * (grey ? 0.94 : 1), 0, 255);
        d[o + 3] = av * 245;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  function buildRain() {
    rainDrops = [];
    for (var i = 0; i < 140; i++) {
      rainDrops.push({
        x: Math.random(), y: Math.random(),
        sp: 0.004 + Math.random() * 0.005,
        len: 0.02 + Math.random() * 0.035,
        op: 0.3 + Math.random() * 0.4,
        drift: (Math.random() - 0.5) * 0.001
      });
    }
  }

  function buildSnow() {
    snowFlakes = [];
    for (var i = 0; i < 90; i++) {
      snowFlakes.push({
        x: Math.random(), y: Math.random(),
        r: 0.0018 + Math.random() * 0.0028,
        sp: 0.0004 + Math.random() * 0.0009,
        dr: (Math.random() - 0.5) * 0.0004,
        ph: Math.random() * Math.PI * 2
      });
    }
  }

  /* ── Fog engine — small offscreen noise texture, upscaled + blurred
     (exactly the reference's performance trick: compute noise on a tiny
     canvas, let the GPU do the expensive upscale+blur). Confined to the
     bottom 40% of the sky; wind speed locked at 0.1 per spec; the top
     15% of that band fades from fully transparent to fully visible so
     it reads as ground-hugging mist, not a visible moving box. ── */
  var FOG_NOISE_W = 120, FOG_NOISE_H = 48;
  var fogOffCanvas, fogOffCtx, fogTime = 0, fogDriftX = 0;
  var FOG_WIND_SPEED = 0.1;

  /* Compact 3D simplex noise (public-domain Gustavson/Ashima algorithm) —
     used only to drive the fog texture below. */
  var _fogPerm = (function () {
    var p = [], perm = [], permMod12 = [];
    for (var i = 0; i < 256; i++) p[i] = Math.floor(Math.random() * 256);
    for (var i = 0; i < 512; i++) { perm[i] = p[i & 255]; permMod12[i] = perm[i] % 12; }
    return { perm: perm, permMod12: permMod12 };
  })();
  var _fogGrad3 = [
    [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
    [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
    [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]
  ];
  function fogDot(g, x, y, z) { return g[0] * x + g[1] * y + g[2] * z; }
  function fogNoise3D(xin, yin, zin) {
    var perm = _fogPerm.perm, permMod12 = _fogPerm.permMod12;
    var F3 = 1 / 3, G3 = 1 / 6;
    var s = (xin + yin + zin) * F3;
    var i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    var t = (i + j + k) * G3;
    var X0 = i - t, Y0 = j - t, Z0 = k - t;
    var x0 = xin - X0, y0 = yin - Y0, z0 = zin - Z0;
    var i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1=1;j1=0;k1=0; i2=1;j2=1;k2=0; }
      else if (x0 >= z0) { i1=1;j1=0;k1=0; i2=1;j2=0;k2=1; }
      else { i1=0;j1=0;k1=1; i2=1;j2=0;k2=1; }
    } else {
      if (y0 < z0) { i1=0;j1=0;k1=1; i2=0;j2=1;k2=1; }
      else if (x0 < z0) { i1=0;j1=1;k1=0; i2=0;j2=1;k2=1; }
      else { i1=0;j1=1;k1=0; i2=1;j2=1;k2=0; }
    }
    var x1=x0-i1+G3, y1=y0-j1+G3, z1=z0-k1+G3;
    var x2=x0-i2+2*G3, y2=y0-j2+2*G3, z2=z0-k2+2*G3;
    var x3=x0-1+3*G3, y3=y0-1+3*G3, z3=z0-1+3*G3;
    var ii=i&255, jj=j&255, kk=k&255;
    var gi0=permMod12[ii+perm[jj+perm[kk]]];
    var gi1=permMod12[ii+i1+perm[jj+j1+perm[kk+k1]]];
    var gi2=permMod12[ii+i2+perm[jj+j2+perm[kk+k2]]];
    var gi3=permMod12[ii+1+perm[jj+1+perm[kk+1]]];
    var n0=0, n1=0, n2=0, n3=0;
    var t0=0.6-x0*x0-y0*y0-z0*z0;
    if (t0 >= 0) { t0*=t0; n0 = t0*t0*fogDot(_fogGrad3[gi0],x0,y0,z0); }
    var t1=0.6-x1*x1-y1*y1-z1*z1;
    if (t1 >= 0) { t1*=t1; n1 = t1*t1*fogDot(_fogGrad3[gi1],x1,y1,z1); }
    var t2=0.6-x2*x2-y2*y2-z2*z2;
    if (t2 >= 0) { t2*=t2; n2 = t2*t2*fogDot(_fogGrad3[gi2],x2,y2,z2); }
    var t3=0.6-x3*x3-y3*y3-z3*z3;
    if (t3 >= 0) { t3*=t3; n3 = t3*t3*fogDot(_fogGrad3[gi3],x3,y3,z3); }
    return 32 * (n0 + n1 + n2 + n3);
  }

  function ensureFogCanvas() {
    if (fogOffCanvas) return;
    fogOffCanvas = document.createElement('canvas');
    fogOffCanvas.width = FOG_NOISE_W;
    fogOffCanvas.height = FOG_NOISE_H;
    fogOffCtx = fogOffCanvas.getContext('2d');
  }

  function drawFog(W, H, grey) {
    ensureFogCanvas();
    fogTime += 0.003; /* 0.5x slower, per request */

    var panX1 = fogTime * FOG_WIND_SPEED * 2.5, panY1 = fogTime * FOG_WIND_SPEED * 0.5;
    var panX2 = fogTime * FOG_WIND_SPEED * 4.0, panY2 = fogTime * FOG_WIND_SPEED * 1.5;

    var imgData = fogOffCtx.createImageData(FOG_NOISE_W, FOG_NOISE_H);
    var px = imgData.data;
    var rgb = grey ? [190, 193, 198] : [212, 212, 220];

    for (var y = 0; y < FOG_NOISE_H; y++) {
      /* Ground-hugging fade: invisible at the very top of the band,
         fully visible by 15% of the way down into it. */
      var vMask = Math.min(1, (y / FOG_NOISE_H) / 0.15);
      for (var x = 0; x < FOG_NOISE_W; x++) {
        /* Soft left/right fade too — without this the texture reads as
           a hard-edged rectangle the moment it drifts sideways. */
        var hFrac = x / FOG_NOISE_W;
        var hMask = Math.min(1, hFrac / 0.08) * Math.min(1, (1 - hFrac) / 0.08);

        var nx = x / FOG_NOISE_W, ny = y / FOG_NOISE_H;
        var n1v = fogNoise3D(nx * 5.5 + panX1, ny * 5.5 + panY1, fogTime * 0.5);
        var n2v = fogNoise3D(nx * 10.0 + panX2, ny * 10.0 + panY2, fogTime * 0.8);
        var normalized = ((n1v * 0.6 + n2v * 0.4) + 1) / 2;
        var alpha = Math.pow(normalized, 3.6) * vMask * hMask;
        alpha = Math.max(0, Math.min(1, alpha));

        var idx = (x + y * FOG_NOISE_W) * 4;
        px[idx]     = rgb[0];
        px[idx + 1] = rgb[1];
        px[idx + 2] = rgb[2];
        px[idx + 3] = Math.floor(alpha * 255 * 0.5); // 50% less opaque than before
      }
    }
    fogOffCtx.putImageData(imgData, 0, 0);

    /* Genuine slow physical drift in the wind direction (not just the
       internal noise morph above) — the whole mass glides sideways.
       Drawn twice, side by side, so the loop is seamless; the left/right
       fade above means the seam between the two copies lands in an
       already-transparent zone, so it never shows. */
    fogDriftX = (fogDriftX + FOG_WIND_SPEED * 0.15) % W;

    var bandH = H * 0.2, bandY = H - bandH;
    skyCtx.save();
    skyCtx.filter = 'blur(14px)';
    skyCtx.drawImage(fogOffCanvas, -fogDriftX, bandY, W, bandH);
    skyCtx.drawImage(fogOffCanvas, W - fogDriftX, bandY, W, bandH);
    skyCtx.restore();
  }

  function scheduleThunder() {
    /* random 60s interval, per spec — "sometime slow, sometime large" varied via random flash size/duration */
    nextThunderAt = skyT + 45 + Math.random() * 30;
  }
  function scheduleComet() {
    /* every 3-5 minutes, visible for ~1 minute per spec */
    nextCometAt = skyT + 180 + Math.random() * 120;
  }
  function scheduleTrail() {
    /* small falling star/asteroid trails every 2-3 minutes */
    nextTrailAt = skyT + 120 + Math.random() * 60;
  }

  function drawSkyFrame() {
    if (colorTheme !== 'live' && colorTheme !== 'grey') return;

    var W = skyW, H = skyH;
    var grey = (colorTheme === 'grey');
    var now = getClockNow();   /* respects debug time override */
    var hours = now.getHours() + now.getMinutes() / 60;
    var code = weatherData ? weatherData.code : 0;
    var fx = skyEffects.master ? skyEffects : {
      cloud:false, rain:false, breeze:false, thunder:false,
      snow:false, fog:false, wave:false, night:false
    };

    /* ── Sky gradient by time of day — dawn/dusk orange-tint windows are
       exactly 1 hour each, centered on sunrise (6am) and sunset (6pm),
       with stronger, more visible orange/warm saturation per spec ── */
    var grad;
    if (hours < 5.5 || hours >= 18.5 + 1.5) {
      grad = skyCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, grey ? '#1a1a2a' : '#06061a');
      grad.addColorStop(1, grey ? '#2a2a3a' : '#0d1033');
    } else if (hours < 6.5) {
      /* Dawn — 1 hour window (5:30-6:30) */
      grad = skyCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, grey ? '#4a3a4a' : '#2a1030');
      grad.addColorStop(0.45, grey ? '#8a6a4a' : '#e05a1a');
      grad.addColorStop(0.75, grey ? '#a08868' : '#f5893a');
      grad.addColorStop(1, grey ? '#b8a888' : '#ffc470');
    } else if (hours < 7.5) {
      /* Fresh morning — 1 hour window (6:30-7:30), warm but brightening */
      grad = skyCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, grey ? '#6a7a8a' : '#3d8fd0');
      grad.addColorStop(0.4, grey ? '#9aa8a8' : '#8fcbe8');
      grad.addColorStop(1, grey ? '#c0b8a0' : '#ffd9a0');
    } else if (hours < 17) {
      grad = skyCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, grey ? '#7a8a9a' : '#2e86de');
      grad.addColorStop(1, grey ? '#aabbcc' : '#87d8f7');
    } else if (hours < 18) {
      /* Cool sunset lead-in — 1 hour window (17:00-18:00) */
      grad = skyCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, grey ? '#5a5a7a' : '#2a3a7a');
      grad.addColorStop(0.4, grey ? '#8a7a7a' : '#a85a5a');
      grad.addColorStop(1, grey ? '#b8a888' : '#f5a050');
    } else if (hours < 19) {
      /* Sunset — 1 hour window (18:00-19:00), strongest orange/red */
      grad = skyCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, grey ? '#4a3a5a' : '#1a1040');
      grad.addColorStop(0.35, grey ? '#8a5a5a' : '#c9370c');
      grad.addColorStop(0.7, grey ? '#aa8060' : '#f4700c');
      grad.addColorStop(1, grey ? '#ccaa88' : '#ffb060');
    } else {
      grad = skyCtx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, grey ? '#2a2a4a' : '#1a0a3e');
      grad.addColorStop(1, grey ? '#3a3a5a' : '#2a2a6a');
    }
    skyCtx.fillStyle = grad;
    skyCtx.fillRect(0, 0, W, H);

    var isNight = (hours < 6 || hours > 19);

    /* ── 0. Fog — drawn first so every other effect sits in front of it
       (only the sky gradient itself is behind the fog) ── */
    if (fx.fog) {
      drawFog(W, H, grey);
    }

    /* ── 1. Night sky effect (stars, comet, trails) ── */
    if (fx.night) {
      var starAlpha = 0;
      if (hours < 6 || hours > 19) starAlpha = 1;
      else if (hours < 7) starAlpha = 1 - (hours - 6);
      else if (hours > 18) starAlpha = hours - 18;

      if (starAlpha > 0) {
        stars.forEach(function (s) {
          var tw = 0.5 + 0.5 * Math.sin(skyT * s.tw + s.ph);
          skyCtx.beginPath();
          skyCtx.arc(s.x * W, s.y * H, s.r * tw, 0, Math.PI * 2);
          skyCtx.fillStyle = grey
            ? 'rgba(180,190,200,' + (starAlpha * tw * 0.8) + ')'
            : 'rgba(255,255,240,' + (starAlpha * tw * 0.9) + ')';
          skyCtx.fill();
        });
      }

      if (isNight) {
        if (skyT >= nextCometAt && skyT < nextCometAt + 60) {
          var cProg = (skyT - nextCometAt) / 60;
          /* Motion vector defines both position AND the trail's angle,
             so the trail always points back along the actual direction
             of travel instead of a fixed constant rotation. */
          var cStartX = W * 0.15, cStartY = H * 0.12;
          var cEndX   = W * 0.85, cEndY   = H * 0.34;
          var cx = cStartX + (cEndX - cStartX) * cProg;
          var cy = cStartY + (cEndY - cStartY) * cProg;
          var cAngle = Math.atan2(cEndY - cStartY, cEndX - cStartX);
          var cFade = cProg < 0.08 ? cProg / 0.08 : cProg > 0.9 ? (1 - cProg) / 0.1 : 1;

          skyCtx.save();
          skyCtx.translate(cx, cy);
          skyCtx.rotate(cAngle + Math.PI); /* tail points backward along travel direction */

          /* Soft aura glow around the head */
          var cometGlow = skyCtx.createRadialGradient(0, 0, 0, 0, 0, 16);
          cometGlow.addColorStop(0, 'rgba(210,230,255,' + (0.55 * cFade) + ')');
          cometGlow.addColorStop(1, 'rgba(210,230,255,0)');
          skyCtx.beginPath();
          skyCtx.arc(0, 0, 16, 0, Math.PI * 2);
          skyCtx.fillStyle = cometGlow;
          skyCtx.fill();

          /* Tapered tail */
          var tailGrad = skyCtx.createLinearGradient(0, 0, 85, 0);
          tailGrad.addColorStop(0, 'rgba(255,255,255,' + (0.9 * cFade) + ')');
          tailGrad.addColorStop(1, 'rgba(255,255,255,0)');
          skyCtx.beginPath();
          skyCtx.moveTo(0, -1.6);
          skyCtx.lineTo(85, -0.2);
          skyCtx.lineTo(85, 0.2);
          skyCtx.lineTo(0, 1.6);
          skyCtx.closePath();
          skyCtx.fillStyle = tailGrad;
          skyCtx.fill();

          /* A few small sparks trailing off the tail for texture */
          for (var sp2 = 0; sp2 < 4; sp2++) {
            var sparkD = 15 + sp2 * 20 + (Math.sin(skyT * 6 + sp2) * 4);
            var sparkOff = Math.sin(skyT * 9 + sp2 * 2) * 2.5;
            skyCtx.beginPath();
            skyCtx.arc(sparkD, sparkOff, 0.8, 0, Math.PI * 2);
            skyCtx.fillStyle = 'rgba(255,255,255,' + (cFade * (1 - sp2 / 4) * 0.7) + ')';
            skyCtx.fill();
          }

          /* Bright head */
          skyCtx.beginPath();
          skyCtx.arc(0, 0, 2.2, 0, Math.PI * 2);
          skyCtx.fillStyle = 'rgba(255,255,255,' + cFade + ')';
          skyCtx.fill();

          skyCtx.restore();
        } else if (skyT >= nextCometAt + 60) {
          scheduleComet();
        }

        if (skyT >= nextTrailAt && skyT < nextTrailAt + 1.2) {
          var tProg = (skyT - nextTrailAt) / 1.2;
          var tStartX = W * (0.2 + ((nextTrailAt * 37) % 1) * 0.6);
          var tStartY = H * 0.05;
          var tAngle = Math.PI / 3.2; /* falling diagonally down-left, consistent shooting-star angle */
          var tDist = tProg * H * 0.42;
          var tx = tStartX - Math.cos(tAngle) * tDist * -1;
          var ty = tStartY + Math.sin(tAngle) * tDist;
          /* Glow brightens quickly then fades smoothly to zero as it "burns out" */
          var tGlow = tProg < 0.15 ? tProg / 0.15 : 1 - Math.pow((tProg - 0.15) / 0.85, 1.4);

          skyCtx.save();
          skyCtx.translate(tx, ty);
          skyCtx.rotate(tAngle);

          var trailGrad = skyCtx.createLinearGradient(-26, 0, 0, 0);
          trailGrad.addColorStop(0, 'rgba(207,224,255,0)');
          trailGrad.addColorStop(1, 'rgba(207,224,255,' + (0.9 * tGlow) + ')');
          skyCtx.beginPath();
          skyCtx.moveTo(-26, -0.5);
          skyCtx.lineTo(0, -0.15);
          skyCtx.lineTo(0, 0.15);
          skyCtx.lineTo(-26, 0.5);
          skyCtx.closePath();
          skyCtx.fillStyle = trailGrad;
          skyCtx.fill();

          var headGlow = skyCtx.createRadialGradient(0, 0, 0, 0, 0, 4);
          headGlow.addColorStop(0, 'rgba(255,255,255,' + tGlow + ')');
          headGlow.addColorStop(1, 'rgba(255,255,255,0)');
          skyCtx.beginPath();
          skyCtx.arc(0, 0, 4, 0, Math.PI * 2);
          skyCtx.fillStyle = headGlow;
          skyCtx.fill();

          skyCtx.restore();
        } else if (skyT >= nextTrailAt + 1.2) {
          scheduleTrail();
        }
      }
    }

    /* ── 2. Sun / Moon (always drawn, independent of toggles — celestial position, not an "effect") ── */
    drawSunMoon(W, H, hours, grey);

    /* ── 3. Cloud — hybrid puff-silhouette + fBm-noise clouds. The artwork
       is baked once per cloud (lazily, max one bake per frame so opening
       the overlay never stalls); each frame is then a haze pass plus a
       detail pass of the same texture. ── */
    if (fx.cloud) {
      var bakedThisFrame = false;
      var sizeBase = Math.min(W, H);            // orientation-proof sizing
      clouds.forEach(function (c) {
        c.x = (c.x + c.sp) % 1.3;
        var cx = (c.x - 0.15) * W, cy = c.y * H;
        var ch = c.hf * sizeBase, cw = ch * CLOUD_ASPECT;

        // Bigger clouds get proportionally more billows, so a large cloud
        // isn't just a small one's texture stretched.
        var fs = cloudClamp(ch / 95, 0.85, 2.4);
        // Re-bake only when there's a real reason to: no art yet, the theme
        // flipped, or the viewport changed enough that the detail density
        // would visibly differ. A plain window resize hits none of these.
        if (!c.tex || c.texGrey !== grey || Math.abs(c.texFs - fs) > 0.35) {
          if (bakedThisFrame) { if (!c.tex) return; }   // spread bakes over frames
          else {
            c.tex = makeCloudTexture(CLOUD_TEX_W, CLOUD_TEX_H, c.seed, fs, grey);
            c.texGrey = grey;
            c.texFs = fs;
            bakedThisFrame = true;
          }
        }

        // Keeps the original slow opacity "breathing".
        var pulse = (0.86 + Math.sin(skyT * c.opSpeed + c.opPhase) * 0.10) * (grey ? 0.85 : 1);
        var dx = cx - cw / 2, dy = cy - ch / 2;

        skyCtx.save();
        // soft atmospheric bed underneath gives the cloud depth
        skyCtx.globalAlpha = pulse * 0.32;
        skyCtx.filter = 'blur(' + (ch * 0.14) + 'px)';
        skyCtx.drawImage(c.tex, dx - cw * 0.03, dy + ch * 0.04, cw * 1.06, ch * 1.02);
        // detail pass
        skyCtx.globalAlpha = pulse;
        skyCtx.filter = 'blur(' + (ch * 0.013) + 'px)';
        skyCtx.drawImage(c.tex, dx, dy, cw, ch);
        skyCtx.restore();
      });
    }

    /* ── 4. Air breeze (subtle horizontal streak lines drifting) ── */
    if (fx.breeze) {
      for (var b = 0; b < 5; b++) {
        var by = H * (0.3 + b * 0.12) + Math.sin(skyT * 0.4 + b) * 8;
        var bx = ((skyT * 40 + b * 220) % (W + 200)) - 100;
        skyCtx.beginPath();
        skyCtx.moveTo(bx, by);
        skyCtx.lineTo(bx + 70, by + 3);
        skyCtx.strokeStyle = grey ? 'rgba(200,200,210,.18)' : 'rgba(255,255,255,.15)';
        skyCtx.lineWidth = 1.2;
        skyCtx.stroke();
      }
    }

    /* ── 5. Thunder — screen flash PLUS an actual jagged bolt from sky
       to ground, not just a blank white flash ── */
    if (fx.thunder) {
      if (skyT >= nextThunderAt) {
        var big = Math.random() < 0.4;
        thunderFlashUntil = skyT + (big ? 0.35 : 0.12);
        thunderBoltX = W * (0.2 + Math.random() * 0.6);
        thunderBoltBig = big;
        scheduleThunder();
      }
      if (skyT < thunderFlashUntil) {
        skyCtx.fillStyle = 'rgba(255,255,255,' + (0.2 + Math.random() * 0.2) + ')';
        skyCtx.fillRect(0, 0, W, H);

        /* Jagged bolt path, regenerated each flash frame for a flicker effect */
        var boltSegs = 8;
        var boltX = thunderBoltX;
        var boltY = 0;
        var segH = H * 0.85 / boltSegs;
        skyCtx.beginPath();
        skyCtx.moveTo(boltX, boltY);
        var pathPts = [[boltX, boltY]];
        for (var bi = 0; bi < boltSegs; bi++) {
          boltX += (Math.random() - 0.5) * W * 0.09;
          boltY += segH;
          skyCtx.lineTo(boltX, boltY);
          pathPts.push([boltX, boltY]);
          /* occasional branch fork */
          if (Math.random() < 0.3 && bi > 1 && bi < boltSegs - 1) {
            var branchLen = 2 + Math.floor(Math.random() * 2);
            var bx2 = boltX, by2 = boltY;
            skyCtx.moveTo(bx2, by2);
            for (var bj = 0; bj < branchLen; bj++) {
              bx2 += (Math.random() - 0.3) * W * 0.06;
              by2 += segH * 0.6;
              skyCtx.lineTo(bx2, by2);
            }
            skyCtx.moveTo(boltX, boltY);
          }
        }
        skyCtx.strokeStyle = 'rgba(255,255,255,' + (thunderBoltBig ? 0.95 : 0.7) + ')';
        skyCtx.lineWidth = thunderBoltBig ? 3 : 1.8;
        skyCtx.shadowColor = 'rgba(200,220,255,.9)';
        skyCtx.shadowBlur = 14;
        skyCtx.stroke();
        skyCtx.shadowBlur = 0;
      }
    }

    /* ── 6. Rain ── */
    if (fx.rain) {
      if (rainDrops.length === 0) buildRain();
      rainDrops.forEach(function (r) {
        r.y = (r.y + r.sp) % 1;
        r.x = (r.x + r.drift + 1) % 1;
        skyCtx.beginPath();
        skyCtx.moveTo(r.x * W, r.y * H);
        skyCtx.lineTo(r.x * W + 1, (r.y + r.len) * H);
        skyCtx.strokeStyle = grey
          ? 'rgba(160,170,185,' + r.op + ')'
          : 'rgba(180,200,255,' + r.op + ')';
        skyCtx.lineWidth = 1.2;
        skyCtx.stroke();
      });
    } else if (rainDrops.length) {
      rainDrops = [];
    }

    /* ── 7. Snow-fall ── */
    if (fx.snow) {
      if (snowFlakes.length === 0) buildSnow();
      snowFlakes.forEach(function (s) {
        s.y = (s.y + s.sp) % 1;
        s.x = (s.x + s.dr + 1) % 1;
        var wob = Math.sin(skyT * 0.8 + s.ph) * 0.004;
        skyCtx.beginPath();
        skyCtx.arc((s.x + wob) * W, s.y * H, s.r * W, 0, Math.PI * 2);
        skyCtx.fillStyle = grey ? 'rgba(210,215,220,.7)' : 'rgba(230,240,255,.75)';
        skyCtx.fill();
      });
    } else if (snowFlakes.length) {
      snowFlakes = [];
    }

    /* ── 8. Fog — now drawn early, at step 0 (see above), so it sits
       behind every other effect instead of on top of them ── */

    /* ── 9. Ocean wave (bottom-edge animated sine strip) ── */
    if (fx.wave) {
      var waveY = H * 0.94;
      skyCtx.beginPath();
      skyCtx.moveTo(0, H);
      for (var wx = 0; wx <= W; wx += 6) {
        var wy = waveY + Math.sin(wx * 0.02 + skyT * 1.4) * 6 + Math.sin(wx * 0.05 + skyT * 2.1) * 3;
        skyCtx.lineTo(wx, wy);
      }
      skyCtx.lineTo(W, H);
      skyCtx.closePath();
      var waveGrad = skyCtx.createLinearGradient(0, waveY, 0, H);
      waveGrad.addColorStop(0, grey ? 'rgba(90,105,120,.55)' : 'rgba(20,60,110,.55)');
      waveGrad.addColorStop(1, grey ? 'rgba(60,75,90,.85)'  : 'rgba(8,30,60,.85)');
      skyCtx.fillStyle = waveGrad;
      skyCtx.fill();

      /* foam highlight along the crest */
      skyCtx.beginPath();
      for (var wx2 = 0; wx2 <= W; wx2 += 6) {
        var wy2 = waveY + Math.sin(wx2 * 0.02 + skyT * 1.4) * 6 + Math.sin(wx2 * 0.05 + skyT * 2.1) * 3;
        wx2 === 0 ? skyCtx.moveTo(wx2, wy2) : skyCtx.lineTo(wx2, wy2);
      }
      skyCtx.strokeStyle = 'rgba(255,255,255,.35)';
      skyCtx.lineWidth = 1.5;
      skyCtx.stroke();
    }
  }

  /* ════════════════════════════════════════════════════
     3D CELESTIAL ENGINE (Three.js)
     ─────────────────────────────────────────────────────
     Renders a photorealistic textured sphere for the Moon
     and the Sun. The 2D sky canvas still draws stars,
     clouds, weather effects, and the outer glow. The 3D
     canvas sits on top and shows just the sphere itself,
     positioned to match the 2D celestial coordinates.

     - Moon: bump-mapped, lit by a directional "sun light",
             ambient 0.1 for 10% earthshine, Fresnel rim
             glow on the lit side, breathing outer aura.
     - Sun:  emissive plasma with animated noise UV drift,
             corona flame shell with additive blending,
             outer aura + subtle lens-flare-like sprite.
     - Rotation: Y-axis 360° per 60s, X-axis 360° per 300s.
     - Bump map: derived from luminance of same texture,
             bumpScale ≈ 4% of moon radius.
  ════════════════════════════════════════════════════ */
  var THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var threeLoading = false, threeReady = false;
  var threeRenderer, threeScene, threeCamera;
  var moonGroup, moonMesh, moonAuraMesh, moonRimMesh;
  var sunGroup, sunMesh, sunCoronaMesh, sunAuraMesh;
  var celestial3D = null;   /* {type, x, y, r} — where the 2D pass says to render */
  var lastCelestialType = null;
  var moonTexReady = false, sunTexReady = false;
  var threeLastT = performance.now();

  /* ─────────────────────────────────────────────────────────
     TUNABLE: overall moon/sun size multiplier. 1.0 = original.
     Currently 1.2 (i.e. +20% bigger). Change this single number
     to scale both bodies up or down in future.
  ───────────────────────────────────────────────────────── */
  var CELESTIAL_SIZE_MULT = (typeof cfg.celestialSizeMult === 'number') ? cfg.celestialSizeMult : 2;
  var MOON_TEXTURE_URL = cfg.moonTextureUrl || 'moon-map.jpg';
  var SUN_TEXTURE_URL  = cfg.sunTextureUrl  || 'sun-map.jpg';

  /* Manual drag-to-rotate state. While the user is dragging the moon/sun,
     auto-rotation pauses; it resumes DRAG_RESUME_MS after release. */
  var DRAG_RESUME_MS = 2000;
  var dragState = {
    active: false, type: null,
    lastX: 0, lastY: 0,
    moved: 0,            /* total px moved — used to distinguish drag vs click */
    releasedAt: 0        /* timestamp of last release, for resume delay */
  };
  /* Manual rotation offsets applied on top of (or instead of) auto-spin */
  var moonManualRot = { x: 0, y: 0 };
  var sunManualRot  = { x: 0, y: 0 };
  var DRAG_SENSITIVITY = 0.01; /* radians per pixel */

  /* Debug panel state, incl. manual time override.
     Exposed on window.__clkDbg so the early-declared getClockNow()
     accessors (defined near the top of this file) can read it. */
  var dbg = {
    open: false,
    rawTexture: false,     /* show texture without lighting */
    manualTime: false,     /* override clock time with slider */
    manualHours: 2.8       /* 0..24, float (hours + fraction) */
  };
  window.__clkDbg = dbg;

  /* Load Three.js on demand, once. Fails silently on offline / CSP block. */
  function loadThree(cb) {
    if (threeReady) { cb(); return; }
    if (window.THREE) { threeReady = true; cb(); return; }
    if (threeLoading) return;
    threeLoading = true;
    var s = document.createElement('script');
    s.src = THREE_URL;
    s.async = true;
    s.onload = function () { threeReady = true; cb(); };
    s.onerror = function () { threeLoading = false; /* stay on 2D fallback */ };
    document.head.appendChild(s);
  }

  /* Fresnel-lit moon shader — Lambert + ambient 0.1 + rim glow on lit side.
     The rim glow is Fresnel * dot(normal, sunDir), so it's crisp only where
     the sun would actually be catching the edge.

     KEY FIX: sunDir arrives in WORLD space and is transformed to view space
     inside the shader (viewMatrix * vec4(sunDir, 0.0)). vNormal is already in
     view space (via normalMatrix), so both must live in the same space for the
     dot product to be meaningful — otherwise the moon renders pitch black. */
  var MOON_VERT = [
    'varying vec3 vNormal;',
    'varying vec3 vViewDir;',
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
    '  vNormal = normalize(normalMatrix * normal);',
    '  vViewDir = normalize(-mvPos.xyz);',
    '  gl_Position = projectionMatrix * mvPos;',
    '}'
  ].join('\n');

  var MOON_FRAG = [
    'uniform sampler2D tex;',
    'uniform vec3 sunDir;',         /* WORLD space; transformed below */
    'uniform float ambient;',        /* 0.1 → 10% dark-side visibility */
    'uniform float rimStrength;',
    'uniform float bumpScale;',
    'uniform float rawTexture;',     /* 1.0 = show flat texture (debug) */
    'varying vec3 vNormal;',
    'varying vec3 vViewDir;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 base = texture2D(tex, vUv).rgb;',
    '  if (rawTexture > 0.5) { gl_FragColor = vec4(base, 1.0); return; }',
    /* Cheap fake bump: perturb normal using luminance gradient of the texture */
    '  float lum = dot(base, vec3(0.299, 0.587, 0.114));',
    '  vec2 texel = vec2(1.0/1024.0);',
    '  float lx = dot(texture2D(tex, vUv + vec2(texel.x,0.0)).rgb, vec3(0.299,0.587,0.114)) - lum;',
    '  float ly = dot(texture2D(tex, vUv + vec2(0.0,texel.y)).rgb, vec3(0.299,0.587,0.114)) - lum;',
    '  vec3 N = normalize(vNormal + vec3(-lx, -ly, 0.0) * bumpScale * 40.0);',
    /* Transform world-space sun direction into view space to match N */
    '  vec3 sd = normalize((viewMatrix * vec4(normalize(sunDir), 0.0)).xyz);',
    '  float diff = max(dot(N, sd), 0.0);',
    '  float lit = ambient + (1.0 - ambient) * diff;',
    /* Fresnel rim, gated by "is this pixel on the lit side" */
    '  float fres = pow(1.0 - max(dot(N, vViewDir), 0.0), 3.0);',
    '  float rim = fres * smoothstep(0.0, 0.35, diff) * rimStrength;',
    '  vec3 col = base * lit + vec3(0.75, 0.82, 1.0) * rim;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* Outer breathing aura: soft radial gradient on a billboard behind the moon.
     Additive blend, subtle sin() breathing on alpha. */
  var AURA_VERT = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = uv;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'
  ].join('\n');

  var MOON_AURA_FRAG = [
    'uniform float time;',
    'uniform float intensity;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 p = vUv - 0.5;',
    '  float d = length(p) * 2.0;',
    '  float breath = 0.85 + 0.15 * sin(time * 0.6);',
    '  float a = smoothstep(1.0, 0.15, d) * 0.35 * intensity * breath;',
    '  gl_FragColor = vec4(vec3(0.72, 0.82, 1.0), a);',
    '}'
  ].join('\n');

  /* Sun surface: emissive base tex + slowly warped noise for boiling look */
  var SUN_FRAG = [
    'uniform sampler2D tex;',
    'uniform float time;',
    'varying vec2 vUv;',
    'varying vec3 vNormal;',
    'varying vec3 vViewDir;',
    /* cheap hash noise */
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float noise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));',
    '  vec2 u = f*f*(3.0-2.0*f);',
    '  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;',
    '}',
    'void main() {',
    '  vec2 uv = vUv + vec2(sin(time*0.05)*0.02, time*0.02);',
    '  vec3 base = texture2D(tex, uv).rgb;',
    '  float n = noise(vUv * 8.0 + time * 0.3);',
    '  vec3 hot = mix(vec3(1.0, 0.55, 0.15), vec3(1.0, 0.95, 0.6), n);',
    '  vec3 col = base * 0.7 + hot * 0.5 * n;',
    /* darken very edge a touch to imply a limb */
    '  float N = max(dot(normalize(vNormal), normalize(vViewDir)), 0.0);',
    '  col *= 0.6 + 0.4 * N;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* Sun corona: additive plasma flames licking outward, animated */
  var SUN_CORONA_FRAG = [
    'uniform float time;',
    'varying vec2 vUv;',
    'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float noise(vec2 p){',
    '  vec2 i = floor(p), f = fract(p);',
    '  float a = hash(i), b = hash(i+vec2(1,0)), c = hash(i+vec2(0,1)), d = hash(i+vec2(1,1));',
    '  vec2 u = f*f*(3.0-2.0*f);',
    '  return mix(a,b,u.x) + (c-a)*u.y*(1.0-u.x) + (d-b)*u.x*u.y;',
    '}',
    'void main() {',
    '  vec2 p = vUv - 0.5;',
    '  float r = length(p) * 2.0;',
    '  float ang = atan(p.y, p.x);',
    /* domain-warped flame tendrils around the rim */
    '  float n = noise(vec2(ang * 3.0 + time * 0.4, r * 4.0));',
    '  float flame = smoothstep(0.55, 0.85, r + n * 0.25) * (1.0 - smoothstep(0.85, 1.0, r));',
    '  float halo  = smoothstep(1.0, 0.55, r) * 0.4;',
    '  vec3 col = mix(vec3(1.0, 0.5, 0.1), vec3(1.0, 0.9, 0.4), n);',
    '  float a = (flame * 0.9 + halo) * 0.6;',
    '  gl_FragColor = vec4(col * a, a);',
    '}'
  ].join('\n');

  var SUN_AURA_FRAG = [
    'uniform float time;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 p = vUv - 0.5;',
    '  float d = length(p) * 2.0;',
    '  float breath = 0.9 + 0.1 * sin(time * 0.7);',
    '  float a = smoothstep(1.0, 0.2, d) * 0.4 * breath;',
    '  gl_FragColor = vec4(vec3(1.0, 0.72, 0.32), a);',
    '}'
  ].join('\n');

  function init3DScene() {
    if (!window.THREE) return;
    threeRenderer = new THREE.WebGLRenderer({ canvas: sky3d, alpha: true, antialias: true });
    threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    threeRenderer.setSize(window.innerWidth, window.innerHeight, false);
    threeRenderer.setClearColor(0x000000, 0);

    threeScene = new THREE.Scene();
    /* Orthographic camera in *pixel* coordinates so we can position spheres
       at exact 2D-canvas (x, y) with a "radius" that matches the 2D disc.
       Camera sits at z=+500 looking down the -Z axis; spheres live at z≈0. */
    threeCamera = new THREE.OrthographicCamera(0, 1, 0, 1, -1000, 1000);
    threeCamera.position.z = 500;
    threeCamera.lookAt(0, 0, 0);
    resize3D();

    /* ── MOON ── */
    moonGroup = new THREE.Group();
    moonGroup.visible = false;
    threeScene.add(moonGroup);

    /* NOTE: the material is created BEFORE the texture load is kicked off.
       If the image is already in the browser cache the callback can fire
       very early, and referencing a not-yet-assigned `moonMat` would throw
       (leaving the texture unassigned and the sphere black). */
    var moonMat = new THREE.ShaderMaterial({
      uniforms: {
        tex:         { value: new THREE.Texture() },
        sunDir:      { value: new THREE.Vector3(1, 0.3, 0.5).normalize() },
        ambient:     { value: 0.10 },   /* 10% earthshine, per spec */
        rimStrength: { value: 0.55 },
        bumpScale:   { value: 0.4 },   /* ~3% fake surface relief */
        rawTexture:  { value: 0.0 }     /* debug: 1.0 = show flat texture */
      },
      vertexShader: MOON_VERT,
      fragmentShader: MOON_FRAG,
      side: THREE.DoubleSide           /* safety net vs backface culling */
    });
    moonMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), moonMat);
    moonGroup.add(moonMesh);

    /* Load texture via plain Image() — avoids Three.js TextureLoader's
       crossOrigin attribute which breaks under file:// protocol. */
    (function () {
      var img = new Image();
      img.onload = function () {
        var tex = new THREE.Texture(img);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        moonMat.uniforms.tex.value = tex;
        moonMat.needsUpdate = true;
        moonTexReady = true;
      };
      img.onerror = function () { /* silent fallback: stays on 2D disc */ };
      img.src = MOON_TEXTURE_URL;
    })();

    /* Outer aura billboard (breathing calm glow). Pushed well behind the
       sphere so it can't z-fight with the surface. */
    var auraMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, intensity: { value: 1.0 } },
      vertexShader: AURA_VERT,
      fragmentShader: MOON_AURA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    moonAuraMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 3.0), auraMat);
    moonAuraMesh.position.z = -1.5;
    moonAuraMesh.renderOrder = -1;   /* draw before the sphere */
    moonGroup.add(moonAuraMesh);

    /* ── SUN ── */
    sunGroup = new THREE.Group();
    sunGroup.visible = false;
    threeScene.add(sunGroup);

    /* Material first, then load — same cached-image race as the moon. */
    var sunMat = new THREE.ShaderMaterial({
      uniforms: {
        tex:  { value: new THREE.Texture() },
        time: { value: 0 }
      },
      vertexShader: MOON_VERT, /* reuses vNormal/vViewDir/vUv */
      fragmentShader: SUN_FRAG,
      side: THREE.DoubleSide
    });
    sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), sunMat);
    sunGroup.add(sunMesh);

    (function () {
      var img = new Image();
      img.onload = function () {
        var tex = new THREE.Texture(img);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        sunMat.uniforms.tex.value = tex;
        sunMat.needsUpdate = true;
        sunTexReady = true;
      };
      img.onerror = function () { /* silent fallback: stays on 2D disc */ };
      img.src = SUN_TEXTURE_URL;
    })();

    /* Corona flames sit slightly IN FRONT of the sphere so the tendrils
       can lick over the limb; additive + no depth test keeps it clean. */
    var coronaMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: AURA_VERT,
      fragmentShader: SUN_CORONA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    sunCoronaMesh = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 3.0), coronaMat);
    sunCoronaMesh.position.z = 1.2;
    sunCoronaMesh.renderOrder = 1;   /* draw after the sphere */
    sunGroup.add(sunCoronaMesh);

    /* Outer halo, behind everything */
    var sunAuraMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: AURA_VERT,
      fragmentShader: SUN_AURA_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });
    sunAuraMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), sunAuraMat);
    sunAuraMesh.position.z = -1.5;
    sunAuraMesh.renderOrder = -1;    /* draw before the sphere */
    sunGroup.add(sunAuraMesh);

    window.addEventListener('resize', resize3D);
  }

  function resize3D() {
    if (!threeRenderer) return;
    var w = window.innerWidth, h = window.innerHeight;
    threeRenderer.setSize(w, h, false);
    /* IMPORTANT: use a STANDARD (non-inverted) frustum — top > bottom.
       An inverted frustum (top=0, bottom=h) mirrors the Y axis, which
       reverses triangle winding, culls the sphere's front faces, and
       leaves you looking at the inside of the far hemisphere (normals
       pointing away from the light → pitch-black disc). We keep the
       frustum standard and flip Y when positioning instead. */
    threeCamera.left = 0; threeCamera.right = w;
    threeCamera.top = h;  threeCamera.bottom = 0;
    threeCamera.updateProjectionMatrix();
  }

  /* Called every 2D frame with where and what to render.
     If Three.js hasn't loaded yet, this is a silent no-op — the 2D
     fallback in drawSunMoon still shows a plain disc. */
  function place3DCelestial(type, x, y, r) {
    celestial3D = { type: type, x: x, y: y, r: r };
    lastCelestialType = type;
  }
  function clear3DCelestial() { celestial3D = null; }

  function render3D() {
    if (!threeReady || !threeRenderer) return;
    var now = performance.now();
    var dt = Math.min(0.1, (now - threeLastT) / 1000);
    threeLastT = now;

    if (!celestial3D) {
      if (moonGroup) moonGroup.visible = false;
      if (sunGroup)  sunGroup.visible  = false;
      threeRenderer.clear();
      return;
    }

    var c = celestial3D;
    var showMoon = (c.type === 'moon');
    moonGroup.visible = showMoon && moonTexReady;
    sunGroup.visible  = !showMoon && sunTexReady;

    var grp = showMoon ? moonGroup : sunGroup;
    /* The frustum is standard (Y up), but c.y comes from the 2D canvas
       where Y grows DOWNWARD. Flip it here so the sphere lands exactly
       where the 2D glow was drawn.
       Radius already includes CELESTIAL_SIZE_MULT (applied in drawSunMoon). */
    grp.position.set(c.x, skyH - c.y, 0);
    grp.scale.setScalar(c.r);

    /* Auto-rotation resumes only after DRAG_RESUME_MS since last release,
       and never while actively dragging. */
    var dragging = dragState.active && dragState.type === c.type;
    var resuming = (now - dragState.releasedAt) > DRAG_RESUME_MS;
    var autoSpin = !dragging && resuming;

    /* Rotation: Y = 360°/60s, X = 360°/300s (spec) */
    var yRate = (Math.PI * 2) / 60;
    var xRate = (Math.PI * 2) / 300;
    var mesh = showMoon ? moonMesh : sunMesh;
    var manual = showMoon ? moonManualRot : sunManualRot;

    if (autoSpin) {
      manual.y += yRate * dt;
      manual.x += xRate * dt;
    }
    mesh.rotation.y = manual.y;
    mesh.rotation.x = manual.x;

    if (showMoon) {
      moonAuraMesh.material.uniforms.time.value += dt;
      var sd = getMoonSunDir();
      moonMesh.material.uniforms.sunDir.value.set(sd.x, sd.y, sd.z);
      moonMesh.material.uniforms.rawTexture.value = dbg.rawTexture ? 1.0 : 0.0;
    } else {
      sunMesh.material.uniforms.time.value += dt;
      sunCoronaMesh.material.uniforms.time.value += dt;
      sunAuraMesh.material.uniforms.time.value += dt;
    }

    threeRenderer.render(threeScene, threeCamera);
  }

  /* Compute the sun-light direction in the moon's local view-space, from
     current phase + hemisphere. Waxing → light from viewer's right;
     waning → from left; south-hemi flip mirrors it. */
  /* ── Shared lunar helpers ──────────────────────────────────────────
     Single source of truth for phase + hemisphere, so the 3D shader,
     the 2D fallback, and the debug readout can never disagree. */

  /* phaseFrac: 0 = new moon, 0.25 = first quarter, 0.5 = full,
     0.75 = last quarter. Uses the overridable clock so the debug
     time slider moves the phase too. */
  function getMoonPhaseFrac() {
    var synodic = 29.530588853;
    var refNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
    var nowMs = getClockNowMs();
    /* Guard against an obviously broken device clock → fall back to IST */
    if (nowMs < Date.UTC(2024, 0, 1) || nowMs > Date.UTC(2100, 0, 1)) {
      var dLocal = getClockNow();
      nowMs = Date.UTC(dLocal.getFullYear(), dLocal.getMonth(), dLocal.getDate(),
                       dLocal.getHours(), dLocal.getMinutes()) - (5.5 * 3600 * 1000);
    }
    return (((nowMs - refNewMoon) / 86400000) % synodic + synodic) % synodic / synodic;
  }

  /* Illuminated fraction, 0 (new) → 1 (full). */
  function getMoonIllum(phaseFrac) {
    return (1 - Math.cos(2 * Math.PI * phaseFrac)) / 2;
  }

  /* Hemisphere fallback chain: geolocation lat → timezone guess → IST default */
  function isSouthernHemi() {
    if (geoData && typeof geoData.lat === 'number') return geoData.lat < 0;
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      var southTz = /^(Australia|Pacific\/Auckland|Pacific\/Fiji|Antarctica|America\/(Argentina|Sao_Paulo|Santiago|La_Paz|Asuncion|Montevideo|Lima)|Africa\/(Johannesburg|Windhoek|Harare|Lusaka|Maputo|Gaborone))/;
      return southTz.test(tz);
    } catch (e) {
      return false;   /* Intl unavailable → northern / IST default */
    }
  }

  function getMoonSunDir() {
    var phase = getMoonPhaseFrac();
    /* Map phase to a horizontal angle: 0 = light from behind (new),
       0.25 = light from right (first quarter), 0.5 = light from viewer (full),
       0.75 = light from left (last quarter). */
    var ang = phase * Math.PI * 2;
    var southernHemi = isSouthernHemi();
    var x = Math.sin(ang);
    if (southernHemi) x = -x;
    var z = -Math.cos(ang); /* z toward viewer = +1; away = -1 (new moon) */
    return { x: x, y: 0.15, z: z }; /* slight upward tilt looks natural */
  }

  /* Kick off Three.js load the first time the sky engine starts. */
  function ensure3D() {
    loadThree(function () {
      if (!threeRenderer) init3DScene();
    });
  }

  function drawSunMoon(W, H, hours, grey) {
    var sunrise = 6, sunset = 18, dayLen = sunset - sunrise;
    var sunVisible = hours >= sunrise && hours <= sunset;

    celestialHit = null; /* recomputed below — cleared first so a hidden sun/moon can't still be "clickable" */

    /* Whether the 3D layer will paint the disc for us. If yes, the 2D
       code below skips the flat disc + 2D phase shading — it still draws
       the outer glow (which is cheap and works well as an additive layer
       under the 3D sphere) and still updates celestialHit for hover/click. */
    var use3DMoon = threeReady && moonTexReady;
    var use3DSun  = threeReady && sunTexReady;

    if (sunVisible) {
      var prog = (hours - sunrise) / dayLen;
      var elev = Math.sin(Math.PI * prog);
      var sx = prog * W;
      var sy = H * (0.85 - elev * 0.65);
      /* CELESTIAL_SIZE_MULT scales the final size — see constant above */
      var sunR = Math.max(24, Math.min(46, W * 0.032)) * CELESTIAL_SIZE_MULT;

      var sBoost = celestialBoost('sun');
      sunR *= sBoost.scale;
      celestialHit = { type: 'sun', x: sx, y: sy, r: sunR };

      /* Outer 2D glow — kept even in 3D mode as it blends nicely with the
         corona shader and matches the surrounding sky color transitions. */
      var glowR = sunR * 2.4 * (1 + (sBoost.glowMult - 1) * 0.5);
      var glow = skyCtx.createRadialGradient(sx, sy, sunR * 0.5, sx, sy, glowR);
      glow.addColorStop(0, grey ? 'rgba(200,200,140,' + (0.4 * sBoost.glowMult) + ')' : 'rgba(255,220,80,' + (0.4 * sBoost.glowMult) + ')');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      skyCtx.beginPath(); skyCtx.arc(sx, sy, glowR, 0, Math.PI * 2);
      skyCtx.fillStyle = glow; skyCtx.fill();

      if (use3DSun) {
        place3DCelestial('sun', sx, sy, sunR);
      } else {
        /* 2D fallback disc (only when 3D not ready yet) */
        var sunGrad = skyCtx.createRadialGradient(sx - sunR * 0.25, sy - sunR * 0.25, 0, sx, sy, sunR);
        sunGrad.addColorStop(0, grey ? '#e8e8c0' : '#fff7a0');
        sunGrad.addColorStop(0.6, grey ? '#c8c880' : '#ffd040');
        sunGrad.addColorStop(1, grey ? '#a8a860' : '#ff8800');
        skyCtx.beginPath(); skyCtx.arc(sx, sy, sunR, 0, Math.PI * 2);
        skyCtx.fillStyle = sunGrad; skyCtx.fill();
      }
    }

    var moonHours = (hours + 12) % 24;
    var moonShown = false;
    if ((hours > 17 || hours < 7) && !sunVisible) {
      var mprog = (moonHours - sunrise) / dayLen;
      if (mprog >= 0 && mprog <= 1) {
        var melev = Math.sin(Math.PI * mprog);
        var mx = mprog * W;
        var my = H * (0.85 - melev * 0.60);
        /* CELESTIAL_SIZE_MULT scales the final size — see constant above */
        var moonR = Math.max(20, Math.min(36, W * 0.024)) * CELESTIAL_SIZE_MULT;

        var mBoost = celestialBoost('moon');
        moonR *= mBoost.scale;
        celestialHit = { type: 'moon', x: mx, y: my, r: moonR };
        moonShown = true;

        /* Outer 2D glow — kept in both modes; blends with the shader aura */
        var mglowR = moonR * 2.2 * (1 + (mBoost.glowMult - 1) * 0.5);
        var mglow = skyCtx.createRadialGradient(mx, my, moonR * 0.4, mx, my, mglowR);
        mglow.addColorStop(0, grey ? 'rgba(160,170,180,' + (0.3 * mBoost.glowMult) + ')' : 'rgba(200,220,255,' + (0.28 * mBoost.glowMult) + ')');
        mglow.addColorStop(1, 'rgba(0,0,0,0)');
        skyCtx.beginPath(); skyCtx.arc(mx, my, mglowR, 0, Math.PI * 2);
        skyCtx.fillStyle = mglow; skyCtx.fill();

        if (use3DMoon) {
          place3DCelestial('moon', mx, my, moonR);
        } else {
          /* ── 2D fallback: original phase-shaded flat disc ─────────── */
          var phaseFrac    = getMoonPhaseFrac();
          var southernHemi = isSouthernHemi();

          skyCtx.save();
          skyCtx.beginPath();
          skyCtx.arc(mx, my, moonR, 0, Math.PI * 2);
          skyCtx.clip();

          skyCtx.beginPath();
          skyCtx.arc(mx, my, moonR, 0, Math.PI * 2);
          skyCtx.fillStyle = grey ? '#c0c8d0' : '#e8f0ff';
          skyCtx.fill();

          var shadowColor = grey ? '#2a2e3a' : '#0a0e20';
          var waxing = phaseFrac < 0.5;
          if (southernHemi) waxing = !waxing;
          var illum = getMoonIllum(phaseFrac);
          var ellHalfW = Math.abs(Math.cos(2 * Math.PI * phaseFrac)) * moonR;
          var gibbous = illum > 0.5;

          if (illum < 0.999) {
            skyCtx.beginPath();
            if (waxing) {
              skyCtx.arc(mx, my, moonR, Math.PI / 2, Math.PI * 1.5, true);
              skyCtx.ellipse(mx, my, ellHalfW, moonR, 0, Math.PI * 1.5, Math.PI / 2, !gibbous);
            } else {
              skyCtx.arc(mx, my, moonR, -Math.PI / 2, Math.PI / 2, false);
              skyCtx.ellipse(mx, my, ellHalfW, moonR, 0, Math.PI / 2, -Math.PI / 2, gibbous);
            }
            skyCtx.closePath();
            /* Even in 2D fallback, keep dark side at ~10% opacity per spec */
            skyCtx.globalAlpha = 0.9;
            skyCtx.fillStyle = shadowColor;
            skyCtx.fill();
            skyCtx.globalAlpha = 1;
          }
          skyCtx.restore();

          skyCtx.beginPath();
          skyCtx.arc(mx, my, moonR, 0, Math.PI * 2);
          skyCtx.strokeStyle = grey ? 'rgba(255,255,255,.12)' : 'rgba(220,230,255,.18)';
          skyCtx.lineWidth = 1;
          skyCtx.stroke();
        }
      }
    }

    /* If neither is showing this frame, clear any lingering 3D placement */
    if (!sunVisible && !moonShown) clear3DCelestial();
  }

  function skyLoop() {
    if (!isVisible || (colorTheme !== 'live' && colorTheme !== 'grey')) return;
    skyT += 0.033;
    drawSkyFrame();
    render3D();
    skyRaf = requestAnimationFrame(skyLoop);
  }

  function startSkyEngine() {
    if (!skyCtx) initSkyEngine();
    ensure3D();
    /* Match 3D canvas size to viewport now that it may have changed */
    if (threeRenderer) resize3D();
    cancelAnimationFrame(skyRaf);
    skyLoop();
  }
  function stopSkyEngine() {
    cancelAnimationFrame(skyRaf);
    if (skyCtx) skyCtx.clearRect(0, 0, skyW, skyH);
    clear3DCelestial();
    if (threeRenderer) { render3D(); /* one final clear pass */ }
    celestialHit = null;
    celestialHover = null;
    celestialBurst = null;
    overlay.style.cursor = '';
  }

  /* ════════════════════════════════════════════════════
     SUN / MOON HOVER + CLICK + DRAG-TO-ROTATE
     Hover → aura glow.
     Click (no drag) → 10% size pop + brighter glow, eases out over 2s.
     Drag / swipe → manually rotate the sphere. Auto-spin pauses while
     dragging and resumes DRAG_RESUME_MS after release, continuing from
     wherever the user left it.
  ════════════════════════════════════════════════════ */

  /* Is a point inside the currently drawn sun/moon disc? */
  function hitsCelestial(px, py) {
    if (!celestialHit) return false;
    var dx = px - celestialHit.x, dy = py - celestialHit.y;
    return (dx * dx + dy * dy) <= (celestialHit.r * celestialHit.r);
  }

  var DRAG_CLICK_THRESHOLD = 6; /* px of movement before it counts as a drag, not a click */

  function beginDrag(px, py) {
    if (!hitsCelestial(px, py)) return false;
    dragState.active = true;
    dragState.type   = celestialHit.type;
    dragState.lastX  = px;
    dragState.lastY  = py;
    dragState.moved  = 0;
    return true;
  }

  function moveDrag(px, py) {
    if (!dragState.active) return;
    var dx = px - dragState.lastX;
    var dy = py - dragState.lastY;
    dragState.lastX = px;
    dragState.lastY = py;
    dragState.moved += Math.abs(dx) + Math.abs(dy);

    var manual = (dragState.type === 'moon') ? moonManualRot : sunManualRot;
    /* Horizontal drag spins around Y, vertical drag tumbles around X */
    manual.y += dx * DRAG_SENSITIVITY;
    manual.x += dy * DRAG_SENSITIVITY;
  }

  function endDrag() {
    if (!dragState.active) return;
    var wasClick = dragState.moved < DRAG_CLICK_THRESHOLD;
    var type = dragState.type;
    dragState.active = false;
    dragState.releasedAt = performance.now();
    /* A tap/click with negligible movement still triggers the glow burst */
    if (wasClick && type) {
      celestialBurst = { type: type, start: Date.now() };
    }
  }

  /* ── Mouse ── */
  overlay.addEventListener('mousedown', function (e) {
    if (beginDrag(e.clientX, e.clientY)) {
      e.preventDefault();
      overlay.style.cursor = 'grabbing';
    }
  });

  overlay.addEventListener('mousemove', function (e) {
    if (dragState.active) {
      moveDrag(e.clientX, e.clientY);
      return;
    }
    /* Hover feedback only when not dragging */
    if (!celestialHit) {
      if (overlay.style.cursor) overlay.style.cursor = '';
      celestialHover = null;
      return;
    }
    var within = hitsCelestial(e.clientX, e.clientY);
    celestialHover = within ? celestialHit.type : null;
    overlay.style.cursor = within ? 'grab' : '';
  }, { passive: true });

  window.addEventListener('mouseup', function () {
    if (dragState.active) {
      endDrag();
      overlay.style.cursor = celestialHover ? 'grab' : '';
    }
  });

  /* ── Touch ── */
  overlay.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    if (!t) return;
    if (beginDrag(t.clientX, t.clientY)) {
      /* Prevent the page from scrolling while rotating the sphere */
      e.preventDefault();
    }
  }, { passive: false });

  overlay.addEventListener('touchmove', function (e) {
    if (!dragState.active) return;
    var t = e.touches[0];
    if (!t) return;
    e.preventDefault();
    moveDrag(t.clientX, t.clientY);
  }, { passive: false });

  overlay.addEventListener('touchend', endDrag);
  overlay.addEventListener('touchcancel', endDrag);

  /* ════════════════════════════════════════════════════
     PUBLIC API
     There's no built-in "secret tap" trigger — wire any button,
     keyboard shortcut, or event on your own site to these instead:
       ClockOverlay.show()                open the overlay
       ClockOverlay.hide()                close it
       ClockOverlay.toggle()              open/close
       ClockOverlay.openDeveloperPanel()  jump straight to the
                                           developer/diagnostics panel
  ════════════════════════════════════════════════════ */
  window.ClockOverlay = {
    show: showClock,
    hide: hideClock,
    toggle: function () { if (isVisible) hideClock(); else showClock(); },
    openDeveloperPanel: function () {
      showClock();
      openDeveloperPanel();
    }
  };
})();
