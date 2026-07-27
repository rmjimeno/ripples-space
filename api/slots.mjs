/* ============================================================
   GET /api/slots

   Returns open booking times for the next N days as UTC instants.

     ?days=28              how far ahead to look (1–60, default 28)
     ?timezone=Asia/Manila IANA zone passed through to GHL
     ?debug=1              also echo GHL's raw payload

   The client fetches this once on mount and derives its date list from the
   instants, so changing timezone in the UI is a pure re-format with no refetch.
   ============================================================ */

import {
  requireEnv, fetchFreeSlots, fetchCalendarDuration, fetchFormFields, sendJson,
  DEFAULT_CALL_MINUTES, MAX_SLOT_RANGE_DAYS
} from "./_ghl.mjs";

/** Guards against passing junk through to GHL, and against ICU throwing later. */
function validTimezone(tz) {
  if (!tz || typeof tz !== "string") return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const { token, locationId } = requireEnv();

    /* GHL rejects a range wider than 31 days. */
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 1), MAX_SLOT_RANGE_DAYS);
    const timezone = validTimezone(req.query.timezone);

    /* In parallel — the config lookups must never add latency to availability. */
    const [avail, cal, customFields] = await Promise.all([
      fetchFreeSlots({ token, timezone, days }),
      fetchCalendarDuration(token),
      fetchFormFields({ token, locationId })
    ]);
    const { raw, slots } = avail;

    /* Availability is genuinely volatile, so keep this short. The shared cache
       window still absorbs the burst when several people land at once. */
    res.setHeader("Cache-Control", "public, max-age=0, s-maxage=60, stale-while-revalidate=120");

    return sendJson(res, 200, {
      slots,
      days,
      durationMinutes: cal.minutes || DEFAULT_CALL_MINUTES,
      customFields,
      timezone: timezone || null,
      ...(req.query.debug ? { raw, calendar: cal.raw } : {})
    });
  } catch (err) {
    console.error("[/api/slots]", err.message, err.ghl ?? "");
    return sendJson(res, err.statusCode >= 500 || !err.statusCode ? 502 : err.statusCode, {
      error: "Could not load availability"
    });
  }
}
