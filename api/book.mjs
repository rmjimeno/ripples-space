/* ============================================================
   POST /api/book

   Body: { start, name, email, service, budget, phone?, notes?, timezone?, company? }
     start    UTC ISO instant, must match one of the open slots
     service  must be one of SERVICES
     budget   must be one of BUDGETS
     notes    the visitor's free-text message
     company  honeypot — real people never fill this in

   service and budget are folded into the appointment notes, and additionally
   written to contact custom fields when GHL_FIELD_SERVICE / GHL_FIELD_BUDGET
   are set. Those accept a field id, a fieldKey (contact.budget_range), the
   field's name, or the merge-tag form — and must name a CONTACT field.

   Creates (or updates) the contact, then books the appointment, so the
   booking shows up in GHL exactly as the old widget's did.
   ============================================================ */

import {
  requireEnv,
  ghlFetch,
  fetchFreeSlots,
  fetchCalendarDuration,
  fetchFormFields,
  fetchCustomFieldIndex,
  lookupField,
  sendJson,
  CALENDAR_ID,
  DEFAULT_CALL_MINUTES,
  MAX_SLOT_RANGE_DAYS,
  VERSION_CALENDARS,
  VERSION_CONTACTS
} from "./_ghl.mjs";

/* Deliberately permissive. Server-side email regexes that try to be clever
   reject valid addresses; the real validation is that the invite arrives. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/* Kept in sync with SERVICES / BUDGETS in booking.js. Re-checked here so a
   caller can't post an arbitrary string into the calendar. */
const SERVICES = [
  "Branding & Website",
  "CRM & Automation",
  "Custom Business App",
  "Not sure yet, I'd like your recommendation",
  "Something else"
];
const BUDGETS = [
  "Under $2,000",
  "$2,000–$5,000",
  "$5,000–$10,000",
  "$10,000+",
  "I'd like to discuss this further."
];

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return {};
}

/** GHL stores first/last separately; people type one string. */
function splitName(full) {
  const parts = String(full).trim().split(/\s+/);
  return {
    firstName: parts[0] || "",
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : ""
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  let payload;
  try {
    const { token, locationId } = requireEnv();
    const body = readBody(req);
    if (!body) return sendJson(res, 400, { error: "Invalid JSON body" });

    /* Honeypot. Answer as if it worked — a bot that gets a clean error learns
       how to get past the check next time. Nothing is written. */
    if (typeof body.company === "string" && body.company.trim() !== "") {
      console.warn("[/api/book] honeypot triggered");
      return sendJson(res, 200, { ok: true, start: body.start ?? null });
    }

    /* ---- validate ---- */
    const errors = {};
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim();
    const phone = String(body.phone ?? "").trim();
    const service = String(body.service ?? "").trim();
    const budget = String(body.budget ?? "").trim();
    const message = String(body.notes ?? "").trim().slice(0, 1000);
    const timezone = String(body.timezone ?? "").trim();

    if (!name) errors.name = "Enter your first name.";
    if (!email) errors.email = "Enter your email address.";
    else if (!EMAIL_RE.test(email)) errors.email = "Enter an email address in the format name@example.com.";
    if (!service) errors.service = "Choose what I can help you with.";
    else if (!SERVICES.includes(service)) errors.service = "Choose one of the listed options.";
    if (!budget) errors.budget = "Choose your planned investment.";
    else if (!BUDGETS.includes(budget)) errors.budget = "Choose one of the listed options.";

    const startMs = Date.parse(body.start);
    if (!body.start || Number.isNaN(startMs)) errors.start = "Choose a time.";

    if (Object.keys(errors).length) return sendJson(res, 422, { error: "Validation failed", fields: errors });

    const startIso = new Date(startMs).toISOString();

    /* ---- the slot must actually be open ----
       Without this the endpoint would happily write any timestamp a caller
       invents into the calendar. It also closes the race where two people
       load the page and pick the same slot.

       Duration is read here rather than trusted from the client, so changing
       the calendar length in GHL is picked up without a redeploy. */
    /* The window must cover the requested slot without exceeding GHL's 31-day
       limit, so it is derived from the slot rather than fixed. Anything past
       the limit is outside the booking horizon and is refused here. */
    const daysAhead = Math.ceil((startMs - Date.now()) / 86400000) + 1;
    if (daysAhead > MAX_SLOT_RANGE_DAYS) {
      return sendJson(res, 422, { error: "That time is outside the booking window.", fields: { start: "Choose a time." } });
    }

    /* One custom-field lookup serves both GHL_FORM_FIELDS and the optional
       service/budget mapping below, so configuring them costs no extra call. */
    const wantsFieldIndex = Boolean(
      process.env.GHL_FORM_FIELDS || process.env.GHL_FIELD_SERVICE || process.env.GHL_FIELD_BUDGET
    );

    const [avail, cal, fieldIndex] = await Promise.all([
      fetchFreeSlots({ token, timezone: timezone || undefined, days: Math.max(daysAhead, 1) }),
      fetchCalendarDuration(token),
      wantsFieldIndex ? fetchCustomFieldIndex({ token, locationId }) : null
    ]);

    /* Re-resolved here rather than trusted from the client — otherwise a
       caller could simply drop the required fields from their payload. */
    const formFields = await fetchFormFields({ token, locationId, index: fieldIndex });
    const { slots } = avail;
    const endIso = new Date(startMs + (cal.minutes || DEFAULT_CALL_MINUTES) * 60 * 1000).toISOString();

    /* ---- custom fields ---- */
    const submitted = (body.custom && typeof body.custom === "object") ? body.custom : {};
    const customErrors = {};
    const customFieldValues = [];

    for (const f of formFields) {
      let value = submitted[f.id];
      if (Array.isArray(value)) value = value.filter((v) => v !== null && v !== undefined && String(v).trim() !== "");
      else if (value !== null && value !== undefined) value = String(value).trim();

      const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
      if (empty) {
        if (f.required) {
          const verb = ["select", "checkbox", "date"].includes(f.type) ? "Choose" : "Enter";
          customErrors[f.id] = `${verb} ${f.label.toLowerCase()}.`;
        }
        continue;
      }

      /* A picklist must contain one of its own options. */
      if (f.options.length) {
        const allowed = new Set(f.options.map(String));
        const picked = Array.isArray(value) ? value : [value];
        if (picked.some((v) => !allowed.has(String(v)))) {
          customErrors[f.id] = "Choose one of the listed options.";
          continue;
        }
      }

      customFieldValues.push({ id: f.id, field_value: value });
    }

    if (Object.keys(customErrors).length) {
      return sendJson(res, 422, { error: "Validation failed", custom: customErrors });
    }
    if (!slots.includes(startIso)) {
      return sendJson(res, 409, { error: "That time is no longer available." });
    }

    /* ---- what gets written where ----
       The dropdown answers always go into the appointment notes, so they are
       visible on the booking itself with no GHL setup at all. Set
       GHL_FIELD_SERVICE / GHL_FIELD_BUDGET to a contact custom-field id to
       ALSO store them on the contact, where they can be filtered and used in
       workflows. */
    const notes = [
      `What can I help you with: ${service}`,
      `Planned investment: ${budget}`,
      ...(message ? ["", message] : [])
    ].join("\n");

    for (const [envVar, value] of [["GHL_FIELD_SERVICE", service], ["GHL_FIELD_BUDGET", budget]]) {
      const ref = process.env[envVar];
      if (!ref) continue;
      const f = lookupField(fieldIndex, ref);
      if (!f) {
        /* Loud, but not fatal — the answer is still in the appointment notes.
           Almost always a typo, or an opportunity field (those live on a
           different model and can't be written via /contacts/upsert). */
        console.warn(`[ghl] ${envVar}="${ref}" matches no contact custom field; skipping`);
        continue;
      }
      customFieldValues.push({ id: f.id, field_value: value });
    }

    /* ---- contact ---- */
    const { firstName, lastName } = splitName(name);
    const contact = await ghlFetch("/contacts/upsert", {
      token,
      version: VERSION_CONTACTS,
      method: "POST",
      body: {
        locationId,
        firstName,
        lastName,
        name,
        email,
        ...(phone ? { phone } : {}),
        ...(timezone ? { timezone } : {}),
        ...(customFieldValues.length ? { customFields: customFieldValues } : {}),
        source: "ripples.space booking"
      }
    });

    const contactId = contact?.contact?.id || contact?.id;
    if (!contactId) {
      console.error("[/api/book] no contactId in upsert response", contact);
      return sendJson(res, 502, { error: "Could not save your details." });
    }

    /* ---- appointment ----
       ignoreFreeSlotValidation:false makes GHL re-check availability too, so a
       slot taken between our check and this call fails here rather than
       double-booking. */
    const appt = await ghlFetch("/calendars/events/appointments", {
      token,
      version: VERSION_CALENDARS,
      method: "POST",
      body: {
        calendarId: CALENDAR_ID,
        locationId,
        contactId,
        startTime: startIso,
        endTime: endIso,
        title: `Automation strategy call — ${name}`,
        appointmentStatus: "confirmed",
        ignoreFreeSlotValidation: false,
        toNotify: true,
        ...(notes ? { notes } : {})
      }
    });

    return sendJson(res, 200, {
      ok: true,
      start: startIso,
      end: endIso,
      appointmentId: appt?.id ?? appt?.appointment?.id ?? null
    });
  } catch (err) {
    console.error("[/api/book]", err.message, err.ghl ?? "");
    /* GHL returns 400/422 when the slot went away between our check and theirs.
       That's a collision from the visitor's point of view, not a bad request. */
    if (err.statusCode === 400 || err.statusCode === 422) {
      return sendJson(res, 409, { error: "That time is no longer available." });
    }
    return sendJson(res, 502, { error: "Could not complete your booking." });
  }
}
