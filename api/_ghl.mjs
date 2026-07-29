/* ============================================================
   Shared GoHighLevel API helpers.

   The Private Integration Token must never reach the browser, so every
   GHL call goes through these serverless functions. Nothing here is
   imported by client code.
   ============================================================ */

export const GHL_BASE = "https://services.leadconnectorhq.com";

/* GHL versions its API groups independently and rejects the wrong value
   with a confusing 401. Calendars are pinned to 2021-04-15; contacts to
   2021-07-28. Getting these backwards is the most common integration bug. */
export const VERSION_CALENDARS = "2021-04-15";
export const VERSION_CONTACTS = "2021-07-28";

/* The calendar id is already public — it sits in the old widget URL — so a
   default is fine. The token and location id are not, and have no default. */
export const CALENDAR_ID = process.env.GHL_CALENDAR_ID || "gsg9HnVtgyetrzjWUPlN";

/* Only used if the calendar's real duration can't be read. */
export const DEFAULT_CALL_MINUTES = 30;

/** Throws if the deploy is missing its secrets, so failures are legible. */
export function requireEnv() {
  const token = process.env.GHL_PIT;
  const locationId = process.env.GHL_LOCATION_ID;
  const missing = [];
  if (!token) missing.push("GHL_PIT");
  if (!locationId) missing.push("GHL_LOCATION_ID");
  if (missing.length) {
    const err = new Error(`Missing environment variable(s): ${missing.join(", ")}`);
    err.statusCode = 500;
    throw err;
  }
  return { token, locationId };
}

/**
 * Fetch + parse a GHL endpoint. Times out rather than hanging the function.
 */
export async function ghlFetch(path, { token, version, method = "GET", body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${GHL_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: version,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
  } catch (e) {
    const err = new Error(e.name === "AbortError" ? "GHL request timed out" : "GHL request failed");
    err.statusCode = 504;
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* GHL occasionally returns an HTML error page; keep the raw text for logs. */
  }

  if (!res.ok) {
    const err = new Error(`GHL ${method} ${path} → ${res.status}`);
    err.statusCode = res.status;
    err.ghl = data ?? text.slice(0, 500);
    throw err;
  }
  return data;
}

/* Meta keys GHL mixes in alongside the date buckets. Not availability. */
const META_KEYS = new Set(["traceId", "_dates_", "statusCode", "message"]);

/**
 * Normalize the free-slots payload to a sorted, de-duplicated array of
 * UTC ISO instants.
 *
 * The documented shape is an availability map keyed by YYYY-MM-DD, where each
 * value is `{ slots: [...] }`. Slots come back as offset-bearing local strings
 * ("2026-08-14T09:00:00+08:00"), so `new Date()` parses them to the correct
 * instant regardless of the requested timezone. We deliberately tolerate a few
 * plausible variants rather than assuming one — see `?debug=1` on the endpoint.
 */
export function normalizeSlots(payload) {
  const out = [];

  const take = (value) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === "string") out.push(v);
        else if (v && typeof v === "object" && typeof v.startTime === "string") out.push(v.startTime);
      }
    } else if (typeof value === "object" && Array.isArray(value.slots)) {
      take(value.slots);
    }
  };

  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.slots)) take(payload.slots);
    for (const [key, value] of Object.entries(payload)) {
      if (META_KEYS.has(key) || key === "slots") continue;
      take(value);
    }
  }

  const seen = new Set();
  const instants = [];
  for (const raw of out) {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) continue;
    const iso = new Date(ms).toISOString();
    if (seen.has(iso)) continue;
    seen.add(iso);
    instants.push(iso);
  }
  instants.sort();
  return instants;
}

/* GHL hard-rejects a free-slots range wider than this. */
export const MAX_SLOT_RANGE_DAYS = 31;

/**
 * Free slots for a window. `startDate`/`endDate` are epoch milliseconds —
 * GHL rejects date strings on this endpoint.
 */
export async function fetchFreeSlots({ token, timezone, days = 28, from = Date.now() }) {
  const span = Math.min(Math.max(days, 1), MAX_SLOT_RANGE_DAYS);
  const endDate = from + span * 24 * 60 * 60 * 1000;
  const params = new URLSearchParams({ startDate: String(from), endDate: String(endDate) });
  if (timezone) params.set("timezone", timezone);

  const raw = await ghlFetch(`/calendars/${CALENDAR_ID}/free-slots?${params}`, {
    token,
    version: VERSION_CALENDARS
  });
  return { raw, slots: normalizeSlots(raw) };
}

/**
 * Read the calendar's configured appointment length so a duration change in
 * GHL flows through without a redeploy. Field naming has shifted across GHL
 * revisions, so several spellings are tried before falling back.
 */
export function calendarDurationMinutes(payload) {
  var cal = (payload && (payload.calendar || payload)) || {};
  var value = cal.slotDuration ?? cal.slotDurationMinutes ?? cal.duration ?? cal.appointmentDuration;
  var unit = String(cal.slotDurationUnit ?? cal.durationUnit ?? "mins").toLowerCase();
  var n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (unit.startsWith("hour") || unit === "hrs" || unit === "hr") n *= 60;
  /* Guard against a nonsense value locking people into a bad end time. */
  return n >= 5 && n <= 8 * 60 ? Math.round(n) : null;
}

/** Calendar config. Failure here is never fatal — callers fall back. */
export async function fetchCalendarDuration(token) {
  try {
    const data = await ghlFetch(`/calendars/${CALENDAR_ID}`, { token, version: VERSION_CALENDARS });
    return { minutes: calendarDurationMinutes(data), raw: data };
  } catch (err) {
    console.warn("[ghl] calendar lookup failed, using default duration:", err.message);
    return { minutes: null, raw: null };
  }
}

/* ============================================================
   Custom form fields

   GHL has no API that returns a *form's* field list — GET /forms/ returns
   only { id, name, locationId }, and although a calendar carries a formId
   there is no endpoint to resolve it into fields. So the fields to show are
   named explicitly in GHL_FORM_FIELDS, and everything about them (label,
   type, dropdown options) is then read live from GHL.

     GHL_FORM_FIELDS="contact.budget*,contact.industry"
                                    ^ trailing * marks it required
   ============================================================ */

/* GHL dataType -> how the widget should render it. Anything unlisted falls
   back to a text input; file/signature are dropped (see below). */
const FIELD_TYPES = {
  TEXT: "text",
  PHONE: "tel",
  EMAIL: "email",
  LARGE_TEXT: "textarea",
  TEXTAREA: "textarea",
  NUMERICAL: "number",
  MONETORY: "number",
  MONETARY: "number",
  DATE: "date",
  SINGLE_OPTIONS: "select",
  RADIO: "select",
  CHECKBOX: "checkbox",
  MULTIPLE_OPTIONS: "checkbox"
};

/* Uploads would mean accepting binaries from anonymous visitors — out of
   scope for a booking form, and silently dropping them is safer than a
   broken control. */
const UNSUPPORTED_TYPES = new Set(["FILE_UPLOAD", "SIGNATURE", "TEXTBOX_LIST"]);

export function parseFieldSpec(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => ({
      ref: s.replace(/\*$/, "").trim().toLowerCase(),
      required: s.endsWith("*")
    }));
}

/**
 * Every CONTACT custom field on the location, keyed by fieldKey, name and id
 * (all lowercased) so config can name whichever one is to hand. Returns null
 * if the lookup fails, so callers degrade instead of breaking.
 *
 * Contact fields only — opportunity fields are a different model and are not
 * writable through /contacts/upsert.
 */
export async function fetchCustomFieldIndex({ token, locationId }) {
  let data;
  try {
    data = await ghlFetch(`/locations/${locationId}/customFields?model=contact`, {
      token,
      version: VERSION_CONTACTS
    });
  } catch (err) {
    /* Never let this take the booking form down — worst case the visitor
       books without the extra questions. */
    console.warn("[ghl] custom field lookup failed:", err.message);
    return null;
  }

  const all = (data && (data.customFields || data.fields)) || [];
  const byRef = new Map();
  for (const f of all) {
    if (f.fieldKey) byRef.set(String(f.fieldKey).toLowerCase(), f);
    if (f.name) byRef.set(String(f.name).toLowerCase(), f);
    if (f.id) byRef.set(String(f.id).toLowerCase(), f);
  }
  return byRef;
}

/**
 * Resolve one configured reference against the index. Accepts the field id,
 * its fieldKey (`contact.budget_range`), its name, or the merge-tag form
 * (`{{contact.budget_range}}`) — whichever got copied out of GHL.
 */
export function lookupField(index, ref) {
  if (!index || !ref) return null;
  const clean = String(ref).trim().replace(/^\{\{/, "").replace(/\}\}$/, "").trim().toLowerCase();
  return index.get(clean) || null;
}

/**
 * Resolve GHL_FORM_FIELDS against the location's contact custom fields.
 * Returns [] when unset, so the form stays exactly as it is by default.
 * Pass `index` to reuse a lookup the caller already made.
 */
export async function fetchFormFields({ token, locationId, index }) {
  const spec = parseFieldSpec(process.env.GHL_FORM_FIELDS);
  if (!spec.length) return [];

  const byRef = index !== undefined ? index : await fetchCustomFieldIndex({ token, locationId });
  if (!byRef) return [];

  const out = [];
  for (const { ref, required } of spec) {
    const f = lookupField(byRef, ref);
    if (!f) {
      console.warn(`[ghl] GHL_FORM_FIELDS names "${ref}" but no such custom field exists`);
      continue;
    }
    const dataType = String(f.dataType || "TEXT").toUpperCase();
    if (UNSUPPORTED_TYPES.has(dataType)) {
      console.warn(`[ghl] custom field "${ref}" is ${dataType}, which the booking form can't render`);
      continue;
    }
    out.push({
      id: f.id,
      key: f.fieldKey || f.name,
      label: f.name || f.fieldKey,
      placeholder: f.placeholder || "",
      type: FIELD_TYPES[dataType] || "text",
      multiple: dataType === "MULTIPLE_OPTIONS" || dataType === "CHECKBOX",
      options: Array.isArray(f.picklistOptions) ? f.picklistOptions.filter(Boolean) : [],
      required: required
    });
  }
  return out;
}

/** Small helper so every handler returns JSON consistently. */
export function sendJson(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(status).send(JSON.stringify(body));
}
