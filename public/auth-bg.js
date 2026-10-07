// Animated backdrop for the login screen: a holographic cube hovering over a
// glowing HUD platform. Small task tiles rise from the platform and orbit the
// cube, changing colour as they pass through Click's four stages (To Do →
// In Progress → Submitted → Done) and pulsing when they reach Done, with thin
// light streaks and dust drifting upward behind them.
//
// You can grab the cube with the mouse (or a finger) and turn it; let go and it coasts
// to a stop, then picks its own slow spin back up.
//
// Apart from the cube's rotation (autoT + your drag), everything is drawn from the
// clock `t` alone, with no per-object state, so the still frame used for
// reduced-motion is the same code as the animation.
// The grid, glows and scan line are plain CSS (auth-bg rules in styles.css).
//
// The loop only runs while the login overlay is open: it starts when
// #authOverlay gets its "open" class and stops when it loses it, so a
// logged-in session pays nothing for it.
(function(){
  const overlay = document.getElementById('authOverlay');
  const canvas = document.getElementById('authBgCanvas');
  if(!overlay || !canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const GOLD = '232,156,62', CREAM = '246,241,228'; // the app's amber and paper colours, a touch brighter so they glow on the dark
  const GREY = '185,194,206', AMBER = '226,137,43', TEAL = '95,179,165', GREEN = '143,181,136'; // the board's column colours

  let w = 0, h = 0, dpr = 1;
  let raf = 0, running = false;
  let wide = true, cx = 0, cyCube = 0, cyR = 0, rx = 0, S = 60;
  let mx = 0.5, my = 0.5, tmx = 0.5, tmy = 0.5; // pointer (0..1), eased for a soft parallax
  // Grab-to-rotate: the cube's own spin runs on autoT (which eases to a stop while you hold it
  // or it coasts), and your drag adds uYaw/uPitch on top, so letting go hands off smoothly.
  let autoT = 0, spin = 1, uYaw = 0, uPitch = 0, vYaw = 0, vPitch = 0;
  let hovering = false, dragging = false, hoverK = 0, lastNow = 0, dragX = 0, dragY = 0;
  let cubeX = 0, cubeY = 0; // where the cube was last drawn, for hit-testing

  const rnd = (i, k)=>{ const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return s - Math.floor(s); };
  const lerp = (a, b, k)=> a + (b - a) * k;
  const ease = (k)=> k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;

  const V = [];
  for(const x of [-1, 1]) for(const y of [-1, 1]) for(const z of [-1, 1]) V.push([x, y, z]);
  const E = [];
  for(let i = 0; i < 8; i++) for(let j = i + 1; j < 8; j++){
    const d = (V[i][0] !== V[j][0]) + (V[i][1] !== V[j][1]) + (V[i][2] !== V[j][2]);
    if(d === 1) E.push([i, j]);
  }
  let cubePts = [];

  function buildCubePoints(){
    cubePts = [];
    for(const [i, j] of E){ // dotted edges
      for(let k = 0; k < 16; k++){
        const f = (k + .5) / 16, a = V[i], b = V[j];
        cubePts.push({x: lerp(a[0], b[0], f), y: lerp(a[1], b[1], f), z: lerp(a[2], b[2], f), r: .9, ph: Math.random() * 6.28});
      }
    }
    for(let face = 0; face < 6; face++){ // sparkle scattered over the faces
      for(let k = 0; k < 90; k++){
        const p = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
        p[face >> 1] = face & 1 ? 1 : -1;
        cubePts.push({x: p[0], y: p[1], z: p[2], r: .6 + Math.random() * .7, ph: Math.random() * 6.28});
      }
    }
  }

  function resize(){
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = overlay.clientWidth; h = overlay.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    wide = w > 900;
    // On wide screens the card sits on the right, so the scene is centred in the space to its left.
    const card = overlay.querySelector('.auth-card');
    const cr = card ? card.getBoundingClientRect() : null;
    cx = wide ? Math.max(w * 0.2, (cr && cr.width ? cr.left : w * 0.64) / 2) : w / 2;
    S = wide ? Math.min(h * 0.14, w * 0.09, 120) : Math.min(w * 0.16, h * 0.09, 64);
    cyCube = h * (wide ? 0.36 : 0.30);
    cyR = cyCube + S * 3.0;
    rx = wide ? Math.min(w * 0.2, S * 4.6) : Math.min(w * 0.42, S * 3.6);
    buildCubePoints();
    if(!running) draw(0);
  }

  function rot(p, ay, ax){
    let c = Math.cos(ay), s = Math.sin(ay);
    const x1 = p[0] * c + p[2] * s, z1 = -p[0] * s + p[2] * c;
    c = Math.cos(ax); s = Math.sin(ax);
    return [x1, p[1] * c - z1 * s, p[1] * s + z1 * c];
  }

  function stageColor(p){ return p < .28 ? GREY : p < .56 ? AMBER : p < .8 ? TEAL : GREEN; }

  function drawStreaks(t){
    const n = wide ? 30 : 16;
    const span = wide ? Math.min(w * 0.9, rx * 4.4) : w;
    for(let i = 0; i < n; i++){
      const x = cx + (rnd(i, 6) - .5) * span;
      const len = 50 + rnd(i, 7) * 190, sp = 14 + rnd(i, 8) * 34, total = h + len;
      const y = (((rnd(i, 9) * total - t * 0.001 * sp) % total) + total) % total - len;
      const g = ctx.createLinearGradient(x, y, x, y + len);
      g.addColorStop(0, `rgba(${GOLD},0)`);
      g.addColorStop(1, `rgba(${GOLD},${.10 + .14 * rnd(i, 10)})`);
      ctx.strokeStyle = g; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + len); ctx.stroke();
      ctx.fillStyle = `rgba(${CREAM},.55)`;
      ctx.beginPath(); ctx.arc(x, y + len, 1.1, 0, 6.2832); ctx.fill();
    }
  }

  function ring(r, a0, a1, width, rgb, alpha, ox){
    ctx.strokeStyle = `rgba(${rgb},${alpha})`; ctx.lineWidth = width;
    ctx.beginPath(); ctx.ellipse(cx + ox, cyR, r, r * .24, 0, a0, a1); ctx.stroke();
  }

  function drawPlatform(t, ox){
    // pool of light under the cube
    ctx.save();
    ctx.translate(cx + ox, cyR); ctx.scale(1, .24);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * 1.12);
    g.addColorStop(0, `rgba(${GOLD},.42)`); g.addColorStop(.45, `rgba(${GOLD},.14)`); g.addColorStop(1, `rgba(${GOLD},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx * 1.12, 0, 6.2832); ctx.fill();
    ctx.restore();

    // light column rising from the platform to the cube
    const top = cyCube + S * 1.2, rr = rx * .42;
    const col = ctx.createLinearGradient(0, cyR, 0, top);
    col.addColorStop(0, `rgba(${GOLD},.20)`); col.addColorStop(1, `rgba(${GOLD},0)`);
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(cx + ox - rr, cyR); ctx.lineTo(cx + ox - S * .9, top); ctx.lineTo(cx + ox + S * .9, top); ctx.lineTo(cx + ox + rr, cyR); ctx.closePath(); ctx.fill();

    const a = t * 0.00022;
    for(let k = 0; k < 5; k++){ // outer ring: segments with gaps; one carries the brand amber
      const s0 = a + k * 1.2566;
      ring(rx, s0, s0 + .9, 5, k === 0 ? TEAL : GOLD, .12, ox);
      ring(rx, s0, s0 + .9, 2, k === 0 ? TEAL : CREAM, .85, ox);
    }
    ring(rx * .82, 0, 6.2832, 1, GOLD, .35, ox);
    for(let k = 0; k < 2; k++){ const s0 = -a * 1.6 + k * 3.1416; ring(rx * .82, s0, s0 + 1.1, 3, GOLD, .8, ox); }
    const a2 = t * 0.0003; // tick ring, counter-rotating
    ctx.strokeStyle = `rgba(${CREAM},.55)`; ctx.lineWidth = 1;
    for(let k = 0; k < 56; k++){
      const ang = a2 + k * 6.2832 / 56, long = k % 4 === 0;
      const r0 = rx * .6, r1 = rx * (long ? .67 : .64);
      ctx.beginPath();
      ctx.moveTo(cx + ox + Math.cos(ang) * r0, cyR + Math.sin(ang) * r0 * .24);
      ctx.lineTo(cx + ox + Math.cos(ang) * r1, cyR + Math.sin(ang) * r1 * .24);
      ctx.stroke();
    }
    ring(rx * .42, 0, 6.2832, 7, GOLD, .12, ox);
    ring(rx * .42, 0, 6.2832, 2.2, CREAM, .95, ox);
  }

  const TILES = 16, LIFE = 12000;
  function tileAt(i, t, S3){
    const p = ((t / LIFE) + rnd(i, 1)) % 1;
    const a0 = rnd(i, 2) * 6.2832, dir = rnd(i, 3) < .5 ? -1 : 1;
    const ang = a0 + dir * (t * 0.00035 + p * 2.4);
    const r = S3 * (1.5 + .35 * Math.sin(a0 * 3 + p * 7));
    return {p, dir, pos: [Math.cos(ang) * r, lerp(S3 * 2.55, -S3 * 1.9, ease(p)), Math.sin(ang) * r]};
  }

  function drawTile(i, t, pr, FOV, alpha, ox, oy, farOnly, nearOnly){
    const st = tileAt(i, t, S);
    const z = st.pos[2];
    if((farOnly && z <= 0) || (nearOnly && z > 0)) return;
    const sc = FOV / (FOV + z);
    const X = cx + ox + st.pos[0] * sc, Y = cyCube + oy + st.pos[1] * sc;
    const fade = Math.min(1, st.p / .08) * Math.min(1, (1 - st.p) / .12) * alpha;
    if(fade <= 0.01) return;
    const rgb = stageColor(st.p);
    const prev = tileAt(i, t - LIFE * .03, S);
    if(prev.p < st.p){ // short trail behind the tile
      const psc = FOV / (FOV + prev.pos[2]);
      const px0 = cx + ox + prev.pos[0] * psc, py0 = cyCube + oy + prev.pos[1] * psc;
      const g = ctx.createLinearGradient(px0, py0, X, Y);
      g.addColorStop(0, `rgba(${rgb},0)`); g.addColorStop(1, `rgba(${rgb},${.35 * fade})`);
      ctx.strokeStyle = g; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(X, Y); ctx.stroke();
    }
    const half = S * (.07 + .05 * rnd(i, 4)) * sc, spin = rnd(i, 5) * 6 + t * 0.0012 * st.dir;
    ctx.beginPath();
    for(let k = 0; k < 4; k++){
      const a = spin + k * 1.5708 + .7854;
      const px1 = X + Math.cos(a) * half * 1.414, py1 = Y + Math.sin(a) * half * 1.414 * .8;
      k ? ctx.lineTo(px1, py1) : ctx.moveTo(px1, py1);
    }
    ctx.closePath();
    ctx.fillStyle = `rgba(${rgb},${.14 * fade})`; ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},${.95 * fade})`; ctx.lineWidth = 1.1; ctx.stroke();
    if(st.p > .8 && st.p < .93){ // arrival at Done: a ring pulses out
      const k = (st.p - .8) / .13;
      ctx.strokeStyle = `rgba(${GREEN},${.7 * (1 - k) * fade})`; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(X, Y, S * .55 * k * sc + half, 0, 6.2832); ctx.stroke();
    }
  }

  function drawCube(t, ox, oy){
    const FOV = S * 7;
    const ay = autoT * 0.00055 + uYaw, ax = .62 + Math.sin(autoT * 0.00031) * .18 + uPitch;
    cubeX = cx + ox; cubeY = cyCube + oy;
    const proj = (p)=>{ const sc = FOV / (FOV + p[2]); return [cx + ox + p[0] * sc, cyCube + oy + p[1] * sc, sc, p[2]]; };
    const depthK = (z)=> 1 - .45 * Math.min(1, Math.max(0, (z + S * 1.75) / (S * 3.5)));

    const edges = (scale, ay2, ax2, passes)=>{
      const pts = V.map(v => proj(rot([v[0] * S * scale, v[1] * S * scale, v[2] * S * scale], ay2, ax2)));
      for(const [lw, al, rgb] of passes){
        ctx.lineWidth = lw;
        for(const [i, j] of E){
          const a = pts[i], b = pts[j];
          ctx.strokeStyle = `rgba(${rgb},${al * depthK((a[3] + b[3]) / 2)})`;
          ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        }
      }
      return pts;
    };
    edges(.46, -autoT * 0.0008 + uYaw * .6, ax * 1.3, [[1, .45 + .3 * hoverK, GOLD]]); // inner cube, counter-rotating
    const pts = edges(1, ay, ax, [[5 + 3 * hoverK, .07 + .14 * hoverK, GOLD], [1.4, .9, CREAM]]);

    for(const p of cubePts){ // sparkle particles
      const q = proj(rot([p.x * S, p.y * S, p.z * S], ay, ax));
      const tw = .5 + .5 * Math.sin(t * 0.002 + p.ph);
      ctx.fillStyle = `rgba(${CREAM},${(.3 + .65 * tw * tw) * depthK(q[3])})`;
      ctx.beginPath(); ctx.arc(q[0], q[1], p.r * q[2], 0, 6.2832); ctx.fill();
    }
    for(const q of pts){ // bright corners
      ctx.fillStyle = `rgba(255,255,255,${.9 * depthK(q[3])})`;
      ctx.beginPath(); ctx.arc(q[0], q[1], (2.1 + 1.2 * hoverK) * q[2], 0, 6.2832); ctx.fill();
    }
  }

  function drawDust(t){
    const n = wide ? 46 : 24;
    for(let i = 0; i < n; i++){
      const x = rnd(i, 11) * w + Math.sin(t * 0.0004 + i) * 18;
      const y = (((rnd(i, 12) * h - t * 0.001 * (6 + rnd(i, 13) * 14)) % h) + h) % h;
      ctx.fillStyle = `rgba(${CREAM},${.12 + .4 * rnd(i, 14)})`;
      ctx.beginPath(); ctx.arc(x, y, .6 + rnd(i, 15) * 1.2, 0, 6.2832); ctx.fill();
    }
  }

  function draw(t){
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter'; // overlapping strokes add up to a soft glow
    ctx.globalAlpha = wide ? 1 : .6;          // behind a full-width card on phones, keep it quieter
    const px = mx - .5, py = my - .5;
    const ox = px * 22, oy = py * 12 + Math.sin(t * 0.0011) * S * .06;
    const FOV = S * 7;
    drawStreaks(t);
    drawPlatform(t, px * 8);
    for(let i = 0; i < TILES; i++) drawTile(i, t, null, FOV, 1, ox, oy, true, false);  // tiles behind the cube
    drawCube(t, ox, oy);
    for(let i = 0; i < TILES; i++) drawTile(i, t, null, FOV, 1, ox, oy, false, true); // tiles in front of it
    drawDust(t);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function frame(now){
    if(!running) return;
    const dt = lastNow ? Math.min(64, now - lastNow) : 16;
    lastNow = now;
    mx += (tmx - mx) * .05; my += (tmy - my) * .05;
    if(!dragging){ // coast after a throw, then settle
      uYaw += vYaw; uPitch += vPitch;
      vYaw *= .95; vPitch *= .95;
      if(Math.abs(vYaw) < .0003) vYaw = 0;
      if(Math.abs(vPitch) < .0003) vPitch = 0;
    }
    const coasting = vYaw !== 0 || vPitch !== 0;
    spin += ((dragging || coasting ? 0 : 1) - spin) * .08; // the cube's own spin pauses while you hold or throw it
    autoT += dt * spin;
    hoverK += ((hovering || dragging ? 1 : 0) - hoverK) * .14;
    draw(now);
    raf = requestAnimationFrame(frame);
  }
  function start(){
    if(running) return;
    resize();
    if(reduceMotion){ draw(0); return; }
    running = true;
    lastNow = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop(){
    running = false;
    cancelAnimationFrame(raf);
    dragging = false; hovering = false; hoverK = 0; vYaw = vPitch = 0;
    overlay.style.cursor = '';
  }
  function sync(){ overlay.classList.contains('open') ? start() : stop(); }

  const overCube = (x, y)=> Math.hypot(x - cubeX, y - cubeY) < S * 1.55;
  const onCard = (e)=> !!(e.target.closest && e.target.closest('.auth-card'));

  overlay.addEventListener('pointermove', (e)=>{
    if(dragging){
      const dx = e.clientX - dragX, dy = e.clientY - dragY;
      dragX = e.clientX; dragY = e.clientY;
      vYaw = -dx * .011; vPitch = dy * .011; // dragging right turns the front face right
      uYaw += vYaw; uPitch += vPitch;
      return; // the parallax stays put while you hold the cube
    }
    tmx = e.clientX / (w || 1); tmy = e.clientY / (h || 1);
    hovering = !reduceMotion && !onCard(e) && overCube(e.clientX, e.clientY);
    overlay.style.cursor = hovering ? 'grab' : '';
  });
  overlay.addEventListener('pointerdown', (e)=>{
    if(reduceMotion || !running || onCard(e) || !overCube(e.clientX, e.clientY)) return;
    dragging = true; dragX = e.clientX; dragY = e.clientY; vYaw = vPitch = 0;
    overlay.style.cursor = 'grabbing';
    try{ overlay.setPointerCapture(e.pointerId); }catch(err){ /* pointer already gone — the drag simply won't track */ }
    e.preventDefault();
  });
  const release = (e)=>{
    if(!dragging) return;
    dragging = false;
    overlay.style.cursor = hovering ? 'grab' : '';
    try{ overlay.releasePointerCapture(e.pointerId); }catch(err){ /* already released */ }
  };
  overlay.addEventListener('pointerup', release);
  overlay.addEventListener('pointercancel', release);
  overlay.addEventListener('pointerleave', ()=>{ if(!dragging){ hovering = false; overlay.style.cursor = ''; } });
  window.addEventListener('resize', ()=>{ if(overlay.classList.contains('open')) resize(); });
  new MutationObserver(sync).observe(overlay, {attributes: true, attributeFilter: ['class']});
  sync();
})();

