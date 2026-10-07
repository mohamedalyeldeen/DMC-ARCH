// Animated backdrop for the login screen: two slowly rotating double helices
// (the "built into our DNA" motif of DMC's BIM Automation Studio site) with a
// field of drifting, connecting particles. The grid, glows and scan line are
// plain CSS (see the auth-bg rules in styles.css) — only the helix and
// particles need a canvas.
//
// It only runs while the login overlay is actually open: the loop starts when
// #authOverlay gets its "open" class and stops when it loses it, so a logged-in
// session pays nothing for it. Reduced-motion users get a single still frame.
(function(){
  const overlay = document.getElementById('authOverlay');
  const canvas = document.getElementById('authBgCanvas');
  if(!overlay || !canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const AMBER = '226,137,43';
  const TEAL = '125,196,176';
  let w = 0, h = 0, dpr = 1;
  let raf = 0, running = false;
  let particles = [];
  let mx = 0.5, my = 0.5, tmx = 0.5, tmy = 0.5; // pointer position (0..1), eased for a soft parallax

  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = overlay.clientWidth; h = overlay.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(70, Math.max(24, (w * h) / 26000)));
    particles = Array.from({length: n}, ()=>({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .28, vy: (Math.random() - .5) * .28,
      r: Math.random() * 1.4 + .5, teal: Math.random() < .65
    }));
    if(!running) draw(0); // keep a valid still frame on resize when not animating
  }

  // One helix: two strands of nodes wound around a vertical axis, joined by rungs.
  function drawHelix(cx, R, phase, t, alpha){
    const N = 46, top = -30, span = h + 60;
    const strands = [[], []];
    for(let i = 0; i <= N; i++){
      const y = top + span * i / N;
      const ang = (i / N) * Math.PI * 2 * 2.4 + t * 0.00042 + phase;
      for(let s = 0; s < 2; s++){
        const a = ang + s * Math.PI;
        const z = Math.sin(a) * R;
        const sc = 1 / (1 - z / (R * 5)); // perspective: nearer = bigger
        strands[s].push({x: cx + Math.cos(a) * R * sc, y, z: z / R, sc});
      }
    }
    ctx.lineCap = 'round';
    for(let i = 0; i <= N; i += 2){ // rungs
      const a = strands[0][i], b = strands[1][i];
      const depth = (a.z + b.z) / 2;
      ctx.strokeStyle = `rgba(190,210,215,${alpha * (0.07 + 0.10 * (depth + 1) / 2)})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    for(let s = 0; s < 2; s++){ // strands, brighter where they swing toward the viewer
      const rgb = s ? TEAL : AMBER;
      for(let i = 0; i < N; i++){
        const p = strands[s][i], q = strands[s][i + 1];
        const depth = (p.z + q.z) / 2;
        ctx.strokeStyle = `rgba(${rgb},${alpha * (0.14 + 0.5 * (depth + 1) / 2)})`;
        ctx.lineWidth = 1 + 1.4 * (depth + 1) / 2;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
      for(let i = 0; i <= N; i += 2){
        const p = strands[s][i];
        ctx.fillStyle = `rgba(${rgb},${alpha * (0.25 + 0.7 * (p.z + 1) / 2)})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, (1.4 + 1.8 * (p.z + 1) / 2) * p.sc, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  function draw(t){
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter'; // overlapping strokes add up to a soft glow

    const px = (mx - 0.5), py = (my - 0.5);
    const wide = w > 900;
    const R = wide ? Math.min(96, w * 0.065) : Math.min(60, w * 0.14);
    if(wide){
      drawHelix(w * 0.15 + px * 26, R, 0, t, 0.95);
      drawHelix(w * 0.85 + px * 26, R, Math.PI, t, 0.95);
    } else {
      drawHelix(w * 0.5 + px * 16, R, 0, t, 0.5); // behind the card, kept faint
    }

    // drifting particles, linked to near neighbours
    const ox = -px * 14, oy = -py * 14;
    for(const p of particles){
      if(running){
        p.x += p.vx; p.y += p.vy;
        if(p.x < -10) p.x = w + 10; else if(p.x > w + 10) p.x = -10;
        if(p.y < -10) p.y = h + 10; else if(p.y > h + 10) p.y = -10;
      }
    }
    const LINK = 130;
    for(let i = 0; i < particles.length; i++){
      const a = particles[i];
      for(let j = i + 1; j < particles.length; j++){
        const b = particles[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if(d2 < LINK * LINK){
          ctx.strokeStyle = `rgba(${TEAL},${0.14 * (1 - Math.sqrt(d2) / LINK)})`;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x + ox, a.y + oy); ctx.lineTo(b.x + ox, b.y + oy); ctx.stroke();
        }
      }
    }
    for(const p of particles){
      ctx.fillStyle = `rgba(${p.teal ? TEAL : AMBER},${p.teal ? 0.55 : 0.7})`;
      ctx.beginPath(); ctx.arc(p.x + ox, p.y + oy, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now){
    if(!running) return;
    mx += (tmx - mx) * 0.05; my += (tmy - my) * 0.05;
    draw(now);
    raf = requestAnimationFrame(frame);
  }
  function start(){
    if(running) return;
    resize();
    if(reduceMotion){ draw(0); return; }
    running = true;
    raf = requestAnimationFrame(frame);
  }
  function stop(){
    running = false;
    cancelAnimationFrame(raf);
  }
  function sync(){ overlay.classList.contains('open') ? start() : stop(); }

  overlay.addEventListener('pointermove', (e)=>{ tmx = e.clientX / (w || 1); tmy = e.clientY / (h || 1); });
  window.addEventListener('resize', ()=>{ if(overlay.classList.contains('open')) resize(); });
  new MutationObserver(sync).observe(overlay, {attributes: true, attributeFilter: ['class']});
  sync();
})();
