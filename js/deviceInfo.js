// ─────────────────────────────────────────────────────────────
// samplux — device / technical paradata
// ─────────────────────────────────────────────────────────────
// Everything a browser hands over without asking the user anything
// (no permission prompts, no external services). Stored on the response
// doc as `deviceInfo`, next to the older `browserData`. Every read is
// guarded: browsers differ a lot (Safari has no deviceMemory/connection,
// Firefox has no userAgentData, etc.) and a missing API must never block
// a submit. The server-side IP address is NOT available to a static site
// and is deliberately not collected.
// ─────────────────────────────────────────────────────────────

const safe = (fn) => { try { const v = fn(); return v === undefined ? null : v; } catch { return null; } };

function webglInfo() {
  return safe(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    };
  });
}

// Snapshot taken at submit time (viewport/orientation/connection can change mid-survey).
export async function collectDeviceInfo() {
  const nav = navigator;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection || null;
  const mm = (q) => safe(() => window.matchMedia(q).matches);

  const info = {
    collectedAt: new Date().toISOString(),
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    languages: safe(() => Array.from(nav.languages || [])),
    viewport: { w: window.innerWidth, h: window.innerHeight, outerW: window.outerWidth, outerH: window.outerHeight },
    screen: {
      w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight,
      pixelRatio: window.devicePixelRatio, colorDepth: screen.colorDepth,
      orientation: safe(() => screen.orientation && screen.orientation.type),
      orientationAngle: safe(() => screen.orientation && screen.orientation.angle)
    },
    hardware: {
      cores: nav.hardwareConcurrency ?? null,
      memoryGB: nav.deviceMemory ?? null,           // Chromium only, capped/rounded by the browser
      maxTouchPoints: nav.maxTouchPoints ?? null,
      webgl: webglInfo()
    },
    connection: conn ? {
      type: conn.type ?? null, effectiveType: conn.effectiveType ?? null,
      downlinkMbps: conn.downlink ?? null, rttMs: conn.rtt ?? null, saveData: conn.saveData ?? null
    } : null,
    prefs: {
      colorScheme: mm('(prefers-color-scheme: dark)') ? 'dark' : 'light',
      reducedMotion: mm('(prefers-reduced-motion: reduce)'),
      standalone: mm('(display-mode: standalone)') || nav.standalone === true,
      pointerCoarse: mm('(pointer: coarse)'),
      hoverCapable: mm('(hover: hover)')
    },
    support: {
      mediaRecorder: typeof window.MediaRecorder !== 'undefined',
      getUserMedia: !!(nav.mediaDevices && nav.mediaDevices.getUserMedia),
      cookies: nav.cookieEnabled,
      localStorage: safe(() => { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); return true; }) === true,
      doNotTrack: nav.doNotTrack ?? null,
      secureContext: window.isSecureContext
    },
    page: {
      loadMs: safe(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? Math.round(n.loadEventEnd || n.domContentLoadedEventEnd) : null; }),
      navigationType: safe(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? n.type : null; }),
      historyLength: safe(() => history.length)
    }
  };

  // User-Agent Client Hints (Chromium): model / OS version are only in the high-entropy part.
  const uad = nav.userAgentData;
  if (uad) {
    info.uaData = { mobile: uad.mobile, platform: uad.platform, brands: (uad.brands || []).map(b => `${b.brand} ${b.version}`).join('; ') };
    try {
      const he = await Promise.race([
        uad.getHighEntropyValues(['model', 'platformVersion', 'architecture', 'bitness', 'fullVersionList']),
        new Promise(res => setTimeout(() => res(null), 800))
      ]);
      if (he) {
        info.uaData.model = he.model || null;
        info.uaData.platformVersion = he.platformVersion || null;
        info.uaData.architecture = he.architecture || null;
        info.uaData.bitness = he.bitness || null;
        info.uaData.fullVersionList = (he.fullVersionList || []).map(b => `${b.brand} ${b.version}`).join('; ');
      }
    } catch { /* ignore */ }
  }
  return info;
}

// Tab-visibility paradata: how often and how long the survey was in the background
// (switching to WhatsApp, locking the phone, …). Returns { snapshot() }.
export function watchVisibility() {
  let hiddenCount = 0, hiddenMs = 0, hiddenSince = null;
  const onChange = () => {
    if (document.visibilityState === 'hidden') { hiddenCount += 1; hiddenSince = Date.now(); }
    else if (hiddenSince) { hiddenMs += Date.now() - hiddenSince; hiddenSince = null; }
  };
  document.addEventListener('visibilitychange', onChange);
  return {
    snapshot: () => ({ hiddenCount, hiddenMs: hiddenMs + (hiddenSince ? Date.now() - hiddenSince : 0) }),
    stop: () => document.removeEventListener('visibilitychange', onChange)
  };
}
