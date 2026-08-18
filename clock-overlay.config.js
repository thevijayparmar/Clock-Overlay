/**
 * clock-overlay.config.js — settings for clock-overlay.js
 * ===================================================================
 * Edit THIS file, not clock-overlay.js. Every field below is optional;
 * anything you delete or leave out just falls back to the default
 * already shown here. Load this file BEFORE clock-overlay.js:
 *
 *   <script src="clock-overlay.config.js"></script>
 *   <script src="clock-overlay.js" defer></script>
 */
window.ClockOverlayConfig = {

  /* How long (ms) the page must go without a scroll before the clock
   * opens automatically. Set to a very large number to effectively
   * disable idle auto-open (you can still open it manually — see
   * window.ClockOverlay in the README). */
  idleTimeoutMs: 3 * 60 * 1000, // 3 minutes

  /* Whether the settings panel (left-hand icon column) starts
   * collapsed the first time the overlay opens. The gear/settings
   * button always lets the visitor toggle it either way. */
  startMinimized: true,

  /* Page background theme when the overlay first opens.
   * One of: 'light' | 'dark' | 'live' | 'grey'
   * ('live' and 'grey' are the two that show the animated sky.) */
  defaultColorTheme: 'live',

  /* Clock face shown when the overlay first opens.
   * One of: 'digital' | 'digital-big' | 'hybrid' | 'analog' | 'analog-big' */
  defaultClockTheme: 'digital',

  /* Which sky effects are on by default (only visible on the 'live'
   * and 'grey' color themes). The visitor can still toggle each one
   * individually via the 🌏 ring menu; this just sets the starting
   * state. `master` is the ring menu's overall on/off switch. */
  skyEffects: {
    master: true,
    cloud: false,
    rain: false,
    breeze: true,
    thunder: false,
    snow: false,
    fog: false,
    wave: true,
    night: true
  },

  /* Whether to auto-fetch weather + air quality (via the free, keyless
   * ipwho.is + open-meteo.com APIs) to populate the date/weather row
   * and to auto-pick sensible sky effects for current conditions.
   * Set to false to skip these network calls entirely. */
  enableWeather: true,

  /* Overall size multiplier for the flat 2D sun/moon glow + disc.
   * 1.0 = original size. */
  celestialSize: 1.2,

  /* Overall size multiplier for the 3D textured sun/moon sphere.
   * 1.0 = original size. */
  celestialSizeMult: 2,

  /* Texture images for the 3D sun/moon (equirectangular JPGs work
   * best). Paths are resolved relative to the page that includes
   * clock-overlay.js, same as any other <img> src. If an image 404s
   * or Three.js can't load, the overlay falls back automatically to
   * a flat, phase-shaded 2D disc — nothing breaks either way. */
  moonTextureUrl: 'moon-map.jpg',
  sunTextureUrl: 'sun-map.jpg'

};
