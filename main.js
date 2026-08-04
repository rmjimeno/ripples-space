/* ============================================================
   Ripples Space — interactions
   2D ripple contours · GSAP scroll motion · animated mockups
   ============================================================ */
(function () {
  "use strict";

  const motionMQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  function readMotionPref() {
    try { return localStorage.getItem("ripples-motion"); } catch (e) { return null; }
  }
  // A stored user choice ("reduce" | "full") wins; otherwise follow the OS setting.
  const motionPref = readMotionPref();
  const REDUCED = motionPref ? motionPref === "reduce" : motionMQ.matches;
  document.documentElement.classList.toggle("motion-reduced", REDUCED);

  const hasGSAP = typeof gsap !== "undefined";

  // Infinite/decorative GSAP loops, collected so they can be paused on demand.
  const infiniteTweens = [];
  // Sections register here so the in-page toggle can settle them mid-session,
  // not just at load. Each handler receives the new "reduce" state.
  const motionHandlers = [];
  const onMotionChange = (fn) => motionHandlers.push(fn);

  /* -------------------------------------------------------
     1 · RIPPLE FIELD (hero + cta backgrounds)

     Contour rings spreading from the bottom centre, traced with
     marching squares over a height field. Replaces a WebGL shader
     that painted a full-bleed gradient wash: this is 2D canvas,
     hairline-only, and costs about 0.2ms a frame — which is what
     let three.js come off every page.

     The field is `sin(d · rings · 2π)` where d is the distance from
     the origin normalised so the FARTHEST corner is 1.0 (measuring
     to the nearest one would push most of the surface past the
     outermost ring once the origin moves off centre). Before the
     band is read, d is bent by harmonics of the angle, which is
     what turns concentric circles into rings that wander. Only
     EVEN multiples of the angle are used — atan2 wraps at ±π and
     sin(k·a) is only continuous across that seam for even k.
  ------------------------------------------------------- */
  const RIPPLE_THEMES = {
    // Gold on oxblood, maroon on paper. The dark field carries more weight
    // because a hairline loses far more against oxblood than against paper.
    dark:  { accent: [233, 196, 138], strength: 0.13 },
    light: { accent: [124, 20, 24],  strength: 0.06 },
  };

  const RIPPLE = {
    cell: 15,        // sampling grid, px
    rings: 5,        // bands from the origin to the farthest corner
    lines: 2,        // contour lines within each band
    organic: 0.7,    // how far the rings wander off true circles
    drift: 0.006,    // bands per second — one takes ~2.8 min to travel out
    amp: 0.25,       // how far the ground lifts under the pointer
    sigma: 240,      // and how broadly
    originX: 0.5,
    originY: 1,
  };
  const TAU = Math.PI * 2;

  const ripples = [];
  function createRipple(canvas, intensity) {
    if (!canvas) return null;
    const ctx = canvas.getContext && canvas.getContext("2d");
    if (!ctx) return null;

    const theme = RIPPLE_THEMES[canvas.getAttribute("data-theme")] || RIPPLE_THEMES.dark;
    const stroke = "rgba(" + theme.accent.join(",") + ",";
    const alpha = theme.strength * intensity;

    const CELL = RIPPLE.cell;
    const PS2 = 2 * RIPPLE.sigma * RIPPLE.sigma;
    const PCUT = (RIPPLE.sigma * 3) * (RIPPLE.sigma * 3);

    let W = 0, H = 0, cols = 0, rows = 0, base = null, work = null;
    const target = { x: -9999, y: -9999, on: 0 };
    const eased = { x: -9999, y: -9999, on: 0 };

    function buildField() {
      cols = Math.ceil(W / CELL);
      rows = Math.ceil(H / CELL);
      base = new Float32Array((cols + 1) * (rows + 1));
      work = new Float32Array(base.length);

      const fw = cols * CELL, fh = rows * CELL;
      const ox = fw * RIPPLE.originX, oy = fh * RIPPLE.originY;
      const maxD = Math.max(
        Math.hypot(ox, oy), Math.hypot(fw - ox, oy),
        Math.hypot(ox, fh - oy), Math.hypot(fw - ox, fh - oy)
      ) || 1;

      for (let j = 0; j <= rows; j++) {
        const py = j * CELL - oy;
        for (let i = 0; i <= cols; i++) {
          const px = i * CELL - ox;
          const d = Math.sqrt(px * px + py * py) / maxD;
          const a = Math.atan2(py, px);
          const wob = Math.sin(a * 2 + d * 7.0) * 0.50
                    + Math.sin(a * 4 - d * 5.0 + 1.1) * 0.34
                    + Math.sin(a * 6 + d * 3.4 + 2.3) * 0.20
                    + Math.sin(a * 8 - d * 2.2 + 0.7) * 0.10;
          // Undamped, the wander collapses the origin into a pinch.
          const damp = Math.min(1, d * 2.6);
          const dd = d + wob * RIPPLE.organic * 0.075 * damp;
          base[j * (cols + 1) + i] = Math.sin(dd * RIPPLE.rings * TAU);
        }
      }
    }

    function resize() {
      const r = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      buildField();
    }

    // The swell is added once per grid point per frame. Doing it inside the
    // contour-level loop instead repeats every exp() once per level.
    function fieldWithSwell(amp) {
      if (amp <= 0.001) return base;
      work.set(base);
      const stride = cols + 1;
      const reach = RIPPLE.sigma * 3;
      const i0 = Math.max(0, Math.floor((eased.x - reach) / CELL));
      const i1 = Math.min(cols, Math.ceil((eased.x + reach) / CELL));
      const j0 = Math.max(0, Math.floor((eased.y - reach) / CELL));
      const j1 = Math.min(rows, Math.ceil((eased.y + reach) / CELL));
      for (let j = j0; j <= j1; j++) {
        const dy = j * CELL - eased.y, dy2 = dy * dy;
        for (let i = i0; i <= i1; i++) {
          const dx = i * CELL - eased.x;
          const d2 = dx * dx + dy2;
          if (d2 > PCUT) continue;
          work[j * stride + i] += amp * Math.exp(-d2 / PS2);
        }
      }
      return work;
    }

    // Clamped: where the gradient across an edge is ~0 the ratio explodes
    // and throws stray dashes far outside the cell.
    function lerpT(v0, v1, lv) {
      const g = v1 - v0;
      if (g > -1e-6 && g < 1e-6) return 0.5;
      const t = (lv - v0) / g;
      return t < 0 ? 0 : (t > 1 ? 1 : t);
    }

    function render(time) {
      if (!base) return;
      // Deliberately lagging: the swell trails the cursor and takes over a
      // second to rise or fall, so it reads as the ground settling.
      eased.x += (target.x - eased.x) * 0.03;
      eased.y += (target.y - eased.y) * 0.03;
      eased.on += (target.on - eased.on) * 0.012;

      ctx.clearRect(0, 0, W, H);

      const f = fieldWithSwell(RIPPLE.amp * eased.on);
      const stride = cols + 1;
      const gap = 2 / RIPPLE.lines;
      // Scaled by `gap` so the rate stays the same if the line count changes.
      const shift = (time * RIPPLE.drift * gap) % gap;

      ctx.lineWidth = 1;
      ctx.strokeStyle = stroke + alpha + ")";
      ctx.beginPath();

      for (let lv = -1 + shift; lv <= 1; lv += gap) {
        for (let j = 0; j < rows; j++) {
          const y0 = j * CELL, y1 = y0 + CELL;
          for (let i = 0; i < cols; i++) {
            const x0 = i * CELL, x1 = x0 + CELL;
            const k = j * stride + i;
            const a = f[k], b = f[k + 1], c = f[k + stride + 1], d = f[k + stride];

            const idx = (a > lv ? 8 : 0) | (b > lv ? 4 : 0) | (c > lv ? 2 : 0) | (d > lv ? 1 : 0);
            if (idx === 0 || idx === 15) continue;

            const top    = x0 + CELL * lerpT(a, b, lv);
            const right  = y0 + CELL * lerpT(b, c, lv);
            const bottom = x0 + CELL * lerpT(d, c, lv);
            const left   = y0 + CELL * lerpT(a, d, lv);

            switch (idx) {
              case 1: case 14: ctx.moveTo(x0, left);   ctx.lineTo(bottom, y1); break;
              case 2: case 13: ctx.moveTo(bottom, y1); ctx.lineTo(x1, right);  break;
              case 3: case 12: ctx.moveTo(x0, left);   ctx.lineTo(x1, right);  break;
              case 4: case 11: ctx.moveTo(top, y0);    ctx.lineTo(x1, right);  break;
              case 6: case  9: ctx.moveTo(top, y0);    ctx.lineTo(bottom, y1); break;
              case 7: case  8: ctx.moveTo(x0, left);   ctx.lineTo(top, y0);    break;
              case 5:
                ctx.moveTo(top, y0);    ctx.lineTo(x1, right);
                ctx.moveTo(x0, left);   ctx.lineTo(bottom, y1);
                break;
              case 10:
                ctx.moveTo(top, y0);    ctx.lineTo(x0, left);
                ctx.moveTo(bottom, y1); ctx.lineTo(x1, right);
                break;
            }
          }
        }
      }
      ctx.stroke();
    }

    function snapPointer() {
      if (eased.x < -1000) { eased.x = target.x; eased.y = target.y; }
    }

    const inst = { target, resize, render, snapPointer };
    resize();
    ripples.push(inst);
    return inst;
  }

  function intensityFor(canvas, fallback) {
    if (!canvas) return fallback;
    const v = parseFloat(canvas.getAttribute("data-intensity"));
    return isNaN(v) ? fallback : v;
  }
  const heroCanvas = document.getElementById("ripple-canvas");
  const ctaCanvas = document.getElementById("ripple-canvas-2");
  const heroRipple = createRipple(heroCanvas, intensityFor(heroCanvas, 1));
  createRipple(ctaCanvas, intensityFor(ctaCanvas, 1));

  // pointer → hero ripple
  if (heroRipple) {
    const hero = document.getElementById("hero");
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      heroRipple.target.x = e.clientX - r.left;
      heroRipple.target.y = e.clientY - r.top;
      // Start the swell where the pointer entered rather than easing it in
      // from the off-canvas sentinel.
      heroRipple.snapPointer();
      heroRipple.target.on = 1;
    });
    hero.addEventListener("pointerleave", () => { heroRipple.target.on = 0; });
  }

  let start = performance.now();
  let running = ripples.length > 0 && !REDUCED;
  function loop(now) {
    if (!running) return;
    const t = (now - start) / 1000;
    for (const r of ripples) r.render(t);
    requestAnimationFrame(loop);
  }
  if (running) requestAnimationFrame(loop);
  else if (ripples.length) { for (const r of ripples) r.render(2.0); } // hold one calm static frame

  const isReduced = () => document.documentElement.classList.contains("motion-reduced");

  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { for (const r of ripples) r.resize(); if (!running) for (const r of ripples) r.render(2.0); }, 150);
  });

  // pause rAF when tab hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { running = false; }
    else if (ripples.length && !isReduced()) { running = true; start = performance.now() - 2000; requestAnimationFrame(loop); }
  });

  /* -------------------------------------------------------
     Motion preference: runtime pause/resume + persistence
  ------------------------------------------------------- */
  function setRipplesRunning(on) {
    if (on) {
      if (ripples.length && !running) { running = true; start = performance.now() - 2000; requestAnimationFrame(loop); }
    } else {
      running = false;
      for (const r of ripples) r.render(2.0); // hold a calm static frame
    }
  }
  function applyMotion(reduce) {
    document.documentElement.classList.toggle("motion-reduced", reduce);
    setRipplesRunning(!reduce);
    infiniteTweens.forEach((t) => { if (t && t.pause && t.resume) { reduce ? t.pause() : t.resume(); } });
    motionHandlers.forEach((fn) => { try { fn(reduce); } catch (e) {} });
  }
  window.RipplesMotion = {
    isReduced: isReduced,
    set: function (reduce) {
      try { localStorage.setItem("ripples-motion", reduce ? "reduce" : "full"); } catch (e) {}
      applyMotion(reduce);
    },
    toggle: function () { window.RipplesMotion.set(!isReduced()); }
  };

  // Keep in sync if the OS setting changes while the page is open and the
  // user hasn't set an explicit override.
  if (motionMQ.addEventListener) {
    motionMQ.addEventListener("change", (e) => {
      if (readMotionPref()) return; // explicit user choice wins
      applyMotion(e.matches);
      if (window.__syncMotionToggle) window.__syncMotionToggle();
    });
  }

  /* --- inject an accessible reduce-motion toggle (both pages) --- */
  if (ripples.length && !document.querySelector(".motion-toggle")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "motion-toggle";
    btn.innerHTML =
      '<svg class="motion-toggle__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="2" fill="currentColor"/>' +
      '<path d="M12 6.4a5.6 5.6 0 0 1 5.6 5.6M12 2.8a9.2 9.2 0 0 1 9.2 9.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
      '<path class="motion-toggle__slash" d="M4 4l16 16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>' +
      '</svg><span class="motion-toggle__label"></span>';
    const label = btn.querySelector(".motion-toggle__label");
    function sync() {
      const reduced = isReduced();
      label.textContent = reduced ? "Enable motion" : "Reduce motion";
      btn.setAttribute("aria-label", reduced ? "Enable animations" : "Reduce animations");
      btn.setAttribute("title", reduced ? "Turn animations back on" : "Reduce on-screen motion");
      btn.setAttribute("data-reduced", reduced ? "true" : "false");
    }
    window.__syncMotionToggle = sync;
    btn.addEventListener("click", () => { window.RipplesMotion.toggle(); sync(); });
    sync();
    // Prefer sitting inside the hero (scrolls away, less distracting).
    // Fall back to a fixed corner if there's no hero on the page.
    const heroHost = document.querySelector(".hero");
    if (heroHost) {
      heroHost.appendChild(btn);
    } else {
      btn.classList.add("motion-toggle--floating");
      document.body.appendChild(btn);
    }
  }

  /* -------------------------------------------------------
     2 · NAV state
  ------------------------------------------------------- */
  const nav = document.getElementById("nav");
  const onScroll = () => { nav.classList.toggle("scrolled", window.scrollY > 40); };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* -------------------------------------------------------
     2b · NAV drawer (burger menu) — only on pages that have one
  ------------------------------------------------------- */
  const burger = document.getElementById("nav-burger");
  const drawer = document.getElementById("nav-drawer");
  if (burger && drawer) {
    const panel = drawer.querySelector(".navdrawer__panel");
    const drawerOpen = () => drawer.classList.contains("is-open");
    /* The drawer lives inside <header>, so only main + footer need inert —
       and the burger stays reachable as the close control. */
    const behind = () => [document.querySelector("main"), document.querySelector("footer")].filter(Boolean);

    function openDrawer() {
      drawer.classList.add("is-open");
      drawer.setAttribute("aria-hidden", "false");
      burger.setAttribute("aria-expanded", "true");
      burger.setAttribute("aria-label", "Close menu");
      nav.classList.add("is-drawer-open");
      document.body.classList.add("drawer-open");
      behind().forEach((n) => n.setAttribute("inert", ""));
      setTimeout(() => { if (panel) panel.focus(); }, 60);
    }

    /* Focus always returns to the burger, not to whatever held it before the
       drawer opened: the burger is the drawer's own toggle and is always
       visible, and Safari doesn't focus a <button> on click — so remembering
       the previous element would strand focus on <body> for mouse users. */
    function closeDrawer() {
      behind().forEach((n) => n.removeAttribute("inert"));
      drawer.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
      burger.setAttribute("aria-expanded", "false");
      burger.setAttribute("aria-label", "Open menu");
      nav.classList.remove("is-drawer-open");
      document.body.classList.remove("drawer-open");
      burger.focus();
    }

    burger.addEventListener("click", () => { drawerOpen() ? closeDrawer() : openDrawer(); });
    drawer.querySelectorAll("[data-drawer-close]").forEach((el) => {
      el.addEventListener("click", () => closeDrawer());
    });

    document.addEventListener("keydown", (e) => {
      if (!drawerOpen()) return;
      if (e.key === "Escape") { closeDrawer(); return; }
      if (e.key !== "Tab") return;

      // The burger is outside the drawer but is its close control, so it's
      // part of the loop.
      const sel = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const list = [burger].concat(Array.prototype.slice.call(drawer.querySelectorAll(sel)));
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* -------------------------------------------------------
     2c · Portrait easter egg — a random line on hover
  ------------------------------------------------------- */
  const portrait = document.getElementById("me-portrait");
  if (portrait) {
    const bubble = portrait.querySelector(".me__bubble");
    const lines = [
      "Please don't poke the designer.",
      "Achievement unlocked: Hovered the founder.",
      "✨ You found the secret dialogue.",
      "why are you still hovering?",
      "you are persistent",
      "screenshot this to get $100 discount when you avail my services. Ssshhh. 🤫",
      "yes that's true",
      "That's it, no more! 😡"
    ];
    let step = -1, hideTimer;

    /* Escalating rather than random: the lines are a running joke that builds
       on the last one, so order carries the gag. The final line is a sign-off
       — once it lands it stays put instead of looping back to the start. */
    function nextLine() {
      if (step < lines.length - 1) step++;
      return lines[step];
    }
    function show() {
      bubble.textContent = nextLine();
      portrait.classList.add("is-talking");
    }
    function hide() { portrait.classList.remove("is-talking"); }

    portrait.addEventListener("pointerenter", show);
    portrait.addEventListener("pointerleave", hide);
    /* Touch and pen have no hover, so a tap surfaces it — then it times out,
       since there is no pointerleave coming to clear it. Mouse is excluded:
       pointerenter already fired and the timer would yank the bubble away
       while the cursor is still on the photo. */
    portrait.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return;
      show();
      clearTimeout(hideTimer);
      hideTimer = setTimeout(hide, 2600);
    });
  }

  /* -------------------------------------------------------
     3 · GSAP scroll reveals + section animations
  ------------------------------------------------------- */
  if (hasGSAP) {
    if (typeof ScrollTrigger !== "undefined") gsap.registerPlugin(ScrollTrigger);

    // `.is-revealed` re-enables the element's own CSS transitions once it has
    // landed (see styles.css) — they'd otherwise fight the reveal tween.
    const settle = (items) => gsap.utils.toArray(items).forEach((el) => el.classList.add("is-revealed"));

    if (REDUCED) {
      gsap.set(".reveal", { opacity: 1, y: 0 });
      settle(".reveal");
    } else {
      gsap.set(".reveal", { opacity: 0, y: 26 });

      // Staggered reveal, grouped by nearest section. The hero is excluded:
      // it sits in view at load, so a ScrollTrigger would fire a second tween
      // competing with the entrance below.
      gsap.utils.toArray("section:not(.hero)").forEach((section) => {
        const items = section.querySelectorAll(".reveal");
        if (!items.length) return;
        ScrollTrigger.create({
          trigger: section,
          start: "top 78%",
          once: true,
          onEnter: () => gsap.to(items, {
            opacity: 1, y: 0, duration: 0.9, ease: "power3.out", stagger: 0.08,
            onComplete: () => settle(items)
          })
        });
      });

      // hero reveals immediately on load
      const heroItems = gsap.utils.toArray(".hero .reveal");
      if (heroItems.length) {
        gsap.to(heroItems, {
          opacity: 1, y: 0, duration: 1, ease: "power3.out", stagger: 0.09, delay: 0.15,
          onComplete: () => settle(heroItems)
        });
      }

      // Toggling mid-session shouldn't leave anything below the fold hidden.
      onMotionChange((reduce) => {
        if (!reduce) return;
        gsap.set(".reveal", { opacity: 1, y: 0 });
        settle(".reveal");
      });
    }

    // Web fonts / late layout shifts can change section heights —
    // recompute all ScrollTrigger positions so reveals fire where they should.
    const refresh = () => ScrollTrigger.refresh();
    window.addEventListener("load", refresh);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh);
    setTimeout(refresh, 800);

    /* --- dashboard: chart draw + counter + feed --- */
    const chartLine = document.getElementById("chart-line");
    if (chartLine) {
      const len = chartLine.getTotalLength();
      chartLine.style.strokeDasharray = len;
      chartLine.style.strokeDashoffset = REDUCED ? 0 : len;
    }
    const dash = document.getElementById("dash");
    if (dash) {
      ScrollTrigger.create({
        trigger: dash, start: "top 82%", once: true,
        onEnter: () => {
          if (chartLine && !REDUCED) gsap.to(chartLine, { strokeDashoffset: 0, duration: 1.6, ease: "power2.out" });
          // counter
          const num = dash.querySelector(".stat__num");
          const end = parseInt(num.dataset.count, 10) || 0;
          const obj = { v: 0 };
          gsap.to(obj, { v: end, duration: 1.4, ease: "power2.out",
            onUpdate: () => { num.textContent = Math.round(obj.v); } });
          // feed rows
          const rows = dash.querySelectorAll(".feed__row");
          gsap.set(rows, { opacity: 0, x: 14 });
          gsap.to(rows, { opacity: 1, x: 0, duration: 0.6, stagger: 0.18, delay: 0.3, ease: "power2.out" });
        }
      });
    }

    /* --- floating hero cards --- */
    if (!REDUCED) {
      if (document.querySelector(".fc1")) infiniteTweens.push(gsap.to(".fc1", { y: -14, duration: 3.2, ease: "sine.inOut", yoyo: true, repeat: -1 }));
      if (document.querySelector(".fc2")) infiniteTweens.push(gsap.to(".fc2", { y: 12, duration: 3.8, ease: "sine.inOut", yoyo: true, repeat: -1, delay: 0.4 }));
      if (document.querySelector(".dash")) infiniteTweens.push(gsap.to(".dash", { y: -8, duration: 4.5, ease: "sine.inOut", yoyo: true, repeat: -1 }));
    }

    /* --- automation flow: pulse + node activation loop --- */
    const flow = document.getElementById("flow");
    if (flow && !REDUCED) {
      const nodes = flow.querySelectorAll(".node");
      const pulse = flow.querySelector(".pulse");
      const stops = [30, 118, 206, 294]; // viewBox y centers
      let started = false;
      const buildLoop = () => {
        const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6 });
        stops.forEach((y, i) => {
          tl.to(pulse, { attr: { cy: y }, opacity: 1, duration: 0.55, ease: "power1.inOut" }, i === 0 ? 0 : ">-0.05")
            .add(() => {
              nodes.forEach((n, j) => n.classList.toggle("is-active", j === i));
            }, "<+0.2")
            .to({}, { duration: 0.5 }); // dwell
        });
        tl.add(() => nodes.forEach((n) => n.classList.remove("is-active")))
          .to(pulse, { opacity: 0, duration: 0.3 });
        return tl;
      };
      ScrollTrigger.create({
        trigger: flow, start: "top 80%",
        onEnter: () => {
          if (!started) {
            started = true;
            const tl = buildLoop();
            infiniteTweens.push(tl);
            if (isReduced()) tl.pause(); // respect a toggle set before this scrolled in
          }
        }
      });
    }

    /* --- how it works: scroll-driven timeline --- */
    const timeline = document.getElementById("timeline");
    if (timeline) {
      const fill = timeline.querySelector(".timeline__fill");
      const markers = timeline.querySelectorAll(".tstep__marker");
      const completeTimeline = () => {
        gsap.set(fill, { height: "100%" });
        markers.forEach((m) => m.classList.add("is-on"));
      };
      if (REDUCED) {
        completeTimeline();
      } else {
        ScrollTrigger.create({
          trigger: timeline,
          start: "top 70%",
          end: "bottom 82%",
          scrub: 0.6,
          onUpdate: (self) => {
            if (isReduced()) return; // toggled off mid-scroll — leave it settled
            const p = self.progress;
            gsap.set(fill, { height: (p * 100) + "%" });
            markers.forEach((m, i) => {
              m.classList.toggle("is-on", p >= i / markers.length + 0.08);
            });
          }
        });
        onMotionChange((reduce) => { if (reduce) completeTimeline(); });
      }
    }

    /* --- your week: tasks clear themselves --- */
    const tasks = document.getElementById("tasks");
    if (tasks) {
      const items = tasks.querySelectorAll(".task");
      const clearAll = () => items.forEach((t) => t.classList.add("done"));
      if (REDUCED) { clearAll(); }
      else {
        ScrollTrigger.create({
          trigger: tasks, start: "top 72%", once: true,
          onEnter: () => {
            items.forEach((t, i) => {
              gsap.delayedCall(0.5 + i * 0.55, () => t.classList.add("done"));
            });
          }
        });
        // Reducing motion part-way through the sequence shouldn't strand it.
        onMotionChange((reduce) => { if (reduce) clearAll(); });
      }
    }
  } else {
    // no GSAP: ensure everything is visible (CSS pre-hides + offsets .reveal)
    document.querySelectorAll(".reveal").forEach((el) => {
      el.style.opacity = 1;
      el.style.transform = "none";
      el.classList.add("is-revealed");
    });
    document.querySelectorAll("#tasks .task").forEach((t) => t.classList.add("done"));
  }

  /* -------------------------------------------------------
     4 · Accordion (smooth height)
  ------------------------------------------------------- */
  document.querySelectorAll(".qa").forEach((qa) => {
    const summary = qa.querySelector("summary");
    const panel = qa.querySelector(".qa__a");
    summary.addEventListener("click", (e) => {
      e.preventDefault();
      const animate = hasGSAP && !isReduced();
      const isOpen = qa.hasAttribute("open");
      // Impatient clicking would otherwise stack tweens and desync `open`
      // from the panel's inline height.
      if (hasGSAP) gsap.killTweensOf(panel);
      const reset = () => { if (hasGSAP) gsap.set(panel, { clearProps: "height" }); };

      if (isOpen) {
        if (animate) {
          gsap.to(panel, { height: 0, duration: 0.4, ease: "power2.inOut",
            onComplete: () => { qa.removeAttribute("open"); reset(); } });
        } else { qa.removeAttribute("open"); reset(); }
      } else {
        qa.setAttribute("open", "");
        if (animate) {
          gsap.fromTo(panel, { height: 0 }, { height: "auto", duration: 0.5, ease: "power2.out", onComplete: reset });
        } else { reset(); }
      }
    });
  });

  /* -------------------------------------------------------
     5 · Magnetic buttons
  ------------------------------------------------------- */
  const magnetic = document.querySelectorAll(".magnetic");
  if (hasGSAP && magnetic.length && window.matchMedia("(pointer:fine)").matches) {
    magnetic.forEach((btn) => {
      // GSAP writes `transform` inline, which cancels the button's CSS
      // :hover lift outright — so carry the lift inside the tween instead.
      const lift = btn.classList.contains("btn") ? -2 : 0;
      btn.addEventListener("pointermove", (e) => {
        if (isReduced()) return;
        const r = btn.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) * 0.3;
        const y = (e.clientY - r.top - r.height / 2) * 0.4 + lift;
        gsap.to(btn, { x, y, duration: 0.5, ease: "power3.out" });
      });
      btn.addEventListener("pointerleave", () => {
        gsap.to(btn, { x: 0, y: 0, duration: isReduced() ? 0.15 : 0.6, ease: isReduced() ? "power2.out" : "elastic.out(1, 0.4)" });
      });
    });
    // Reducing motion while a button is displaced should snap it back.
    onMotionChange((reduce) => { if (reduce) gsap.to(magnetic, { x: 0, y: 0, duration: 0.2 }); });
  }

  /* Booking lives in booking.js — it renders the widget and owns the modal. */
})();
