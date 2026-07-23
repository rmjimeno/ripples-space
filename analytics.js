/* ============================================================
   Ripples Space — Analytics + Heatmap loader
   Loads Google Analytics 4 (gtag.js) and Microsoft Clarity.

   >>> TO ACTIVATE: replace the two IDs below with your own. <<<
     • GA4:     Admin → Data streams → your web stream → "Measurement ID"  (looks like G-XXXXXXXXXX)
     • Clarity: Settings → Overview → "Clarity project ID"                 (a short alphanumeric code)

   Until real IDs are filled in, nothing loads (the guards below skip the
   placeholders), so this is safe to ship as-is.
   ============================================================ */
(function () {
  "use strict";

  var GA_MEASUREMENT_ID  = "G-XXXXXXXXXX"; // <-- add your Google Analytics 4 Measurement ID to enable GA4 (off for now)
  var CLARITY_PROJECT_ID = "xnicq3g0o1";   // Microsoft Clarity project ID (active)

  var gaReady = GA_MEASUREMENT_ID && GA_MEASUREMENT_ID.indexOf("XXXX") === -1;
  var clarityReady = CLARITY_PROJECT_ID && CLARITY_PROJECT_ID.indexOf("XXXX") === -1;

  /* --- Google Analytics 4 (gtag.js) --- */
  if (gaReady) {
    var s = document.createElement("script");
    s.async = true;
    s.src = "https://www.googletagmanager.com/gtag/js?id=" + GA_MEASUREMENT_ID;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag("js", new Date());
    window.gtag("config", GA_MEASUREMENT_ID);
  }

  /* --- Microsoft Clarity (heatmaps + session recordings) --- */
  if (clarityReady) {
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = "https://www.clarity.ms/tag/" + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, "clarity", "script", CLARITY_PROJECT_ID);
  }

  if (!gaReady && !clarityReady && window.console) {
    console.info("[analytics] Add your GA4 / Clarity IDs in analytics.js to enable tracking.");
  }
})();
