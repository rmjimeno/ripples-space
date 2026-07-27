/* ============================================================
   Ripples Space — accessible booking widget

   Replaces the GoHighLevel iframe. Renders its own DOM into any
   [data-bookcal] mount, so the same component serves the inline contact
   page and the modal on the two landing pages without duplicated markup.

   Availability and booking go through /api/slots and /api/book, which hold
   the GHL token server-side.

   Deliberately depends on nothing: no GSAP, no three.js. Both are CDN-loaded
   and can fail, and booking is the one path that must not.
   ============================================================ */
(function () {
  "use strict";

  var API_SLOTS = "/api/slots";
  var API_BOOK = "/api/book";
  var FALLBACK_EMAIL = "rheannejimeno@gmail.com";
  var MAILTO = "mailto:" + FALLBACK_EMAIL + "?subject=" + encodeURIComponent("Booking a call");
  var HORIZON_DAYS = 28;
  var DATES_BEFORE_MORE = 8;
  var TZ_STORAGE_KEY = "ripples-tz";

  var uid = 0;

  /* Locale comes from the page, timezone from the user. Formatting dates with
     the *browser* locale would render e.g. French month names inside
     lang="en" content, which is a 3.1.2 failure. */
  var LOCALE = document.documentElement.lang || "en";

  var COMMON_ZONES = [
    "Asia/Manila", "Asia/Singapore", "Asia/Dubai", "Asia/Kolkata", "Asia/Tokyo",
    "Australia/Sydney", "Europe/London", "Europe/Berlin",
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "UTC"
  ];

  /* ---------- tiny DOM helpers ---------- */

  function el(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === false || v === undefined) return;
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "html") node.innerHTML = v;
        else if (v === true) node.setAttribute(k, "");
        else node.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid) node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    });
    return node;
  }

  function show(node, on) {
    if (on) node.removeAttribute("hidden");
    else node.setAttribute("hidden", "");
  }

  /* ---------- date / timezone ---------- */

  function isValidZone(tz) {
    if (!tz) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch (e) { return false; }
  }

  function detectZone() {
    try {
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (isValidZone(tz)) return tz;
    } catch (e) {}
    return "Asia/Manila";
  }

  function storedZone() {
    try {
      var v = localStorage.getItem(TZ_STORAGE_KEY);
      return isValidZone(v) ? v : null;
    } catch (e) { return null; }
  }

  function storeZone(tz) {
    try { localStorage.setItem(TZ_STORAGE_KEY, tz); } catch (e) {}
  }

  /* en-CA formats as YYYY-MM-DD, which makes a sortable grouping key. */
  function dayKey(date, tz) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(date);
  }

  function fmt(date, tz, opts) {
    return new Intl.DateTimeFormat(LOCALE, Object.assign({ timeZone: tz }, opts)).format(date);
  }

  var f = {
    time: function (d, tz) { return fmt(d, tz, { hour: "numeric", minute: "2-digit" }); },
    dow: function (d, tz) { return fmt(d, tz, { weekday: "short" }); },
    dayMonth: function (d, tz) { return fmt(d, tz, { day: "numeric", month: "short" }); },
    monthYear: function (d, tz) { return fmt(d, tz, { month: "long", year: "numeric" }); },
    full: function (d, tz) { return fmt(d, tz, { weekday: "long", day: "numeric", month: "long", year: "numeric" }); },
    fullNoYear: function (d, tz) { return fmt(d, tz, { weekday: "long", day: "numeric", month: "long" }); },
    /* Long name for anything spoken — screen readers read "GMT+8" inconsistently. */
    zoneLong: function (d, tz) {
      var parts = new Intl.DateTimeFormat(LOCALE, { timeZone: tz, timeZoneName: "long" }).formatToParts(d);
      for (var i = 0; i < parts.length; i++) if (parts[i].type === "timeZoneName") return parts[i].value;
      return tz;
    },
    zoneShort: function (d, tz) {
      try {
        var parts = new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(d);
        for (var i = 0; i < parts.length; i++) if (parts[i].type === "timeZoneName") return parts[i].value;
      } catch (e) {}
      return "";
    }
  };

  /* ---------- the widget ---------- */

  function BookCal(mount) {
    var id = "bc" + (++uid);
    var variant = mount.getAttribute("data-variant") === "modal" ? "modal" : "inline";

    var state = {
      slots: [],            // Date objects, ascending
      tz: storedZone() || detectZone(),
      dayKey: null,         // selected YYYY-MM-DD in state.tz
      instant: null,        // selected Date
      duration: 30,
      step: 1,
      loaded: false,
      loading: false,
      sending: false,
      showAllDates: false,
      errors: {}
    };

    /* ---------- build ---------- */

    var root = el("div", { class: "bookcal bookcal--" + variant, role: "group", "aria-label": "Book a call" });

    var progress = el("ol", { class: "bookcal__progress", "aria-label": "Booking steps" }, [
      el("li", { class: "bookcal__progress-item", "aria-current": "step" }, [
        el("span", { class: "bookcal__progress-num", "aria-hidden": "true", text: "1" }), "Choose a time"
      ]),
      el("li", { class: "bookcal__progress-item" }, [
        el("span", { class: "bookcal__progress-num", "aria-hidden": "true", text: "2" }), "Your details"
      ])
    ]);
    var progressItems = progress.querySelectorAll(".bookcal__progress-item");

    /* The only live region in the widget. Visible, because sighted users need
       "loading" and "6 times available" too. */
    var status = el("p", { class: "bookcal__status", id: id + "-status", role: "status", "aria-atomic": "true" });

    var tzSelect = el("select", { class: "bookcal__select", id: id + "-tz", name: "timezone" });
    var tzBlock = el("div", { class: "bookcal__tz" }, [
      el("label", { class: "bookcal__label", for: id + "-tz", text: "Time zone" }),
      tzSelect
    ]);

    var dateChips = el("div", { class: "bookcal__chips" });
    var dateGroupBody = el("div", {}, [dateChips]);
    var moreBtn = el("button", { type: "button", class: "btn btn--ghost bookcal__more", text: "Show more dates" });
    show(moreBtn, false);
    var dateGroup = el("fieldset", { class: "bookcal__group bookcal__group--dates" }, [
      el("legend", { class: "bookcal__legend", text: "Date" }),
      dateGroupBody,
      moreBtn
    ]);

    var timeLegend = el("legend", { class: "bookcal__legend" });
    var timeChips = el("div", { class: "bookcal__chips" });
    var timeGroup = el("fieldset", { class: "bookcal__group bookcal__group--times" }, [timeLegend, timeChips]);
    show(timeGroup, false);

    var panel = el("div", { class: "bookcal__panel", "aria-busy": "false" }, [dateGroup, timeGroup]);

    var nextBtn = el("button", { type: "button", class: "btn btn--ink bookcal__next", "aria-disabled": "true", text: "Continue" });

    /* Text is set from the calendar's real duration once slots load. */
    var stepNote = el("p", { class: "bookcal__step-note", text: "Video call." });

    var step1 = el("div", { class: "bookcal__step bookcal__step--when" }, [
      el("h3", { class: "bookcal__step-title", id: id + "-s1-title", tabindex: "-1", text: "Choose a time" }),
      stepNote,
      tzBlock,
      status,
      panel,
      el("div", { class: "bookcal__actions" }, [nextBtn])
    ]);

    /* --- step 2 --- */
    var errorBox = el("div", { class: "bookcal__errors", id: id + "-errors", tabindex: "-1" });
    var errorList = el("ul", { class: "bookcal__errors-list" });
    errorBox.appendChild(el("h4", { class: "bookcal__errors-title", text: "There is a problem" }));
    errorBox.appendChild(errorList);
    show(errorBox, false);

    var summaryWhen = el("dd", { class: "bookcal__summary-value" });
    var summaryZone = el("dd", { class: "bookcal__summary-value" });
    var summary = el("dl", { class: "bookcal__summary" }, [
      el("div", { class: "bookcal__summary-row" }, [el("dt", { class: "bookcal__summary-term", text: "When" }), summaryWhen]),
      el("div", { class: "bookcal__summary-row" }, [el("dt", { class: "bookcal__summary-term", text: "Time zone" }), summaryZone])
    ]);

    var fields = {};
    function field(name, label, opts) {
      opts = opts || {};
      var fid = id + "-" + name;
      var describedBy = [];
      var wrap = el("div", { class: "bookcal__field" });

      var labelKids = [label];
      if (opts.optional) labelKids.push(" ", el("span", { class: "bookcal__optional", text: "(optional)" }));
      wrap.appendChild(el("label", { class: "bookcal__label", for: fid }, labelKids));

      if (opts.hint) {
        describedBy.push(fid + "-hint");
        wrap.appendChild(el("p", { class: "bookcal__hint", id: fid + "-hint", text: opts.hint }));
      }

      /* The error node is always present, empty when valid, so aria-describedby
         never points at a missing element and never needs rewriting. */
      var errNode = el("p", { class: "bookcal__error", id: fid + "-error" });
      describedBy.push(fid + "-error");
      wrap.appendChild(errNode);

      var input = el(opts.multiline ? "textarea" : "input", {
        class: opts.multiline ? "bookcal__textarea" : "bookcal__input",
        id: fid, name: name,
        type: opts.multiline ? null : (opts.type || "text"),
        rows: opts.multiline ? "4" : null,
        maxlength: opts.maxlength || null,
        inputmode: opts.inputmode || null,
        autocomplete: opts.autocomplete || null,
        spellcheck: opts.spellcheck || null,
        required: opts.required ? true : null,
        "aria-describedby": describedBy.join(" ")
      });
      wrap.appendChild(input);

      fields[name] = { input: input, error: errNode, label: label, wrap: wrap };
      return wrap;
    }

    /* Populated from /api/slots once the calendar's field list is known. */
    var customHost = el("div", { class: "bookcal__custom" });
    var customFields = [];

    var backBtn = el("button", { type: "button", class: "btn btn--ghost bookcal__back", text: "Back to times" });
    var submitBtn = el("button", { type: "submit", class: "btn btn--ink bookcal__submit", text: "Confirm booking" });

    var step2 = el("div", { class: "bookcal__step bookcal__step--details" }, [
      el("h3", { class: "bookcal__step-title", id: id + "-s2-title", tabindex: "-1", text: "Your details" }),
      errorBox,
      summary,
      field("name", "Your name", { required: true, autocomplete: "name" }),
      field("email", "Email address", {
        required: true, type: "email", inputmode: "email", autocomplete: "email",
        spellcheck: "false", hint: "I'll send the calendar invite here."
      }),
      field("phone", "Phone number", { optional: true, type: "tel", inputmode: "tel", autocomplete: "tel" }),
      field("notes", "What would you like help with?", {
        optional: true, multiline: true, maxlength: "1000",
        hint: "A sentence or two is plenty. 1000 characters max."
      }),
      /* Custom fields from the GHL calendar land here, between the built-in
         questions and the actions. */
      customHost,
      el("div", { class: "bookcal__hp", "aria-hidden": "true" }, [
        el("label", { for: id + "-company", text: "Company" }),
        el("input", { id: id + "-company", name: "company", type: "text", tabindex: "-1", autocomplete: "off" })
      ]),
      el("div", { class: "bookcal__actions" }, [backBtn, submitBtn])
    ]);
    show(step2, false);

    var form = el("form", { class: "bookcal__form", novalidate: true }, [step1, step2]);

    /* --- terminal states --- */
    var doneTitle = el("h3", { class: "bookcal__done-title", tabindex: "-1", text: "You're booked" });
    var doneBody = el("p", { class: "bookcal__done-body" });
    var doneActions = el("p", { class: "bookcal__done-actions" });
    var donePanel = el("div", { class: "bookcal__done" }, [doneTitle, doneBody, doneActions]);
    show(donePanel, false);

    var noticeTitle = el("h3", { class: "bookcal__notice-title", tabindex: "-1", text: "Couldn't load available times" });
    var noticeBody = el("p", {});
    var retryBtn = el("button", { type: "button", class: "btn btn--ghost bookcal__retry", text: "Try again" });
    var noticePanel = el("div", { class: "bookcal__notice" }, [noticeTitle, noticeBody, retryBtn]);
    show(noticePanel, false);

    root.appendChild(progress);
    root.appendChild(form);
    root.appendChild(donePanel);
    root.appendChild(noticePanel);

    mount.textContent = "";
    mount.appendChild(root);

    /* ---------- announcements ---------- */

    /* Setting identical text twice is silently ignored by AT, so clear first,
       then set on a later task.

       setTimeout, not requestAnimationFrame: rAF does not run at all while the
       document is hidden, so a background tab would swallow every announcement
       and the status line would stay blank when the visitor came back. */
    var sayTimer = null;
    function say(msg) {
      clearTimeout(sayTimer);
      status.textContent = "";
      if (!msg) return;
      sayTimer = setTimeout(function () { status.textContent = msg; }, 60);
    }

    function focus(node) {
      if (node && typeof node.focus === "function") node.focus();
    }

    /* ---------- timezone control ---------- */

    function buildZoneOptions() {
      var now = new Date();
      var list = COMMON_ZONES.slice();
      if (list.indexOf(state.tz) === -1) list.unshift(state.tz);

      tzSelect.textContent = "";
      list.forEach(function (tz) {
        if (!isValidZone(tz)) return;
        var city = tz.split("/").pop().replace(/_/g, " ");
        var short = f.zoneShort(now, tz);
        var label = city + " — " + f.zoneLong(now, tz) + (short ? " (" + short + ")" : "");
        tzSelect.appendChild(el("option", { value: tz, text: label, selected: tz === state.tz ? true : null }));
      });
      tzSelect.value = state.tz;
    }

    function zoneLabel() {
      var ref = state.instant || state.slots[0] || new Date();
      var short = f.zoneShort(ref, state.tz);
      return f.zoneLong(ref, state.tz) + (short ? " (" + short + ")" : "");
    }

    /* ---------- grouping ---------- */

    function groupByDay() {
      var map = {};
      var order = [];
      state.slots.forEach(function (d) {
        var key = dayKey(d, state.tz);
        if (!map[key]) { map[key] = []; order.push(key); }
        map[key].push(d);
      });
      return { map: map, order: order };
    }

    /* ---------- rendering ---------- */

    function renderDates() {
      var grouped = groupByDay();
      var order = grouped.order;
      dateChips.textContent = "";
      dateGroupBody.textContent = "";

      var visible = state.showAllDates ? order : order.slice(0, DATES_BEFORE_MORE);
      show(moreBtn, order.length > visible.length);

      var currentMonth = null;
      var chipRow = null;

      visible.forEach(function (key) {
        var first = grouped.map[key][0];
        var month = f.monthYear(first, state.tz);
        if (month !== currentMonth) {
          currentMonth = month;
          dateGroupBody.appendChild(el("p", { class: "bookcal__month", "aria-hidden": "true", text: month }));
          chipRow = el("div", { class: "bookcal__chips" });
          dateGroupBody.appendChild(chipRow);
        }

        var input = el("input", {
          class: "bookcal__chip-input", type: "radio", name: id + "-date", value: key,
          checked: key === state.dayKey ? true : null
        });
        input.addEventListener("change", function () { onDatePicked(key); });

        chipRow.appendChild(el("label", { class: "bookcal__chip bookcal__chip--date" }, [
          input,
          el("span", { class: "bookcal__chip-face" }, [
            el("span", { class: "bookcal__chip-dow", text: f.dow(first, state.tz) }),
            el("span", { class: "bookcal__chip-day", text: f.dayMonth(first, state.tz) })
          ])
        ]));
      });
    }

    function renderTimes() {
      if (!state.dayKey) { show(timeGroup, false); return; }
      var grouped = groupByDay();
      var list = grouped.map[state.dayKey] || [];
      if (!list.length) { show(timeGroup, false); return; }

      /* The legend carries the date and zone so the individual chips don't have
         to repeat them — screen readers announce it on entering the group. */
      timeLegend.textContent = "Times on " + f.fullNoYear(list[0], state.tz) + ", shown in " + zoneLabel();

      timeChips.textContent = "";
      list.forEach(function (d) {
        var iso = d.toISOString();
        var input = el("input", {
          class: "bookcal__chip-input", type: "radio", name: id + "-time", value: iso,
          checked: state.instant && state.instant.toISOString() === iso ? true : null
        });
        input.addEventListener("change", function () {
          state.instant = d;
          nextBtn.setAttribute("aria-disabled", "false");
          /* No announcement — the radio's own state change is the announcement,
             and Continue was already present. */
        });

        timeChips.appendChild(el("label", { class: "bookcal__chip bookcal__chip--time" }, [
          input,
          el("span", { class: "bookcal__chip-face", text: f.time(d, state.tz) })
        ]));
      });
      show(timeGroup, true);
    }

    function onDatePicked(key) {
      state.dayKey = key;
      state.instant = null;
      nextBtn.setAttribute("aria-disabled", "true");
      renderTimes();
      /* Deliberately silent. This fires on every arrow-key press through the
         date list, and rewriting the status line on each one made the widget
         visibly twitch. Nothing is lost: the radio announces its own state,
         and the time group's legend already names the date, the timezone and
         the count via "1 of 8" when focus reaches it. */
    }

    /* Keys browsers don't give a radio group for free.
       Home/End: jump to the ends of the list.
       Enter:    select the focused chip. Tabbing into a group where nothing is
                 chosen focuses the first radio WITHOUT checking it, and native
                 radios ignore Enter — so the first date could only be picked by
                 arrowing away and back. The chips read as buttons, so Enter
                 selecting them is what people expect. */
    function wireRadioKeys(container, name) {
      container.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          var focused = e.target;
          if (!focused || focused.type !== "radio") return;
          /* Always swallow it: there is no submit control in step 1, and a
             stray Enter should never reach the form. */
          e.preventDefault();
          if (focused.checked) return;
          focused.checked = true;
          focused.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }

        if (e.key !== "Home" && e.key !== "End") return;
        var radios = container.querySelectorAll('input[name="' + name + '"]');
        if (!radios.length) return;
        var target = e.key === "Home" ? radios[0] : radios[radios.length - 1];
        e.preventDefault();
        target.checked = true;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        target.focus();
      });
    }
    wireRadioKeys(dateGroup, id + "-date");
    wireRadioKeys(timeGroup, id + "-time");

    /* ---------- loading ---------- */

    function setBusy(on) {
      panel.setAttribute("aria-busy", on ? "true" : "false");
    }

    function showNotice(title, body, canRetry) {
      noticeTitle.textContent = title;
      noticeBody.textContent = "";
      noticeBody.appendChild(document.createTextNode(body + " "));
      noticeBody.appendChild(el("a", { href: MAILTO, text: FALLBACK_EMAIL }));
      noticeBody.appendChild(document.createTextNode(" and I'll sort it out."));
      show(retryBtn, canRetry);
      show(form, false);
      show(donePanel, false);
      show(noticePanel, true);
    }

    function load(isRetry) {
      if (state.loading) return;
      state.loading = true;
      setBusy(true);
      show(noticePanel, false);
      show(form, true);
      say("Loading available times.");

      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 12000);

      fetch(API_SLOTS + "?days=" + HORIZON_DAYS + "&timezone=" + encodeURIComponent(state.tz), {
        signal: ctrl.signal, headers: { Accept: "application/json" }
      })
        .then(function (r) {
          if (!r.ok) throw new Error("slots " + r.status);
          return r.json();
        })
        .then(function (data) {
          clearTimeout(timer);
          state.loading = false;
          state.loaded = true;
          setBusy(false);
          state.duration = data.durationMinutes || 30;
          stepNote.textContent = state.duration + "-minute video call.";
          renderCustomFields(data.customFields);

          state.slots = (data.slots || [])
            .map(function (s) { return new Date(s); })
            .filter(function (d) { return !isNaN(d.getTime()) && d.getTime() > Date.now(); });

          if (!state.slots.length) {
            showNotice(
              "No open times in the next 4 weeks",
              "Nothing is free right now. Email",
              false
            );
            say("No open times in the next 4 weeks.");
            return;
          }

          renderDates();
          renderTimes();
          var dayCount = groupByDay().order.length;
          say(dayCount + " available dates loaded. Times are shown in " + f.zoneLong(state.slots[0], state.tz) + ".");
          /* On retry the focused button is being removed, so focus must move. */
          if (isRetry) focus(step1.querySelector(".bookcal__step-title"));
        })
        .catch(function () {
          clearTimeout(timer);
          state.loading = false;
          setBusy(false);
          showNotice("Couldn't load available times", "Something went wrong on my end. Try again, or email", true);
          /* No focus move on first load — nothing the visitor did caused it. */
          if (isRetry) focus(noticeTitle);
          else say("Couldn't load available times. Use the Try again button, or email " + FALLBACK_EMAIL + ".");
        });
    }

    /* ---------- steps ---------- */

    function goToStep(n) {
      state.step = n;
      show(step1, n === 1);
      show(step2, n === 2);
      Array.prototype.forEach.call(progressItems, function (item, i) {
        if (i === n - 1) item.setAttribute("aria-current", "step");
        else item.removeAttribute("aria-current");
      });

      if (n === 2) {
        var end = new Date(state.instant.getTime() + state.duration * 60000);
        summaryWhen.textContent = f.full(state.instant, state.tz) + ", " +
          f.time(state.instant, state.tz) + " – " + f.time(end, state.tz);
        summaryZone.textContent = zoneLabel();
        focus(step2.querySelector(".bookcal__step-title"));
      } else {
        focus(step1.querySelector(".bookcal__step-title"));
      }
    }

    nextBtn.addEventListener("click", function () {
      if (nextBtn.getAttribute("aria-disabled") === "true") {
        if (!state.dayKey) {
          say("Choose a date before continuing.");
          focus(dateGroup.querySelector("input"));
        } else {
          say("Choose a time before continuing.");
          focus(timeGroup.querySelector("input"));
        }
        return;
      }
      goToStep(2);
    });

    backBtn.addEventListener("click", function () { goToStep(1); });
    moreBtn.addEventListener("click", function () {
      state.showAllDates = true;
      renderDates();
      focus(dateGroup.querySelector("input:not(:checked)") || dateGroup.querySelector("input"));
    });
    retryBtn.addEventListener("click", function () { load(true); });

    tzSelect.addEventListener("change", function () {
      var next = tzSelect.value;
      if (!isValidZone(next)) return;
      state.tz = next;
      storeZone(next);

      /* A zone change can move a slot across a date boundary, so the grouping
         is re-derived from the instants and the selection re-homed. */
      if (state.instant) {
        state.dayKey = dayKey(state.instant, state.tz);
      } else if (state.dayKey) {
        state.dayKey = null;
      }
      renderDates();
      renderTimes();

      if (state.instant) {
        say("Times now shown in " + f.zoneLong(state.instant, state.tz) +
            ". Your selected time is now " + f.fullNoYear(state.instant, state.tz) +
            " at " + f.time(state.instant, state.tz) + ".");
      } else {
        say("Times now shown in " + f.zoneLong(state.slots[0] || new Date(), state.tz) + ".");
      }
    });

    /* ---------- custom fields from the GHL calendar ---------- */

    function renderCustomFields(defs) {
      customHost.textContent = "";
      customFields = [];
      if (!defs || !defs.length) return;

      defs.forEach(function (def, i) {
        var fid = id + "-cf" + i;
        var describedBy = [];
        var wrap = el("div", { class: "bookcal__field" });

        var errNode = el("p", { class: "bookcal__error", id: fid + "-error" });
        var hintNode = def.placeholder
          ? el("p", { class: "bookcal__hint", id: fid + "-hint", text: def.placeholder })
          : null;
        if (hintNode) describedBy.push(fid + "-hint");
        describedBy.push(fid + "-error");

        var entry = { def: def, error: errNode, inputs: [], read: null };

        if (def.type === "checkbox" && def.options.length) {
          /* A multi-select is a group of checkboxes, so it needs a fieldset
             and legend rather than a single <label>. */
          var legendKids = [def.label];
          if (!def.required) legendKids.push(" ", el("span", { class: "bookcal__optional", text: "(optional)" }));
          var group = el("fieldset", { class: "bookcal__group bookcal__group--check", "aria-describedby": describedBy.join(" ") }, [
            el("legend", { class: "bookcal__legend" }, legendKids)
          ]);
          if (hintNode) group.appendChild(hintNode);
          group.appendChild(errNode);
          var boxes = el("div", { class: "bookcal__checks" });
          def.options.forEach(function (opt, oi) {
            var cb = el("input", { class: "bookcal__check-input", type: "checkbox", id: fid + "-" + oi, value: opt });
            entry.inputs.push(cb);
            boxes.appendChild(el("div", { class: "bookcal__check" }, [
              cb, el("label", { class: "bookcal__check-label", for: fid + "-" + oi, text: opt })
            ]));
          });
          group.appendChild(boxes);
          wrap.appendChild(group);
          entry.read = function () { return entry.inputs.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); };
          entry.focusTarget = entry.inputs[0];
          entry.anchorId = fid + "-0";
        } else {
          var labelKids = [def.label];
          if (!def.required) labelKids.push(" ", el("span", { class: "bookcal__optional", text: "(optional)" }));
          wrap.appendChild(el("label", { class: "bookcal__label", for: fid }, labelKids));
          if (hintNode) wrap.appendChild(hintNode);
          wrap.appendChild(errNode);

          var control;
          if (def.type === "select" && def.options.length) {
            control = el("select", { class: "bookcal__select", id: fid, "aria-describedby": describedBy.join(" ") }, [
              el("option", { value: "", text: def.required ? "Choose one" : "No answer" })
            ]);
            def.options.forEach(function (opt) { control.appendChild(el("option", { value: opt, text: opt })); });
          } else if (def.type === "textarea") {
            control = el("textarea", { class: "bookcal__textarea", id: fid, rows: "3", maxlength: "1000", "aria-describedby": describedBy.join(" ") });
          } else {
            control = el("input", {
              class: "bookcal__input", id: fid,
              type: def.type === "number" ? "number" : def.type,
              "aria-describedby": describedBy.join(" ")
            });
          }
          if (def.required) control.setAttribute("required", "");
          wrap.appendChild(control);
          entry.inputs.push(control);
          entry.read = function () { return control.value.trim(); };
          entry.focusTarget = control;
          entry.anchorId = fid;
        }

        /* Same "reward early, punish late" rule as the built-in fields. */
        entry.inputs.forEach(function (input) {
          input.addEventListener(input.type === "checkbox" ? "change" : "input", function () {
            if (!errNode.textContent) return;
            if (!validateCustom(entry)) setCustomError(entry, null);
          });
        });

        customFields.push(entry);
        customHost.appendChild(wrap);
      });
    }

    function setCustomError(entry, msg) {
      entry.error.textContent = msg || "";
      entry.inputs.forEach(function (input) {
        if (msg && input.type !== "checkbox") input.setAttribute("aria-invalid", "true");
        else input.removeAttribute("aria-invalid");
      });
    }

    function validateCustom(entry) {
      if (!entry.def.required) return null;
      var v = entry.read();
      var empty = Array.isArray(v) ? !v.length : !v;
      if (!empty) return null;
      /* "Choose" for pickers, "Enter" for things you type (SC 3.3.3 — the
         message should describe the fix in the user's own terms). */
      var verb = (entry.def.type === "select" || entry.def.type === "checkbox" || entry.def.type === "date")
        ? "Choose" : "Enter";
      return verb + " " + entry.def.label.toLowerCase() + ".";
    }

    /* ---------- validation ---------- */

    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    function setFieldError(name, msg) {
      var fld = fields[name];
      fld.error.textContent = msg || "";
      if (msg) fld.input.setAttribute("aria-invalid", "true");
      else fld.input.removeAttribute("aria-invalid");
    }

    function validateField(name) {
      var v = fields[name].input.value.trim();
      if (name === "name") return v ? null : "Enter your name.";
      if (name === "email") {
        if (!v) return "Enter your email address.";
        return EMAIL_RE.test(v) ? null : "Enter an email address in the format name@example.com.";
      }
      if (name === "phone") {
        if (!v) return null;
        return /^[+()\d\s-]{6,}$/.test(v) ? null : "Enter a phone number, like +63 917 123 4567.";
      }
      if (name === "notes") {
        return v.length > 1000 ? "Shorten what you'd like help with to 1000 characters or fewer." : null;
      }
      return null;
    }

    /* Reward early, punish late: only re-validate a field once it has errored. */
    Object.keys(fields).forEach(function (name) {
      fields[name].input.addEventListener("input", function () {
        if (!fields[name].error.textContent) return;
        if (!validateField(name)) setFieldError(name, null);
      });
    });

    function showErrorSummary(items) {
      errorList.textContent = "";
      items.forEach(function (item) {
        errorList.appendChild(el("li", {}, [
          el("a", { href: "#" + item.id, text: item.msg })
        ]));
      });
      show(errorBox, true);
      focus(errorBox);
    }

    /* ---------- submit ---------- */

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (state.step !== 2) return;

      if (state.sending) { say("Still sending your booking."); return; }

      /* Summary order follows DOM order of the fields, not detection order. */
      var order = ["name", "email", "phone", "notes"];
      var problems = [];
      order.forEach(function (name) {
        var msg = validateField(name);
        setFieldError(name, msg);
        if (msg) problems.push({ id: id + "-" + name, msg: msg });
      });
      /* Custom fields sit after the built-ins in the DOM, so they come after
         them in the summary too. */
      customFields.forEach(function (entry) {
        var msg = validateCustom(entry);
        setCustomError(entry, msg);
        if (msg) problems.push({ id: entry.anchorId, msg: msg });
      });

      if (problems.length) { showErrorSummary(problems); return; }
      show(errorBox, false);

      state.sending = true;
      submitBtn.setAttribute("aria-disabled", "true");
      form.setAttribute("aria-busy", "true");
      say("Sending your booking.");

      fetch(API_BOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          start: state.instant.toISOString(),
          timezone: state.tz,
          name: fields.name.input.value.trim(),
          email: fields.email.input.value.trim(),
          phone: fields.phone.input.value.trim(),
          notes: fields.notes.input.value.trim(),
          custom: customFields.reduce(function (acc, entry) {
            var v = entry.read();
            if (Array.isArray(v) ? v.length : v) acc[entry.def.id] = v;
            return acc;
          }, {}),
          company: root.querySelector(".bookcal__hp input").value
        })
      })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (body) {
            return { ok: r.ok, statusCode: r.status, body: body };
          });
        })
        .then(function (res) {
          state.sending = false;
          submitBtn.setAttribute("aria-disabled", "false");
          form.removeAttribute("aria-busy");

          if (res.ok && res.body.ok) return succeed();

          if (res.statusCode === 409) {
            /* Drop the taken slot and send them back to pick again. */
            var taken = state.instant.toISOString();
            state.slots = state.slots.filter(function (d) { return d.toISOString() !== taken; });
            state.instant = null;
            nextBtn.setAttribute("aria-disabled", "true");
            renderDates();
            renderTimes();
            showErrorSummary([{ id: id + "-s1-title", msg: "That time was just taken. Choose another time." }]);
            return;
          }

          if (res.statusCode === 422 && (res.body.fields || res.body.custom)) {
            var problems2 = [];
            Object.keys(res.body.fields || {}).forEach(function (name) {
              if (!fields[name]) return;
              setFieldError(name, res.body.fields[name]);
              problems2.push({ id: id + "-" + name, msg: res.body.fields[name] });
            });
            Object.keys(res.body.custom || {}).forEach(function (fieldId) {
              var entry = customFields.filter(function (c) { return c.def.id === fieldId; })[0];
              if (!entry) return;
              setCustomError(entry, res.body.custom[fieldId]);
              problems2.push({ id: entry.anchorId, msg: res.body.custom[fieldId] });
            });
            if (problems2.length) return showErrorSummary(problems2);
          }

          showErrorSummary([{
            id: id + "-s2-title",
            msg: "We couldn't complete your booking. Try again, or email " + FALLBACK_EMAIL + " and I'll book it manually."
          }]);
        })
        .catch(function () {
          state.sending = false;
          submitBtn.setAttribute("aria-disabled", "false");
          form.removeAttribute("aria-busy");
          showErrorSummary([{
            id: id + "-s2-title",
            msg: "We couldn't complete your booking. Try again, or email " + FALLBACK_EMAIL + " and I'll book it manually."
          }]);
        });
    });

    function icsHref(start, end, email) {
      var stamp = function (d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
      var lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ripples Space//Booking//EN",
        "BEGIN:VEVENT",
        "UID:" + stamp(start) + "-" + Math.random().toString(36).slice(2) + "@ripples.space",
        "DTSTAMP:" + stamp(new Date()),
        "DTSTART:" + stamp(start),
        "DTEND:" + stamp(end),
        "SUMMARY:Automation strategy call — Ripples Space",
        "DESCRIPTION:30-minute video call. A meeting link is on its way to " + email + ".",
        "END:VEVENT", "END:VCALENDAR"
      ];
      return "data:text/calendar;charset=utf-8," + encodeURIComponent(lines.join("\r\n"));
    }

    function succeed() {
      var start = state.instant;
      var end = new Date(start.getTime() + state.duration * 60000);
      var email = fields.email.input.value.trim();

      doneBody.textContent = "";
      doneBody.appendChild(el("strong", { text: f.full(start, state.tz) + ", " + f.time(start, state.tz) + " to " + f.time(end, state.tz) }));
      doneBody.appendChild(document.createTextNode(", " + f.zoneLong(start, state.tz) + ". I've emailed the invite and the meeting link to " + email + "."));

      doneActions.textContent = "";
      doneActions.appendChild(el("a", {
        class: "btn btn--ghost", href: icsHref(start, end, email), download: "ripples-call.ics", text: "Add to calendar"
      }));

      /* Success is announced by moving focus to the heading, not by the live
         region — so clear it rather than leaving "Sending your booking." behind. */
      clearTimeout(sayTimer);
      status.textContent = "";

      show(form, false);
      show(noticePanel, false);
      show(donePanel, true);
      focus(doneTitle);
    }

    /* ---------- init ---------- */

    buildZoneOptions();

    return {
      root: root,
      ensureLoaded: function () { if (!state.loaded && !state.loading) load(false); }
    };
  }

  /* ============================================================
     Booking modal controller
     Was duplicated inline in both landing pages.
     ============================================================ */

  function initModal(widgets) {
    var modal = document.getElementById("book-modal");
    if (!modal) return;

    var dialog = modal.querySelector(".bookmodal__dialog");
    var lastFocus = null;

    /* A Tab trap doesn't stop a screen reader's virtual cursor — browse-mode
       arrows walk straight out of the dialog into the page behind it. inert
       is what actually removes the rest of the document. */
    function siblings() {
      return [document.querySelector("header.nav"), document.querySelector("main"), document.querySelector("footer")]
        .filter(Boolean);
    }

    function isVisible(node) {
      if (node.disabled) return false;
      if (typeof node.checkVisibility === "function") return node.checkVisibility({ visibilityProperty: true });
      return !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
    }

    function focusables() {
      var sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
      return Array.prototype.filter.call(modal.querySelectorAll(sel), isVisible);
    }

    function open(e) {
      if (e) e.preventDefault();
      /* Prefer the element that was actually activated. Safari doesn't focus a
         link on click, so document.activeElement is <body> for mouse users and
         focus would have nowhere sensible to return to on close. */
      lastFocus = (e && e.currentTarget) || document.activeElement;
      if (!lastFocus || lastFocus === document.body) lastFocus = document.activeElement;
      modal.classList.add("is-open");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("bookmodal-open");
      siblings().forEach(function (n) { n.setAttribute("inert", ""); });

      /* Focus the dialog, not the close button — with aria-labelledby this
         announces the title and reads into the content, rather than
         "Close booking, button" with no context. */
      setTimeout(function () {
        if (dialog) dialog.focus();
        widgets.forEach(function (w) { if (modal.contains(w.root)) w.ensureLoaded(); });
      }, 60);
    }

    function close() {
      /* Order matters twice over:
         1. inert must come off first — the trigger usually lives in the nav,
            and nothing inside an inert subtree can take focus.
         2. focus must be restored before aria-hidden goes back on, or focus
            sits inside a hidden subtree for a frame. */
      siblings().forEach(function (n) { n.removeAttribute("inert"); });
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      document.body.classList.remove("bookmodal-open");
    }

    document.querySelectorAll("[data-book-open]").forEach(function (btn) {
      btn.addEventListener("click", open);
    });
    modal.querySelectorAll("[data-book-close]").forEach(function (btn) {
      btn.addEventListener("click", close);
    });

    document.addEventListener("keydown", function (e) {
      if (!modal.classList.contains("is-open")) return;

      if (e.key === "Escape") { close(); return; }

      if (e.key === "Tab") {
        var list = focusables();
        if (!list.length) return;
        var first = list[0];
        var last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
  }

  /* ============================================================ */

  function init() {
    var widgets = [];
    document.querySelectorAll("[data-bookcal]").forEach(function (mount) {
      var w = BookCal(mount);
      widgets.push(w);
      /* The inline widget loads immediately; the modal waits until it opens. */
      if (mount.getAttribute("data-variant") !== "modal") w.ensureLoaded();
    });
    initModal(widgets);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
