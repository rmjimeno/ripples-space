/* ============================================================
   Ripples Space — interactions
   three.js ripple shader · GSAP scroll motion · animated mockups
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
  const hasTHREE = typeof THREE !== "undefined";

  // Infinite/decorative GSAP loops, collected so they can be paused on demand.
  const infiniteTweens = [];

  /* -------------------------------------------------------
     1 · THREE.JS RIPPLE FIELD (hero + cta backgrounds)
  ------------------------------------------------------- */
  const VERT = `
    void main(){ gl_Position = vec4(position, 1.0); }
  `;
  const FRAG = `
    precision highp float;
    uniform float u_time;
    uniform vec2  u_res;
    uniform vec2  u_mouse;
    uniform float u_intensity;

    float ripple(vec2 uv, vec2 c, float t, float speed, float freq){
      float d = distance(uv, c);
      return sin(d * freq - t * speed) * exp(-d * 2.6);
    }
    void main(){
      vec2 uv = gl_FragCoord.xy / u_res.xy;
      float ar = u_res.x / u_res.y;
      vec2 p = vec2(uv.x * ar, uv.y);
      float t = u_time;

      float h = 0.0;
      h += ripple(p, vec2(0.22 * ar, 0.72), t * 0.6,  1.0, 15.0);
      h += ripple(p, vec2(0.82 * ar, 0.30), t * 0.5,  0.8, 13.0) * 0.8;
      h += ripple(p, vec2(0.55 * ar, 0.05), t * 0.42, 0.7, 11.0) * 0.6;
      vec2 m = vec2(u_mouse.x * ar, u_mouse.y);
      h += ripple(p, m, t * 0.75, 1.2, 16.0) * 0.45;
      h *= 0.5;

      vec3 base = vec3(0.286, 0.012, 0.031); // #490308
      vec3 deep = vec3(0.150, 0.008, 0.022);
      vec3 gold = vec3(0.914, 0.769, 0.541); // #e9c48a

      float vign = smoothstep(1.25, 0.15, distance(uv, vec2(0.5)));
      vec3 col = mix(deep, base, uv.y);
      col += gold * max(h, 0.0) * 0.17 * u_intensity * vign;
      col = mix(col, deep, (1.0 - vign) * 0.45);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  const ripples = [];
  function createRipple(canvas, intensity) {
    if (!hasTHREE || !canvas) return null;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    } catch (e) { return null; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));

    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const uniforms = {
      u_time: { value: 0 },
      u_res: { value: new THREE.Vector2(1, 1) },
      u_mouse: { value: new THREE.Vector2(0.5, 0.5) },
      u_intensity: { value: intensity },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    scene.add(mesh);

    const target = { mx: 0.5, my: 0.5 };
    function resize() {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      renderer.setSize(w, h, false);
      uniforms.u_res.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    }
    const inst = {
      renderer, uniforms, target, resize,
      render(time) {
        // ease mouse (gentle, so the pointer nudges rather than chases)
        uniforms.u_mouse.value.x += (target.mx - uniforms.u_mouse.value.x) * 0.03;
        uniforms.u_mouse.value.y += (target.my - uniforms.u_mouse.value.y) * 0.03;
        uniforms.u_time.value = time;
        renderer.render(scene, camera);
      }
    };
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
  const heroRipple = createRipple(heroCanvas, intensityFor(heroCanvas, 0.85));
  createRipple(ctaCanvas, intensityFor(ctaCanvas, 0.7));

  // pointer → hero ripple
  if (heroRipple) {
    const hero = document.getElementById("hero");
    hero.addEventListener("pointermove", (e) => {
      const r = hero.getBoundingClientRect();
      heroRipple.target.mx = (e.clientX - r.left) / r.width;
      heroRipple.target.my = 1.0 - (e.clientY - r.top) / r.height;
    });
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
     3 · GSAP scroll reveals + section animations
  ------------------------------------------------------- */
  if (hasGSAP) {
    if (typeof ScrollTrigger !== "undefined") gsap.registerPlugin(ScrollTrigger);

    if (REDUCED) {
      gsap.set(".reveal", { opacity: 1, y: 0 });
    } else {
      // staggered reveal, grouped by nearest section
      gsap.utils.toArray(".reveal").forEach((el) => {
        gsap.set(el, { opacity: 0, y: 26 });
      });
      gsap.utils.toArray("section, .hero").forEach((section) => {
        const items = section.querySelectorAll(".reveal");
        if (!items.length) return;
        ScrollTrigger.create({
          trigger: section,
          start: "top 78%",
          once: true,
          onEnter: () => gsap.to(items, { opacity: 1, y: 0, duration: 0.9, ease: "power3.out", stagger: 0.08 })
        });
      });
      // hero reveals immediately on load
      gsap.to("#hero .reveal", { opacity: 1, y: 0, duration: 1, ease: "power3.out", stagger: 0.09, delay: 0.15 });
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
      if (REDUCED) {
        gsap.set(fill, { height: "100%" });
        markers.forEach((m) => m.classList.add("is-on"));
      } else {
        ScrollTrigger.create({
          trigger: timeline,
          start: "top 70%",
          end: "bottom 82%",
          scrub: 0.6,
          onUpdate: (self) => {
            const p = self.progress;
            gsap.set(fill, { height: (p * 100) + "%" });
            markers.forEach((m, i) => {
              m.classList.toggle("is-on", p >= i / markers.length + 0.08);
            });
          }
        });
      }
    }

    /* --- your week: tasks clear themselves --- */
    const tasks = document.getElementById("tasks");
    if (tasks) {
      const items = tasks.querySelectorAll(".task");
      if (REDUCED) { items.forEach((t) => t.classList.add("done")); }
      else {
        ScrollTrigger.create({
          trigger: tasks, start: "top 72%", once: true,
          onEnter: () => {
            items.forEach((t, i) => {
              gsap.delayedCall(0.5 + i * 0.55, () => t.classList.add("done"));
            });
          }
        });
      }
    }
  } else {
    // no GSAP: ensure everything is visible
    document.querySelectorAll(".reveal").forEach((el) => { el.style.opacity = 1; });
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
      const isOpen = qa.hasAttribute("open");
      if (isOpen) {
        if (hasGSAP && !REDUCED) {
          gsap.to(panel, { height: 0, duration: 0.4, ease: "power2.inOut", onComplete: () => qa.removeAttribute("open") });
        } else { qa.removeAttribute("open"); }
      } else {
        qa.setAttribute("open", "");
        if (hasGSAP && !REDUCED) {
          gsap.fromTo(panel, { height: 0 }, { height: "auto", duration: 0.5, ease: "power2.out" });
        }
      }
    });
  });

  /* -------------------------------------------------------
     5 · Magnetic buttons
  ------------------------------------------------------- */
  if (hasGSAP && !REDUCED && window.matchMedia("(pointer:fine)").matches) {
    document.querySelectorAll(".magnetic").forEach((btn) => {
      btn.addEventListener("pointermove", (e) => {
        const r = btn.getBoundingClientRect();
        const x = (e.clientX - r.left - r.width / 2) * 0.3;
        const y = (e.clientY - r.top - r.height / 2) * 0.4;
        gsap.to(btn, { x, y, duration: 0.5, ease: "power3.out" });
      });
      btn.addEventListener("pointerleave", () => {
        gsap.to(btn, { x: 0, y: 0, duration: 0.6, ease: "elastic.out(1, 0.4)" });
      });
    });
  }

  /* -------------------------------------------------------
     6 · Book-a-call placeholder handler
  ------------------------------------------------------- */
  const bookBtn = document.getElementById("book-btn");
  if (bookBtn) {
    bookBtn.addEventListener("click", (e) => {
      // Replace href with your real booking link (Calendly / GHL calendar) later.
      if (bookBtn.getAttribute("href") === "#") {
        e.preventDefault();
        bookBtn.textContent = "Add your booking link →";
        gsap && gsap.fromTo(bookBtn, { scale: 0.98 }, { scale: 1, duration: 0.4, ease: "back.out(2)" });
      }
    });
  }
})();
