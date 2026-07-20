(function(){
  const COLUMNS = [
    {key:'todo', label:'To Do', accent:'var(--text-dim-on-ink)'},
    {key:'inprogress', label:'In Progress', accent:'var(--amber)'},
    {key:'submitted', label:'Submitted for Review', accent:'var(--teal)'},
    {key:'done', label:'Done', accent:'#5C8F55'}
  ];
  const PRIORITY_COLOR = {H:'var(--rust)', M:'var(--amber)', L:'var(--teal)'};

  let session = null;   // {token, role, name, id, teamId, isTeamLead}
  let state = {teams:[], members:[], tasks:[], dashboardTasks:[]};
  let filter = null;    // null | {type:'member'|'team', id}
  let activeTab = 'board';
  let capacityData = [];
  let capacitySortMode = 'availability'; // 'availability' | 'capacity'
  let evaFilters = { engineer:'', team:'', from:'', to:'' };
  let modalOpenFlag = false;
  let pollTimer = null;

  // Undo: an in-memory stack of {label, restore} for this browser tab only.
  // See pushUndo()/renderUndoButton() below for the one real limitation.
  const UNDO_LIMIT = 20;
  let undoStack = [];

  // Gantt view state
  let ganttGroupBy = 'engineer'; // 'engineer' | 'team'
  let ganttZoom = 'week';        // 'day' | 'week' | 'month'
  const GANTT_DAY_WIDTH = {day:36, week:14, month:5};

  function todayStr(){
    // Local calendar day (not UTC) — this is what "today" should mean to
    // whoever is looking at the board, and it's what overdue/today-line
    // comparisons against startDate/endDate are meant to line up with.
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  // Every YYYY-MM-DD string in this app (startDate/endDate/etc.) is a plain
  // calendar date with no timezone attached. Parsing it as local midnight
  // and then reading it back out via toISOString() (UTC) — the pattern this
  // codebase used to use — silently shifts by a day in any timezone ahead of
  // UTC, and can make "add one day" return the *same* day. That turns any
  // while-loop that advances by that amount into an infinite loop (this is
  // what froze the Gantt tab). Parsing and reading every date-only string in
  // UTC throughout keeps the arithmetic identical no matter what timezone
  // the browser is in.
  function parseIsoUTC(iso){ return new Date(iso + 'T00:00:00Z'); }
  function fmtDate(iso){ if(!iso) return '—'; return parseIsoUTC(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}); }
  function escapeHtml(str){ const d=document.createElement('div'); d.textContent = str==null?'':String(str); return d.innerHTML; }
  function initials(name){ return (name||'').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase(); }

  // ---------- WEEKEND POLICY (Friday & Saturday are non-working days) ----------
  function isWeekendIso(iso){ if(!iso) return false; const dow = parseIsoUTC(iso).getUTCDay(); return dow===5 || dow===6; }
  function addDaysIso(iso, days){ const d=parseIsoUTC(iso); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().slice(0,10); }
  function daysBetweenIso(a,b){ return Math.round((parseIsoUTC(b) - parseIsoUTC(a))/86400000); }

  // ---------- API HELPER ----------
  async function api(method, url, body){
    const opts = { method, headers:{'Content-Type':'application/json'} };
    if(session) opts.headers['Authorization'] = 'Bearer ' + session.token;
    if(body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    let data = null;
    try{ data = await res.json(); }catch(e){}
    if(!res.ok){ throw new Error((data && data.error) || 'Request failed.'); }
    return data;
  }

  // ---------- UNDO ----------
  // Scoped to task-board actions only (create/edit/delete/move/duplicate) —
  // that's where a slip costs the most. Each entry is a {label, restore}
  // pair; restore() calls the same REST endpoints a person would use to
  // manually fix their own mistake.
  //
  // The one real limitation: this stack lives only in memory, in this
  // browser tab, for this login session. Reload the page, log out, or close
  // the tab and it's gone — there's no server-side undo history. It's also
  // a best-effort replay against whatever the board looks like *right now*,
  // so if someone else edited the same task in the meantime, undo can fail
  // or produce a slightly different result than a perfect time-rewind would.
  // The tooltip on the button says as much.
  function pushUndo(label, restoreFn){
    undoStack.push({label, restore: restoreFn});
    if(undoStack.length > UNDO_LIMIT) undoStack.shift();
    renderUndoButton();
  }
  function clearUndo(){ undoStack = []; renderUndoButton(); }
  function renderUndoButton(){
    const btn = document.getElementById('undoBtn');
    if(!btn) return;
    if(undoStack.length===0){ btn.style.display='none'; return; }
    const top = undoStack[undoStack.length-1];
    btn.style.display = 'inline-flex';
    btn.textContent = '↺';
    btn.title = `Undo: ${top.label}\n\nOnly covers actions you've taken this session, on this device — it won't survive a page reload and can't undo changes someone else made in the meantime.`;
  }
  document.getElementById('undoBtn').addEventListener('click', async ()=>{
    if(undoStack.length===0) return;
    const action = undoStack.pop();
    renderUndoButton();
    try{
      await action.restore();
      await refreshState();
    }catch(e){
      alert(`Couldn't undo "${action.label}": ${e.message}\n\nThis usually means the board changed since then (e.g. someone else edited or moved the same task).`);
    }
  });

  // ---------- BOOT ----------
  async function boot(){
    try{
      const status = await api('GET', '/api/auth/status');
      document.getElementById('loadingScreen').style.display = 'none';
      if(status.setupNeeded){
        document.getElementById('setupPanel').style.display = 'block';
        document.getElementById('loginPanel').style.display = 'none';
      } else {
        document.getElementById('setupPanel').style.display = 'none';
        document.getElementById('loginPanel').style.display = 'block';
      }
      document.getElementById('authOverlay').classList.add('open');
    }catch(e){
      document.getElementById('loadingScreen').textContent = 'Could not reach the Click server. Check that it is running.';
    }
  }

  document.getElementById('setupBtn').addEventListener('click', async ()=>{
    const pw1 = document.getElementById('setupPw1').value;
    const pw2 = document.getElementById('setupPw2').value;
    const err = document.getElementById('setupError');
    if(!pw1 || pw1.length<3){ err.textContent='Choose a password (3+ characters).'; return; }
    if(pw1!==pw2){ err.textContent='Passwords do not match.'; return; }
    try{
      const data = await api('POST', '/api/auth/setup', {password: pw1, ownerName: document.getElementById('setupOwnerName').value});
      session = data;
      enterApp();
    }catch(e){ err.textContent = e.message; }
  });

  const AUTH_TABS = [
    { tabId: 'ownerTabBtn', formId: 'ownerLoginForm' },
    { tabId: 'memberTabBtn', formId: 'memberLoginForm' },
    { tabId: 'viewerTabBtn', formId: 'viewerLoginForm' }
  ];
  function activateAuthTab(activeTabId){
    AUTH_TABS.forEach(({tabId, formId})=>{
      document.getElementById(tabId).classList.toggle('active', tabId===activeTabId);
      document.getElementById(formId).style.display = tabId===activeTabId ? 'block' : 'none';
    });
    document.getElementById('loginError').textContent = '';
  }
  AUTH_TABS.forEach(({tabId})=>{
    document.getElementById(tabId).addEventListener('click', ()=> activateAuthTab(tabId));
  });

  document.getElementById('ownerLoginBtn').addEventListener('click', async ()=>{
    const pw = document.getElementById('ownerPwInput').value;
    const err = document.getElementById('loginError');
    try{
      const data = await api('POST', '/api/auth/login-owner', {password: pw});
      session = data;
      err.textContent = '';
      enterApp();
    }catch(e){ err.textContent = e.message; }
  });

  document.getElementById('memberLoginBtn').addEventListener('click', async ()=>{
    const username = document.getElementById('memberUserInput').value;
    const pw = document.getElementById('memberPwInput').value;
    const err = document.getElementById('loginError');
    try{
      const data = await api('POST', '/api/auth/login-member', {username, password: pw});
      session = data;
      err.textContent = '';
      enterApp();
    }catch(e){ err.textContent = e.message; }
  });

  // Viewer accounts are still Members under the hood (just with isViewer
  // set) so this hits the same login endpoint as the Team member tab —
  // the separate tab exists purely so a viewer isn't hunting for their
  // login under a label that says "Team member".
  document.getElementById('viewerLoginBtn').addEventListener('click', async ()=>{
    const username = document.getElementById('viewerUserInput').value;
    const pw = document.getElementById('viewerPwInput').value;
    const err = document.getElementById('loginError');
    try{
      const data = await api('POST', '/api/auth/login-member', {username, password: pw});
      session = data;
      err.textContent = '';
      enterApp();
    }catch(e){ err.textContent = e.message; }
  });

  async function enterApp(){
    document.getElementById('authOverlay').classList.remove('open');
    document.getElementById('appShell').style.display = 'flex';
    activeTab = 'board';
    clearUndo();
    await refreshState();
    pollTimer = setInterval(()=>{ if(!modalOpenFlag) refreshState(); }, 8000);
  }

  document.getElementById('logoutBtn').addEventListener('click', ()=>{
    session = null;
    if(pollTimer) clearInterval(pollTimer);
    clearUndo();
    capacityLoaded = false;
    capacityData = [];
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('authOverlay').classList.add('open');
    document.getElementById('ownerPwInput').value='';
    document.getElementById('memberUserInput').value='';
    document.getElementById('memberPwInput').value='';
    document.getElementById('viewerUserInput').value='';
    document.getElementById('viewerPwInput').value='';
  });

  document.getElementById('changePwBtn').addEventListener('click', async ()=>{
    const np = prompt('Enter a new password:');
    if(!np) return;
    try{
      await api('POST', '/api/auth/change-password', {newPassword: np});
      alert('Password updated.');
    }catch(e){ alert(e.message); }
  });

  document.getElementById('saveCloseBtn').addEventListener('click', async ()=>{
    await refreshState();
    alert('Everything is saved to the shared Google Sheet. You can safely close this tab now.');
    try{ window.close(); }catch(e){}
  });

  // ---------- STATE / PERMISSIONS ----------
  function isOwner(){ return session && session.role==='owner'; }
  function isTeamLead(){ return session && session.role==='teamlead'; }
  function isViewer(){ return session && session.role==='viewer'; }
  // Viewers see the full board like a leader would (whole-board visibility,
  // team filters, capacity/dashboard) but can never act on anything — see
  // canManageTasks() below, which is the actual permission gate and
  // deliberately excludes them.
  function isLeaderLike(){ return isOwner() || isTeamLead() || isViewer(); }
  function canManageMembers(){ return isOwner(); }
  function canManageTasks(){ return isOwner() || isTeamLead(); }
  function isMyReport(memberId){
    if(isOwner()) return true;
    if(memberId===session.id) return true; // team leaders can self-assign (Phase 2)
    const m = memberById(memberId);
    return !!(m && m.reportsTo === session.id);
  }
  function canManageThisTask(t){
    if(isOwner()) return true;
    if(isTeamLead()) return isMyReport(t.assignee);
    return false;
  }
  function canAdvance(task, fromIdx){
    if(canManageThisTask(task)) return true;
    return session && task.assignee===session.id && fromIdx < 2;
  }
  function memberById(id){ return state.members.find(m=>m.id===id); }
  function teamById(id){ return state.teams.find(t=>t.id===id); }
  function teamTaskCount(teamId){
    const ids = state.members.filter(m=>m.teamId===teamId).map(m=>m.id);
    return state.tasks.filter(t=> ids.includes(t.assignee)).length;
  }

  async function refreshState(){
    try{
      const data = await api('GET', '/api/state');
      state = data;
      renderApp();
      maybeShowCelebration();
    }catch(e){
      if(e.message && e.message.toLowerCase().includes('session')){
        document.getElementById('logoutBtn').click();
      }
    }
  }

  // ---------- APP RENDER ----------
  function renderApp(){
    renderRoleBadge();
    renderNotifBadge();
    renderSidebar();
    document.getElementById('tabCapacityBtn').style.display = isLeaderLike() ? 'inline-block' : 'none';
    document.getElementById('myStatsBtn').style.display = (isOwner() || isViewer()) ? 'none' : 'inline-block';
    document.getElementById('board').style.display='none';
    document.getElementById('ganttView').style.display='none';
    document.getElementById('dashboardView').style.display='none';
    document.getElementById('logView').style.display='none';
    document.getElementById('capacityView').style.display='none';
    if(activeTab==='board'){
      document.getElementById('viewTitle').textContent = isLeaderLike() ? "This Week's Jobs" : 'My Tasks';
      document.getElementById('board').style.display='flex';
      document.getElementById('newTaskBtn').style.display = canManageTasks() ? 'inline-block' : 'none';
      renderBoard();
    } else if(activeTab==='gantt'){
      document.getElementById('viewTitle').textContent = 'Gantt';
      document.getElementById('ganttView').style.display='flex';
      document.getElementById('newTaskBtn').style.display='none';
      renderGantt();
    } else if(activeTab==='dashboard'){
      document.getElementById('viewTitle').textContent = 'Performance Ledger';
      document.getElementById('dashboardView').style.display='block';
      document.getElementById('newTaskBtn').style.display='none';
      renderDashboard();
    } else if(activeTab==='log'){
      document.getElementById('viewTitle').textContent = 'Productivity Log';
      document.getElementById('logView').style.display='block';
      document.getElementById('newTaskBtn').style.display='none';
      loadAndRenderLog();
    } else {
      document.getElementById('viewTitle').textContent = 'Capacity';
      document.getElementById('capacityView').style.display='block';
      document.getElementById('newTaskBtn').style.display='none';
      loadAndRenderCapacity();
    }
    renderStats();
  }

  function renderRoleBadge(){
    let label = '';
    if(isOwner()) label = (session.name || 'Owner') + ' (Owner)';
    else if(isViewer()) label = (session.name || 'Viewer') + ' (Viewer — read only)';
    else if(isTeamLead()) label = 'Team Leader — ' + (teamById(session.teamId)||{name:''}).name;
    else label = 'Member — ' + (teamById(session.teamId)||{name:''}).name;
    document.getElementById('roleBadge').textContent = label;
    document.getElementById('ownerNameBtn').style.display = isOwner() ? 'inline-block' : 'none';
  }
  document.getElementById('ownerNameBtn').addEventListener('click', async ()=>{
    const name = prompt('Enter your name (shown to your team instead of "The board owner"):', session.name || '');
    if(!name || !name.trim()) return;
    try{
      const data = await api('POST', '/api/auth/set-owner-name', {name: name.trim()});
      session.token = data.token;
      session.name = data.name;
      renderRoleBadge();
    }catch(e){ alert(e.message); }
  });

  function renderNotifBadge(){
    const count = state.unreadCount || 0;
    const badge = document.getElementById('notifBadge');
    if(count > 0){
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function fmtDateTime(iso){
    if(!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('en-US', {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  }

  function renderNotifList(){
    const list = document.getElementById('notifList');
    const notifs = state.notifications || [];
    if(notifs.length===0){
      list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      return;
    }
    list.innerHTML = notifs.map(n => {
      const task = state.tasks.find(t=>t.id===n.taskId);
      const dateLine = task && task.startDate && task.endDate ? `${fmtDate(task.startDate)} → ${fmtDate(task.endDate)}` : 'No dates set';
      return `
      <div class="notif-row ${n.read?'':'unread'}" data-id="${n.id}">
        ${n.read?'':'<span class="notif-dot"></span>'}${escapeHtml(n.message)}
        <div class="notif-time">${n.actorName?`By ${escapeHtml(n.actorName)} · `:''}${dateLine} · ${fmtDateTime(n.createdAt)}</div>
      </div>
    `;
    }).join('');
    list.querySelectorAll('.notif-row').forEach(row=>{
      row.addEventListener('click', async ()=>{
        const id = row.dataset.id;
        const n = notifs.find(x=>x.id===id);
        if(n && !n.read){
          try{ await api('POST', `/api/notifications/${id}/read`); await refreshState(); openNotificationsPanel(); }
          catch(e){ /* ignore */ }
        }
      });
    });
  }

  function openNotificationsPanel(){
    modalOpenFlag = true;
    renderNotifList();
    document.getElementById('notificationsOverlay').classList.add('open');
  }
  function closeNotificationsPanel(){
    document.getElementById('notificationsOverlay').classList.remove('open');
    modalOpenFlag = false;
  }
  document.getElementById('notifBtn').addEventListener('click', openNotificationsPanel);
  document.getElementById('closeNotifBtn').addEventListener('click', closeNotificationsPanel);
  document.getElementById('notificationsOverlay').addEventListener('click', (e)=>{ if(e.target.id==='notificationsOverlay') closeNotificationsPanel(); });
  document.getElementById('markAllReadBtn').addEventListener('click', async ()=>{
    try{ await api('POST', '/api/notifications/read-all'); await refreshState(); renderNotifList(); }
    catch(e){ alert(e.message); }
  });

  const ALL_TAB_BTNS = ['tabBoardBtn','tabGanttBtn','tabDashBtn','tabLogBtn','tabCapacityBtn'];
  function activateTab(name, btnId){
    activeTab = name;
    ALL_TAB_BTNS.forEach(id=> document.getElementById(id).classList.toggle('active', id===btnId));
    renderApp();
  }
  document.getElementById('tabBoardBtn').addEventListener('click', ()=> activateTab('board','tabBoardBtn'));
  document.getElementById('tabGanttBtn').addEventListener('click', ()=> activateTab('gantt','tabGanttBtn'));
  document.getElementById('tabDashBtn').addEventListener('click', ()=> activateTab('dashboard','tabDashBtn'));
  document.getElementById('tabLogBtn').addEventListener('click', ()=> activateTab('log','tabLogBtn'));
  document.getElementById('tabCapacityBtn').addEventListener('click', ()=> activateTab('capacity','tabCapacityBtn'));

  function renderStats(){
    const visible = isLeaderLike() ? state.tasks : state.tasks;
    const total = visible.length;
    const done = visible.filter(t=>t.status==='done').length;
    document.getElementById('statsLine').textContent = `${total} total · ${done} done`;
  }

  // ---------- SIDEBAR ----------
  function renderSidebar(){
    const el = document.getElementById('sidebar');
    if(isLeaderLike()){
      el.innerHTML = `
        <img src="/dmc-logo-white.png" class="brand-logo" alt="DMC Contracting"><div class="brand">Cli<span>ck</span></div>
        <div class="brand-sub">Team task ledger</div>
        <div class="side-section">
          <div class="side-label"><span>Teams</span>${canManageMembers()?'<button class="ghost-btn" id="addMemberBtn" style="padding:3px 8px;">+ Member</button>':''}</div>
          <div id="memberList"></div>
        </div>
        <div class="side-section">
          <div class="side-label"><span>Priority key</span></div>
          <div class="legend-row"><span class="stamp-dot" style="background:var(--rust);">H</span> High priority</div>
          <div class="legend-row"><span class="stamp-dot" style="background:var(--amber);">M</span> Medium priority</div>
          <div class="legend-row"><span class="stamp-dot" style="background:var(--teal);">L</span> Low priority</div>
        </div>
        <div class="sidebar-foot">
          <button class="ghost-btn" id="exportBtn">↓ EXPORT SNAPSHOT (.json)</button>
          <div style="font-size:10.5px;color:var(--text-dim-on-ink);line-height:1.5;">Tasks are stored in your Google Sheet. Use File → Version history there for backups.</div>
        </div>
      `;
      renderTeamList();
      const addBtn = document.getElementById('addMemberBtn');
      if(addBtn) addBtn.addEventListener('click', ()=>openMemberModal(null));
      document.getElementById('exportBtn').addEventListener('click', doExport);
    } else {
      const team = teamById(session.teamId);
      el.innerHTML = `
        <img src="/dmc-logo-white.png" class="brand-logo" alt="DMC Contracting"><div class="brand">Cli<span>ck</span></div>
        <div class="brand-sub">Team task ledger</div>
        <div class="info-panel">
          Signed in as<br><b>${escapeHtml(session.name)}</b><br>
          Team: <b>${escapeHtml(team?team.name:'—')}</b><br><br>
          You can see and update your own tasks. Only your team leader or the board owner can approve submitted work, or add/remove tasks and members.
        </div>
      `;
    }
  }

  function renderTeamList(){
    const list = document.getElementById('memberList');
    list.innerHTML = '';
    const allRow = document.createElement('div');
    allRow.className = 'team-head' + (filter===null ? ' active':'');
    allRow.innerHTML = `<div class="team-dot" style="background:var(--paper-dim);"></div><div class="team-name">Everyone</div><div class="team-count">${state.tasks.length}</div>`;
    allRow.addEventListener('click', ()=>{ filter=null; renderApp(); });
    list.appendChild(allRow);

    state.teams.forEach(team=>{
      const teamActive = filter && filter.type==='team' && filter.id===team.id;
      const block = document.createElement('div');
      block.className = 'team-block';
      const head = document.createElement('div');
      head.className = 'team-head' + (teamActive?' active':'');
      head.innerHTML = `<div class="team-dot" style="background:${team.color};"></div><div class="team-name" title="Click to rename">${escapeHtml(team.name)}</div><div class="team-count">${teamTaskCount(team.id)}</div>`;
      head.querySelector('.team-name').addEventListener('click', (e)=>{ e.stopPropagation(); if(isOwner()) renameTeam(team.id); });
      head.addEventListener('click', (e)=>{
        if(e.target.classList.contains('team-name')) return;
        filter = teamActive ? null : {type:'team', id:team.id};
        renderApp();
      });
      block.appendChild(head);

      const wrap = document.createElement('div');
      wrap.className = 'team-members';
      const teamMembers = state.members.filter(m=>m.teamId===team.id);
      if(teamMembers.length===0){
        const empty = document.createElement('div');
        empty.style.cssText = 'font-size:11px;color:var(--text-dim-on-ink);padding:4px 8px;';
        empty.textContent = 'No members yet';
        wrap.appendChild(empty);
      }
      teamMembers.forEach(m=>{
        const count = state.tasks.filter(t=>t.assignee===m.id).length;
        const active = filter && filter.type==='member' && filter.id===m.id;
        const row = document.createElement('div');
        row.className = 'member-row' + (active?' active':'');
        row.innerHTML = `
          <div class="avatar" style="background:${m.color};">${initials(m.name)}</div>
          ${m.isTeamLead? '<span class="lead-tag">LEAD</span>':''}
          <div class="member-name">${escapeHtml(m.name)}</div>
          <div class="member-count">${count}</div>
          ${canManageMembers()? `<div class="ed-x" data-id="${m.id}">✎</div><div class="rm-x" data-id="${m.id}">✕</div>`:''}
        `;
        row.addEventListener('click', (e)=>{
          if(e.target.classList.contains('rm-x')){ e.stopPropagation(); removeMember(m.id); return; }
          if(e.target.classList.contains('ed-x')){ e.stopPropagation(); openMemberModal(m.id); return; }
          filter = active ? null : {type:'member', id:m.id};
          renderApp();
        });
        wrap.appendChild(row);
      });
      block.appendChild(wrap);
      list.appendChild(block);
    });

    const viewers = state.members.filter(m=>m.isViewer);
    if(viewers.length>0){
      const block = document.createElement('div');
      block.className = 'team-block';
      const head = document.createElement('div');
      head.className = 'team-head';
      head.innerHTML = `<div class="team-dot" style="background:var(--text-dim-on-ink);"></div><div class="team-name">Viewers</div><div class="team-count">${viewers.length}</div>`;
      block.appendChild(head);
      const wrap = document.createElement('div');
      wrap.className = 'team-members';
      viewers.forEach(m=>{
        const row = document.createElement('div');
        row.className = 'member-row';
        row.innerHTML = `
          <div class="avatar" style="background:${m.color};">${initials(m.name)}</div>
          <span class="lead-tag" style="color:var(--text-dim-on-ink);border-color:var(--text-dim-on-ink);">VIEW</span>
          <div class="member-name">${escapeHtml(m.name)}</div>
          ${canManageMembers()? `<div class="ed-x" data-id="${m.id}">✎</div><div class="rm-x" data-id="${m.id}">✕</div>`:''}
        `;
        row.addEventListener('click', (e)=>{
          if(e.target.classList.contains('rm-x')){ e.stopPropagation(); removeMember(m.id); return; }
          if(e.target.classList.contains('ed-x')){ e.stopPropagation(); openMemberModal(m.id); return; }
        });
        wrap.appendChild(row);
      });
      block.appendChild(wrap);
      list.appendChild(block);
    }
  }

  async function renameTeam(teamId){
    const team = teamById(teamId);
    const name = prompt('Rename team:', team.name);
    if(name && name.trim()){
      try{ await api('PUT', '/api/teams/'+teamId, {name: name.trim()}); await refreshState(); }
      catch(e){ alert(e.message); }
    }
  }

  async function removeMember(id){
    if(!confirm('Remove this team member? Their tasks will become unassigned.')) return;
    try{
      await api('DELETE', '/api/members/'+id);
      if(filter && filter.type==='member' && filter.id===id) filter=null;
      await refreshState();
    }catch(e){ alert(e.message); }
  }

  // ---------- MEMBER MODAL ----------
  function populateReportsToOptions(teamId, selected){
    const sel = document.getElementById('mmReportsTo');
    const leaders = state.members.filter(m=>m.isTeamLead && m.teamId===teamId);
    if(leaders.length===0){
      sel.innerHTML = '<option value="">No team leader on this team yet</option>';
    } else {
      sel.innerHTML = '<option value="">Not assigned</option>' + leaders.map(l=>`<option value="${l.id}">${escapeHtml(l.name)}</option>`).join('');
    }
    sel.value = selected || '';
  }
  function toggleReportsToVisibility(){
    const isLead = document.getElementById('mmLead').checked;
    document.getElementById('reportsToField').style.display = isLead ? 'none' : 'block';
  }
  function toggleViewerVisibility(){
    const isViewerAccount = document.getElementById('mmViewer').checked;
    document.getElementById('teamField').style.display = isViewerAccount ? 'none' : 'block';
    document.getElementById('mmLeadField').style.display = isViewerAccount ? 'none' : 'block';
    document.getElementById('reportsToField').style.display = isViewerAccount ? 'none' : (document.getElementById('mmLead').checked ? 'none' : 'block');
    if(isViewerAccount) document.getElementById('mmLead').checked = false;
  }
  document.getElementById('mmLead').addEventListener('change', toggleReportsToVisibility);
  document.getElementById('mmViewer').addEventListener('change', toggleViewerVisibility);
  document.getElementById('mmTeam').addEventListener('change', (e)=>{
    populateReportsToOptions(e.target.value, '');
  });

  function openMemberModal(memberId){
    modalOpenFlag = true;
    const form = document.getElementById('memberForm');
    form.reset();
    document.getElementById('mmId').value = memberId || '';
    const teamSel = document.getElementById('mmTeam');
    teamSel.innerHTML = state.teams.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
    if(memberId){
      const m = memberById(memberId);
      document.getElementById('memberModalTitle').textContent = 'Edit team member';
      document.getElementById('saveMemberBtn').textContent = 'Save changes';
      document.getElementById('deleteMemberBtn').style.display='inline';
      document.getElementById('mmName').value = m.name;
      document.getElementById('mmUsername').value = m.username;
      document.getElementById('mmPassword').value = '';
      document.getElementById('mmEmail').value = m.email || '';
      teamSel.value = m.teamId;
      document.getElementById('mmLead').checked = !!m.isTeamLead;
      document.getElementById('mmViewer').checked = !!m.isViewer;
      populateReportsToOptions(m.teamId, m.reportsTo);
    } else {
      document.getElementById('memberModalTitle').textContent = 'Add team member';
      document.getElementById('saveMemberBtn').textContent = 'Add member';
      document.getElementById('deleteMemberBtn').style.display='none';
      document.getElementById('mmLead').checked = false;
      document.getElementById('mmViewer').checked = false;
      populateReportsToOptions(teamSel.value, '');
    }
    toggleReportsToVisibility();
    toggleViewerVisibility();
    document.getElementById('memberModalOverlay').classList.add('open');
  }
  function closeMemberModal(){ document.getElementById('memberModalOverlay').classList.remove('open'); modalOpenFlag = false; }
  document.getElementById('cancelMemberModalBtn').addEventListener('click', closeMemberModal);
  document.getElementById('memberModalOverlay').addEventListener('click', (e)=>{ if(e.target.id==='memberModalOverlay') closeMemberModal(); });

  document.getElementById('memberForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    const id = document.getElementById('mmId').value;
    const name = document.getElementById('mmName').value.trim();
    const username = document.getElementById('mmUsername').value.trim();
    const password = document.getElementById('mmPassword').value;
    const teamId = document.getElementById('mmTeam').value;
    const isTeamLead = document.getElementById('mmLead').checked;
    const isViewerAccount = document.getElementById('mmViewer').checked;
    const reportsTo = document.getElementById('mmReportsTo').value;
    const email = document.getElementById('mmEmail').value.trim();
    if(!name || !username) return;
    if(!id && !password){ alert('Set a password for the new member.'); return; }
    try{
      if(id){
        await api('PUT', '/api/members/'+id, {name, username, password, teamId, isTeamLead, isViewer: isViewerAccount, reportsTo, email});
      } else {
        await api('POST', '/api/members', {name, username, password, teamId, isTeamLead, isViewer: isViewerAccount, reportsTo, email});
      }
      closeMemberModal();
      await refreshState();
    }catch(e){ alert(e.message); }
  });
  document.getElementById('deleteMemberBtn').addEventListener('click', ()=>{
    const id = document.getElementById('mmId').value;
    closeMemberModal();
    if(id) removeMember(id);
  });

  // ---------- BOARD ----------
  function visibleTasks(){
    const q = document.getElementById('searchBox').value.trim().toLowerCase();
    let base = state.tasks;
    if(isLeaderLike() && filter){
      base = base.filter(t=>{
        if(filter.type==='member') return t.assignee===filter.id;
        if(filter.type==='team'){ const mem=memberById(t.assignee); return mem && mem.teamId===filter.id; }
        return true;
      });
    }
    if(q) base = base.filter(t=>t.title.toLowerCase().includes(q));
    return base;
  }

  function renderBoard(){
    const board = document.getElementById('board');
    board.innerHTML = '';
    const tasks = visibleTasks();
    COLUMNS.forEach((col, colIdx)=>{
      const colTasks = tasks.filter(t=>t.status===col.key).sort((a,b)=>{
        const aEnd = a.endDate || '9999-99-99';
        const bEnd = b.endDate || '9999-99-99';
        return aEnd < bEnd ? -1 : aEnd > bEnd ? 1 : 0;
      });
      const column = document.createElement('div');
      column.className = 'column';
      const lockNote = col.key==='submitted' ? '<div class="lock-note">Approval: leaders only</div>' : '';
      column.innerHTML = `
        <div class="col-accent" style="background:${col.accent};"></div>
        <div class="column-head"><h2>${col.label}</h2>${lockNote}<div class="col-count">${colTasks.length}</div></div>
        <div class="cards" data-status="${col.key}"></div>
      `;
      const cardsEl = column.querySelector('.cards');
      if(colTasks.length===0){
        const empty=document.createElement('div'); empty.className='empty-col'; empty.textContent='Nothing here yet'; cardsEl.appendChild(empty);
      } else {
        colTasks.forEach(t=> cardsEl.appendChild(renderTicket(t, colIdx)));
      }
      cardsEl.addEventListener('dragover',(e)=>{ e.preventDefault(); cardsEl.classList.add('drag-over'); });
      cardsEl.addEventListener('dragleave',()=> cardsEl.classList.remove('drag-over'));
      cardsEl.addEventListener('drop', async (e)=>{
        e.preventDefault(); cardsEl.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        await moveTask(id, col.key);
      });
      board.appendChild(column);
    });
  }

  function renderTicket(t, colIdx){
    const el = document.createElement('div');
    el.className = 'ticket';
    el.draggable = canManageThisTask(t) || (session && t.assignee===session.id);
    el.dataset.id = t.id;
    const member = memberById(t.assignee);
    const overdue = t.endDate && t.endDate < todayStr() && t.status!=='done';
    let dots=''; for(let i=0;i<COLUMNS.length;i++){ dots += `<span class="${i<=colIdx?'done':''}"></span>`; }

    const canFwd = colIdx<COLUMNS.length-1 && canAdvance(t, colIdx);
    const canBack = colIdx>0 && canManageThisTask(t);
    const canEdit = canManageThisTask(t);

    el.innerHTML = `
      <div class="ticket-stub">
        <div class="ticket-num">#${(t.id||'').replace(/\D/g,'').slice(-3).padStart(3,'0')}</div>
        <div class="ticket-priority" style="background:${PRIORITY_COLOR[t.priority]};">${t.priority}</div>
      </div>
      <div class="ticket-body">
        ${t.taskType ? `<div class="ticket-location">${escapeHtml(t.zone||'')} · ${escapeHtml(t.project||'')}${t.building?' · '+escapeHtml(t.building):''}</div>` : ''}
        <div class="ticket-title">${escapeHtml(t.taskType || t.title)}</div>
        ${t.description? `<div class="ticket-desc">${escapeHtml(t.description)}</div>`:''}
        <div class="ticket-meta">
          <div class="ticket-assignee">${member? `<div class="avatar" style="width:18px;height:18px;font-size:8px;background:${member.color};">${initials(member.name)}</div><span>${escapeHtml(member.name)}</span>`:'<span style="color:var(--text-dim-on-paper);">Unassigned</span>'}</div>
          <div class="ticket-due ${overdue?'overdue':''}">${overdue?'⚠ ':''}${t.startDate && t.endDate ? fmtDate(t.startDate)+' → '+fmtDate(t.endDate) : 'No dates set'}</div>
        </div>
        <div class="lifecycle">${dots}</div>
        <div class="ticket-actions">
          ${colIdx>0? `<button class="tk-btn back" data-act="back" ${canBack?'':'disabled'}>◂ Back</button>`:''}
          ${colIdx<COLUMNS.length-1? `<button class="tk-btn" data-act="forward" ${canFwd?'':'disabled'}>${nextActionLabel(colIdx)}</button>`:''}
          ${canEdit? `<button class="tk-btn back" data-act="edit" style="max-width:34px;flex:0 0 34px;">✎</button>`:''}
          ${canEdit? `<button class="tk-btn back" data-act="duplicate" style="max-width:34px;flex:0 0 34px;">⧉</button>`:''}
        </div>
      </div>
    `;
    el.addEventListener('dragstart',(e)=>{ e.dataTransfer.setData('text/plain', t.id); setTimeout(()=>el.classList.add('dragging'),0); });
    el.addEventListener('dragend',()=> el.classList.remove('dragging'));
    el.querySelectorAll('[data-act]').forEach(btn=>{
      btn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        const act = btn.dataset.act;
        if(act==='forward' && canFwd) await moveTask(t.id, COLUMNS[colIdx+1].key);
        else if(act==='back' && canBack) await moveTask(t.id, COLUMNS[colIdx-1].key);
        else if(act==='edit') openTaskModal(t.id);
        else if(act==='duplicate') openDuplicateModal(t.id);
      });
    });
    return el;
  }

  function nextActionLabel(colIdx){ return (['Start ▸','Submit ▸','Approve ▸'])[colIdx] || 'Next ▸'; }

  async function moveTask(id, newStatus){
    const t = state.tasks.find(x=>x.id===id);
    const prevStatus = t ? t.status : null;
    const title = t ? t.title : 'task';
    try{
      await api('POST', `/api/tasks/${id}/move`, {status:newStatus});
      if(prevStatus && prevStatus!==newStatus){
        const colLabel = (COLUMNS.find(c=>c.key===prevStatus)||{}).label || prevStatus;
        pushUndo(`Moved "${title}" back to ${colLabel}`, async ()=>{
          await api('POST', `/api/tasks/${id}/move`, {status: prevStatus});
        });
      }
      await refreshState();
    }catch(e){ alert(e.message); }
  }

  // ---------- TASK MODAL ----------
  // Friday/Saturday are non-working days: the server is the source of truth
  // (it rejects these too), but checking here gives immediate feedback
  // instead of a round-trip error after hitting Save.
  function checkDateFieldsLive(){
    const auto = document.getElementById('fAutoSchedule').checked;
    const startEl = document.getElementById('fStartDate');
    const endEl = document.getElementById('fEndDate');
    const errEl = document.getElementById('dateFieldError');
    startEl.classList.remove('date-invalid');
    endEl.classList.remove('date-invalid');
    if(auto){ errEl.classList.remove('show'); return true; }
    let bad = false;
    if(isWeekendIso(startEl.value)){ startEl.classList.add('date-invalid'); bad = true; }
    if(isWeekendIso(endEl.value)){ endEl.classList.add('date-invalid'); bad = true; }
    errEl.classList.toggle('show', bad);
    return !bad;
  }
  function validateManualDates(){
    const auto = document.getElementById('fAutoSchedule').checked;
    if(auto) return true;
    const ok = checkDateFieldsLive();
    if(!ok){ document.getElementById('dateFieldError').classList.add('show'); }
    return ok;
  }
  document.getElementById('fStartDate').addEventListener('change', checkDateFieldsLive);
  document.getElementById('fEndDate').addEventListener('change', checkDateFieldsLive);

  function toggleAutoScheduleFields(){
    const auto = document.getElementById('fAutoSchedule').checked;
    document.getElementById('manualDatesFields').style.display = auto ? 'none' : 'block';
    document.getElementById('autoScheduleFields').style.display = auto ? 'block' : 'none';
  }
  document.getElementById('fAutoSchedule').addEventListener('change', toggleAutoScheduleFields);

  function populateInsertAfterOptions(assigneeId){
    const sel = document.getElementById('fInsertAfter');
    const queue = state.tasks
      .filter(t=>t.assignee===assigneeId && t.startDate && t.endDate)
      .sort((a,b)=>(a.sequence||0)-(b.sequence||0));
    sel.innerHTML = '<option value="">At the beginning of their queue</option>' +
      queue.map(t=>`<option value="${t.id}">After "${escapeHtml(t.title)}" (${fmtDate(t.endDate)})</option>`).join('');
  }
  document.getElementById('fAssignee').addEventListener('change', (e)=> populateInsertAfterOptions(e.target.value));

  function fillAssigneeOptions(selected){
    const sel = document.getElementById('fAssignee');
    let html = isOwner() ? '<option value="">Unassigned</option>' : '';
    state.teams.forEach(team=>{
      let members = state.members.filter(m=>m.teamId===team.id);
      if(!isOwner()) members = members.filter(m=> m.reportsTo===session.id || m.id===session.id);
      if(members.length===0) return;
      html += `<optgroup label="${escapeHtml(team.name)}">` + members.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('') + '</optgroup>';
    });
    if(!html) html = '<option value="">No one reports to you yet</option>';
    sel.innerHTML = html;
    sel.value = selected || '';
  }

  function assignableEngineers(){
    if(isOwner()) return state.members;
    return state.members.filter(m=> m.reportsTo===session.id || m.id===session.id);
  }

  function openDuplicateModal(taskId){
    modalOpenFlag = true;
    document.getElementById('dupTaskId').value = taskId;
    document.getElementById('dupSame').checked = true;
    document.getElementById('dupAllowOverlap').checked = true;
    const listEl = document.getElementById('dupEngineerList');
    const engineers = assignableEngineers();
    listEl.innerHTML = engineers.length ? engineers.map(m=>`
      <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;">
        <input type="checkbox" class="dup-eng-checkbox" value="${m.id}"> ${escapeHtml(m.name)}
      </label>
    `).join('') : '<div style="font-size:12.5px;color:var(--text-dim-on-paper);">No one available to assign to.</div>';
    listEl.style.display = 'none';
    document.getElementById('duplicateModalOverlay').classList.add('open');
  }
  function closeDuplicateModal(){
    document.getElementById('duplicateModalOverlay').classList.remove('open');
    modalOpenFlag = false;
  }
  document.getElementById('dupSame').addEventListener('change', ()=>{
    document.getElementById('dupEngineerList').style.display='none';
    document.getElementById('dupAllowOverlap').checked = true; // duplicating to the same person always overlaps the original
  });
  document.getElementById('dupSelected').addEventListener('change', ()=>{
    document.getElementById('dupEngineerList').style.display='block';
    document.getElementById('dupAllowOverlap').checked = false;
  });
  document.getElementById('cancelDuplicateBtn').addEventListener('click', closeDuplicateModal);
  document.getElementById('duplicateModalOverlay').addEventListener('click', (e)=>{ if(e.target.id==='duplicateModalOverlay') closeDuplicateModal(); });

  document.getElementById('confirmDuplicateBtn').addEventListener('click', async ()=>{
    const taskId = document.getElementById('dupTaskId').value;
    let assignees = [];
    if(document.getElementById('dupSelected').checked){
      assignees = Array.from(document.querySelectorAll('.dup-eng-checkbox:checked')).map(cb=>cb.value);
      if(assignees.length===0){ alert('Select at least one engineer.'); return; }
    }
    try{
      const created = await api('POST', `/api/tasks/${taskId}/duplicate`, {
        assignees,
        allowOverlap: document.getElementById('dupAllowOverlap').checked
      });
      if(Array.isArray(created) && created.length){
        const label = created.length===1 ? `Duplicated "${created[0].title}"` : `Duplicated to ${created.length} tasks`;
        pushUndo(label, async ()=>{
          for(const t of created) await api('DELETE', '/api/tasks/'+t.id);
        });
      }
      closeDuplicateModal();
      await refreshState();
    }catch(e){ alert(e.message); }
  });

  // ---------- TASK CATEGORIZATION (Zone / Project / Building / Task title) ----------
  // The zone→project cascade and the task-type list come from the server
  // (state.taxonomy) rather than being duplicated here, so there's one place
  // to update if the list of zones/projects ever changes.
  let taxonomyPopulated = false;
  function populateTaxonomyOptions(){
    if(taxonomyPopulated || !state.taxonomy) return;
    const zoneSel = document.getElementById('fZone');
    Object.keys(state.taxonomy.zoneProjects).forEach(zone=>{
      const opt = document.createElement('option'); opt.value = zone; opt.textContent = zone;
      zoneSel.appendChild(opt);
    });
    const typeSel = document.getElementById('fTaskType');
    state.taxonomy.taskTypes.forEach(tt=>{
      const opt = document.createElement('option'); opt.value = tt; opt.textContent = tt;
      typeSel.appendChild(opt);
    });
    taxonomyPopulated = true;
  }
  function populateProjectOptions(zone, selectedProject){
    const projectSel = document.getElementById('fProject');
    projectSel.innerHTML = '';
    const projects = (state.taxonomy && state.taxonomy.zoneProjects[zone]) || [];
    if(!zone || projects.length===0){
      projectSel.innerHTML = '<option value="">Select a zone first…</option>';
      projectSel.disabled = true;
      return;
    }
    projectSel.disabled = false;
    projectSel.innerHTML = '<option value="">Select a project…</option>' +
      projects.map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    if(selectedProject && projects.includes(selectedProject)) projectSel.value = selectedProject;
  }
  document.getElementById('fZone').addEventListener('change', (e)=>{
    populateProjectOptions(e.target.value, '');
  });
  ['fZone','fProject','fTaskType'].forEach(id=>{
    document.getElementById(id).addEventListener('change', checkTaskFieldsLive);
  });

  function checkTaskFieldsLive(){
    const zone = document.getElementById('fZone').value;
    const project = document.getElementById('fProject').value;
    const taskType = document.getElementById('fTaskType').value;
    const ok = !!(zone && project && taskType);
    document.getElementById('taskFieldsError').classList.toggle('show', false);
    return ok;
  }

  function openTaskModal(taskId){
    if(!canManageTasks()) return;
    modalOpenFlag = true;
    populateTaxonomyOptions();
    const form = document.getElementById('taskForm');
    form.reset();
    document.getElementById('taskId').value = taskId || '';
    if(taskId){
      const t = state.tasks.find(x=>x.id===taskId);
      document.getElementById('modalTitle').textContent='Edit task';
      document.getElementById('saveTaskBtn').textContent='Save changes';
      document.getElementById('deleteTaskBtn').style.display='inline';
      document.getElementById('fZone').value = t.zone || '';
      populateProjectOptions(t.zone || '', t.project || '');
      document.getElementById('fBuilding').value = t.building || '';
      document.getElementById('fTaskType').value = t.taskType || '';
      document.getElementById('fNumDrawings').value = t.numDrawings || '';
      document.getElementById('fRevisionNo').value = t.revisionNo || '';
      document.getElementById('fSheetFormat').value = t.sheetFormat || '';
      document.getElementById('fDesc').value=t.description||'';
      fillAssigneeOptions(t.assignee);
      document.getElementById('fPriority').value=t.priority;
      document.getElementById('fStartDate').value=t.startDate||'';
      document.getElementById('fEndDate').value=t.endDate||'';
      document.getElementById('fAllowOverlap').checked=false;
      document.getElementById('fAutoSchedule').checked=false;
      // Auto-schedule only applies when creating a brand new task.
      document.getElementById('autoScheduleField').style.display='none';
    } else {
      document.getElementById('modalTitle').textContent='Assign a new task';
      document.getElementById('saveTaskBtn').textContent='Assign task';
      document.getElementById('deleteTaskBtn').style.display='none';
      document.getElementById('fZone').value = '';
      populateProjectOptions('', '');
      document.getElementById('fBuilding').value = '';
      document.getElementById('fTaskType').value = '';
      document.getElementById('fNumDrawings').value = '';
      document.getElementById('fRevisionNo').value = '';
      document.getElementById('fSheetFormat').value = '';
      fillAssigneeOptions('');
      document.getElementById('fPriority').value='M';
      document.getElementById('fStartDate').value='';
      document.getElementById('fEndDate').value='';
      document.getElementById('fAllowOverlap').checked=false;
      document.getElementById('fAutoSchedule').checked=false;
      document.getElementById('autoScheduleField').style.display='block';
      populateInsertAfterOptions(document.getElementById('fAssignee').value);
    }
    toggleAutoScheduleFields();
    document.getElementById('taskFieldsError').classList.remove('show');
    document.getElementById('dateFieldError').classList.remove('show');
    document.getElementById('fStartDate').classList.remove('date-invalid');
    document.getElementById('fEndDate').classList.remove('date-invalid');
    document.getElementById('modalOverlay').classList.add('open');
  }
  function closeTaskModal(){ document.getElementById('modalOverlay').classList.remove('open'); modalOpenFlag=false; }
  document.getElementById('newTaskBtn').addEventListener('click', ()=>openTaskModal(null));
  document.getElementById('cancelModalBtn').addEventListener('click', closeTaskModal);
  document.getElementById('modalOverlay').addEventListener('click', (e)=>{ if(e.target.id==='modalOverlay') closeTaskModal(); });

  document.getElementById('taskForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    if(!canManageTasks()) return;
    const id = document.getElementById('taskId').value;
    const zone = document.getElementById('fZone').value;
    const project = document.getElementById('fProject').value;
    const building = document.getElementById('fBuilding').value.trim();
    const taskType = document.getElementById('fTaskType').value;
    if(!checkTaskFieldsLive()){
      document.getElementById('taskFieldsError').classList.add('show');
      return;
    }
    const description = document.getElementById('fDesc').value.trim();
    const assignee = document.getElementById('fAssignee').value || '';
    const priority = document.getElementById('fPriority').value;
    const numDrawings = document.getElementById('fNumDrawings').value;
    const revisionNo = document.getElementById('fRevisionNo').value.trim();
    const sheetFormat = document.getElementById('fSheetFormat').value;
    const isAuto = document.getElementById('fAutoSchedule').checked && !id;
    if(!validateManualDates()) return;
    try{
      if(id){
        const prevTask = state.tasks.find(x=>x.id===id);
        const beforeSnapshot = prevTask ? {
          zone: prevTask.zone, project: prevTask.project, building: prevTask.building, taskType: prevTask.taskType,
          description: prevTask.description, assignee: prevTask.assignee,
          priority: prevTask.priority, startDate: prevTask.startDate, endDate: prevTask.endDate,
          numDrawings: prevTask.numDrawings, revisionNo: prevTask.revisionNo, sheetFormat: prevTask.sheetFormat
        } : null;
        await api('PUT', '/api/tasks/'+id, {
          zone, project, building, taskType, description, assignee, priority,
          numDrawings, revisionNo, sheetFormat,
          startDate: document.getElementById('fStartDate').value || '',
          endDate: document.getElementById('fEndDate').value || '',
          allowOverlap: document.getElementById('fAllowOverlap').checked
        });
        if(beforeSnapshot){
          pushUndo(`Edited "${prevTask.title}"`, async ()=>{
            await api('PUT', '/api/tasks/'+id, Object.assign({}, beforeSnapshot, {allowOverlap:true}));
          });
        }
      } else if(isAuto){
        const created = await api('POST', '/api/tasks', {
          zone, project, building, taskType, description, assignee, priority,
          numDrawings, revisionNo, sheetFormat,
          mode: 'auto',
          durationDays: parseInt(document.getElementById('fDuration').value,10) || 1,
          insertAfterTaskId: document.getElementById('fInsertAfter').value || null
        });
        pushUndo(`Created "${created.title}"`, async ()=>{ await api('DELETE', '/api/tasks/'+created.id); });
      } else {
        const created = await api('POST', '/api/tasks', {
          zone, project, building, taskType, description, assignee, priority,
          numDrawings, revisionNo, sheetFormat,
          startDate: document.getElementById('fStartDate').value || '',
          endDate: document.getElementById('fEndDate').value || '',
          allowOverlap: document.getElementById('fAllowOverlap').checked
        });
        pushUndo(`Created "${created.title}"`, async ()=>{ await api('DELETE', '/api/tasks/'+created.id); });
      }
      closeTaskModal();
      await refreshState();
    }catch(e){ alert(e.message); }
  });
  document.getElementById('deleteTaskBtn').addEventListener('click', async ()=>{
    if(!canManageTasks()) return;
    const id = document.getElementById('taskId').value;
    if(!id || !confirm('Delete this task?')) return;
    const snapshot = state.tasks.find(x=>x.id===id);
    try{
      await api('DELETE', '/api/tasks/'+id);
      if(snapshot){
        const snap = JSON.parse(JSON.stringify(snapshot));
        pushUndo(`Deleted "${snap.title}"`, async ()=>{
          await api('POST', '/api/tasks/restore', {snapshot: snap});
        });
      }
      closeTaskModal();
      await refreshState();
    }catch(e){ alert(e.message); }
  });

  document.getElementById('searchBox').addEventListener('input', renderBoard);

  // ---------- GANTT ----------
  // Reuses the same task/member/team data as the board and the same
  // member/team sidebar filter — no separate backend endpoint needed.
  function ganttVisibleMembers(){
    let members = state.members;
    if(!isLeaderLike()) return members.filter(m=>m.id===session.id);
    if(filter){
      if(filter.type==='team') members = members.filter(m=>m.teamId===filter.id);
      else if(filter.type==='member') members = members.filter(m=>m.id===filter.id);
    }
    return members;
  }

  function ganttDateRange(tasks){
    if(tasks.length===0){
      const start = todayStr();
      return {start, end: addDaysIso(start, 27)};
    }
    let min = tasks[0].startDate, max = tasks[0].endDate;
    tasks.forEach(t=>{ if(t.startDate<min) min=t.startDate; if(t.endDate>max) max=t.endDate; });
    return {start: addDaysIso(min,-3), end: addDaysIso(max,3)};
  }

  function renderGanttHeader(range, dayWidth){
    let html = '';
    const rangeEndExclusive = addDaysIso(range.end,1);
    if(ganttZoom==='month'){
      let cursor = range.start;
      while(cursor < rangeEndExclusive){
        const d = parseIsoUTC(cursor);
        const monthLabel = d.toLocaleDateString('en-US',{month:'short',year:'numeric',timeZone:'UTC'});
        const firstOfNextMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth()+1, 1)).toISOString().slice(0,10);
        const segEnd = firstOfNextMonth < rangeEndExclusive ? firstOfNextMonth : rangeEndExclusive;
        const segDays = daysBetweenIso(cursor, segEnd);
        html += `<div class="gantt-head-cell" style="width:${segDays*dayWidth}px;">${monthLabel}</div>`;
        cursor = segEnd;
      }
    } else if(ganttZoom==='week'){
      let cursor = range.start;
      while(cursor < rangeEndExclusive){
        let segEnd = addDaysIso(cursor,7);
        if(segEnd > rangeEndExclusive) segEnd = rangeEndExclusive;
        const segDays = daysBetweenIso(cursor, segEnd);
        html += `<div class="gantt-head-cell" style="width:${segDays*dayWidth}px;">${fmtDate(cursor)}</div>`;
        cursor = segEnd;
      }
    } else {
      let cursor = range.start;
      while(cursor < rangeEndExclusive){
        const weekend = isWeekendIso(cursor);
        const d = parseIsoUTC(cursor);
        html += `<div class="gantt-head-cell gantt-day-cell ${weekend?'gantt-weekend':''}" style="width:${dayWidth}px;" title="${cursor}">${d.getUTCDate()}</div>`;
        cursor = addDaysIso(cursor,1);
      }
    }
    return html;
  }

  function renderGanttBar(t, range, dayWidth){
    const left = daysBetweenIso(range.start, t.startDate) * dayWidth;
    const width = Math.max(dayWidth - 4, (daysBetweenIso(t.startDate, t.endDate)+1) * dayWidth - 4);
    const overdue = t.endDate < todayStr() && t.status!=='done';
    const label = `${t.title} (${fmtDate(t.startDate)}–${fmtDate(t.endDate)})`;
    return `<div class="gantt-bar status-${t.status} ${overdue?'overdue':''}" draggable="true" data-task-id="${t.id}" data-start="${t.startDate}" data-end="${t.endDate}" style="left:${left}px;width:${width}px;" title="${escapeHtml(label)}">${escapeHtml(t.title)}</div>`;
  }

  function renderGantt(){
    const el = document.getElementById('ganttView');
    const dayWidth = GANTT_DAY_WIDTH[ganttZoom];
    const allVisible = visibleTasks();
    const tasks = allVisible.filter(t=>t.startDate && t.endDate);
    const unscheduledCount = allVisible.length - tasks.length;
    const range = ganttDateRange(tasks);
    const totalDays = daysBetweenIso(range.start, range.end) + 1;
    const totalWidth = totalDays * dayWidth;
    const members = ganttVisibleMembers();

    let rowMeta = [];
    if(ganttGroupBy==='team'){
      const teams = (filter && filter.type==='team') ? state.teams.filter(t=>t.id===filter.id) : state.teams;
      teams.forEach(team=>{
        const teamMembers = members.filter(m=>m.teamId===team.id);
        if(teamMembers.length===0) return;
        rowMeta.push({type:'team', team});
        teamMembers.forEach(m=> rowMeta.push({type:'member', member:m}));
      });
    } else {
      members.forEach(m=> rowMeta.push({type:'member', member:m}));
    }

    const labelsHtml = rowMeta.map(row=>{
      if(row.type==='team') return `<div class="gantt-team-label">${escapeHtml(row.team.name)}</div>`;
      const m = row.member;
      return `<div class="gantt-row-label"><div class="avatar" style="width:20px;height:20px;font-size:9px;background:${m.color};">${initials(m.name)}</div>${escapeHtml(m.name)}</div>`;
    }).join('');

    let stripesHtml = '';
    let cursor = range.start;
    for(let i=0;i<totalDays;i++){
      if(isWeekendIso(cursor)) stripesHtml += `<div class="gantt-weekend-stripe" style="left:${i*dayWidth}px;width:${dayWidth}px;top:44px;bottom:0;"></div>`;
      cursor = addDaysIso(cursor,1);
    }
    const today = todayStr();
    const todayHtml = (today>=range.start && today<=range.end)
      ? `<div class="gantt-today-line" style="left:${daysBetweenIso(range.start,today)*dayWidth}px;"></div>` : '';

    const headerHtml = renderGanttHeader(range, dayWidth);

    const tracksHtml = rowMeta.map(row=>{
      if(row.type==='team') return `<div class="gantt-team-row"></div>`;
      const m = row.member;
      const bars = tasks.filter(t=>t.assignee===m.id).map(t=>renderGanttBar(t, range, dayWidth)).join('');
      return `<div class="gantt-row-track" data-member-id="${m.id}">${bars}</div>`;
    }).join('');

    el.innerHTML = `
      <div class="gantt-toolbar">
        <div class="gantt-toggle-group">
          <button class="gantt-toggle-btn ${ganttGroupBy==='engineer'?'active':''}" id="ganttByEngineerBtn">By engineer</button>
          <button class="gantt-toggle-btn ${ganttGroupBy==='team'?'active':''}" id="ganttByTeamBtn">By team</button>
        </div>
        <div class="gantt-toggle-group">
          <button class="gantt-toggle-btn ${ganttZoom==='day'?'active':''}" id="ganttZoomDayBtn">Day</button>
          <button class="gantt-toggle-btn ${ganttZoom==='week'?'active':''}" id="ganttZoomWeekBtn">Week</button>
          <button class="gantt-toggle-btn ${ganttZoom==='month'?'active':''}" id="ganttZoomMonthBtn">Month</button>
        </div>
        <div class="gantt-legend">
          <span><span class="gantt-legend-dot" style="background:#B9C2CE;"></span>To do</span>
          <span><span class="gantt-legend-dot" style="background:var(--amber);"></span>In progress</span>
          <span><span class="gantt-legend-dot" style="background:var(--teal);"></span>Submitted</span>
          <span><span class="gantt-legend-dot" style="background:#8FB588;"></span>Done</span>
          <span><span class="gantt-legend-dot overdue-dot"></span>Overdue</span>
        </div>
      </div>
      ${unscheduledCount>0 ? `<div class="gantt-note">${unscheduledCount} task${unscheduledCount===1?'':'s'} without a start/end date aren't shown here — set dates on them to see them on the timeline.</div>` : ''}
      <div class="gantt-body">
        <div class="gantt-labels">
          <div class="gantt-label-header">${ganttGroupBy==='team'?'Team / Engineer':'Engineer'}</div>
          ${labelsHtml}
        </div>
        <div class="gantt-timeline-scroll" id="ganttScroll">
          <div class="gantt-grid" style="width:${totalWidth}px;">
            <div class="gantt-header-row">${headerHtml}</div>
            ${stripesHtml}
            ${todayHtml}
            ${tracksHtml}
          </div>
        </div>
      </div>
    `;

    if(rowMeta.length===0){
      el.querySelector('.gantt-body').innerHTML = '<div class="gantt-empty">No one to show on the timeline yet.</div>';
    }

    document.getElementById('ganttByEngineerBtn').addEventListener('click', ()=>{ ganttGroupBy='engineer'; renderGantt(); });
    document.getElementById('ganttByTeamBtn').addEventListener('click', ()=>{ ganttGroupBy='team'; renderGantt(); });
    document.getElementById('ganttZoomDayBtn').addEventListener('click', ()=>{ ganttZoom='day'; renderGantt(); });
    document.getElementById('ganttZoomWeekBtn').addEventListener('click', ()=>{ ganttZoom='week'; renderGantt(); });
    document.getElementById('ganttZoomMonthBtn').addEventListener('click', ()=>{ ganttZoom='month'; renderGantt(); });

    const scrollEl = document.getElementById('ganttScroll');
    const labelsEl = el.querySelector('.gantt-labels');
    if(scrollEl && labelsEl){
      scrollEl.addEventListener('scroll', ()=>{ labelsEl.scrollTop = scrollEl.scrollTop; });
    }

    wireGanttDragScaffold();
    renderGanttDependencyLines();
  }

  // Dependencies aren't modeled yet (no `dependsOn` field on tasks), so this
  // is a deliberate no-op today. When that field exists, draw connector
  // lines here between a task's bar and the bars of the tasks it depends on
  // — the DOM already gives each bar a stable `data-task-id` and inline
  // left/width/top to compute endpoints from.
  function renderGanttDependencyLines(){ /* future work — see comment above */ }

  // Drag-and-drop-ready scaffold: bars are draggable and rows are drop
  // targets already, but a drop only computes and logs the target date
  // rather than actually rescheduling — real rescheduling should reuse the
  // task modal's PUT /api/tasks/:id call (with its overlap + weekend
  // checks) instead of writing a second code path here.
  function wireGanttDragScaffold(){
    document.querySelectorAll('.gantt-bar').forEach(bar=>{
      bar.addEventListener('dragstart', (e)=>{
        bar.classList.add('drag-ghost');
        e.dataTransfer.setData('text/plain', bar.dataset.taskId);
      });
      bar.addEventListener('dragend', ()=> bar.classList.remove('drag-ghost'));
    });
    document.querySelectorAll('.gantt-row-track').forEach(track=>{
      track.addEventListener('dragover', (e)=>{ e.preventDefault(); track.classList.add('drop-target'); });
      track.addEventListener('dragleave', ()=> track.classList.remove('drop-target'));
      track.addEventListener('drop', (e)=>{
        e.preventDefault();
        track.classList.remove('drop-target');
        const id = e.dataTransfer.getData('text/plain');
        if(!id) return;
        const dayWidth = GANTT_DAY_WIDTH[ganttZoom];
        const rect = track.getBoundingClientRect();
        const dropDayOffset = Math.round((e.clientX - rect.left) / dayWidth);
        console.log(`[Gantt drag scaffold] task ${id} dropped ~${dropDayOffset} day(s) into this row — hook this up to PUT /api/tasks/${id} to actually reschedule it.`);
      });
    });
  }

  // ---------- RECOGNITION & ACHIEVEMENTS ----------
  // Server sends this member's stats/Click Score/achievement history as
  // `state.me` on every /api/state read (see server.js). The only thing
  // this client needs to manage itself is: (a) showing the one-time
  // celebration when `state.me.pendingCelebration` is set, and (b)
  // rendering the "My Stats" panel on demand. Nothing here decides *whether*
  // an achievement was earned — that's entirely server-side, so reloading
  // the page or polling never re-triggers a celebration that's already been
  // marked seen.
  let celebrationActive = false;

  function maybeShowCelebration(){
    if(celebrationActive) return;
    const c = state.me && state.me.pendingCelebration;
    if(!c) return;
    celebrationActive = true;
    showCelebration(c);
  }

  function showCelebration(c){
    document.getElementById('celebrationIcon').textContent = c.icon;
    document.getElementById('celebrationTitle').textContent = c.title;
    const name = (session && session.name) ? session.name.split(/\s+/)[0] : 'there';
    document.getElementById('celebrationMessage').textContent =
      `Great job, ${name}! You completed all of your assigned tasks on time. Keep up the excellent work!`;
    const overlay = document.getElementById('celebrationOverlay');
    overlay.classList.add('open');
    const stopConfetti = launchConfetti(document.getElementById('celebrationCanvas'));
    const continueBtn = document.getElementById('celebrationContinueBtn');
    const onContinue = async () => {
      continueBtn.removeEventListener('click', onContinue);
      overlay.classList.remove('open');
      stopConfetti();
      celebrationActive = false;
      try{ await api('POST', `/api/achievements/${c.id}/seen`); }catch(e){ /* best-effort — worst case it's re-marked seen next load */ }
    };
    continueBtn.addEventListener('click', onContinue);
  }

  // Lightweight canvas confetti — a fixed, small particle count, plain
  // fillRect/arc draws, and a hard stop after ~4s (it cancels its own
  // animation frame and clears the canvas rather than looping forever), so
  // this never becomes a background performance drain.
  function launchConfetti(canvas){
    const ctx = canvas.getContext('2d');
    function resize(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    resize();
    window.addEventListener('resize', resize);
    const colors = ['#E2892B','#3E7C74','#BD5238','#7C6AA6','#F6F1E4','#4C7EA8'];
    const PARTICLE_COUNT = 90;
    const DURATION_MS = 4000;
    const particles = [];
    for(let i=0;i<PARTICLE_COUNT;i++){
      particles.push({
        x: Math.random()*canvas.width,
        y: -20 - Math.random()*canvas.height*0.4,
        vx: (Math.random()-0.5)*2.2,
        vy: 2.5 + Math.random()*3,
        size: 4 + Math.random()*5,
        color: colors[Math.floor(Math.random()*colors.length)],
        rotation: Math.random()*360,
        vr: (Math.random()-0.5)*12,
        round: Math.random() > 0.5
      });
    }
    let start = null, rafId = null;
    function frame(ts){
      if(start === null) start = ts;
      const elapsed = ts - start;
      ctx.clearRect(0,0,canvas.width,canvas.height);
      particles.forEach(p=>{
        p.x += p.vx; p.y += p.vy; p.vy += 0.02; p.rotation += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation * Math.PI/180);
        ctx.fillStyle = p.color;
        if(p.round){ ctx.beginPath(); ctx.arc(0,0,p.size/2,0,Math.PI*2); ctx.fill(); }
        else{ ctx.fillRect(-p.size/2, -p.size/2, p.size, p.size*0.6); }
        ctx.restore();
      });
      if(elapsed < DURATION_MS){
        rafId = requestAnimationFrame(frame);
      }else{
        ctx.clearRect(0,0,canvas.width,canvas.height);
      }
    }
    rafId = requestAnimationFrame(frame);
    return function stop(){
      if(rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
      ctx.clearRect(0,0,canvas.width,canvas.height);
    };
  }

  // ---------- My Stats panel ----------
  function renderStatsModal(){
    const me = state.me;
    const body = document.getElementById('statsModalBody');
    if(!me){
      body.innerHTML = `<p style="font-size:13px;color:var(--text-dim-on-paper);">Stats aren't available yet — try again after your next task update.</p>`;
      return;
    }
    const { stats, clickScore, achievements } = me;
    const starsFilled = '★'.repeat(clickScore.stars);
    const starsEmpty = '☆'.repeat(5 - clickScore.stars);
    const eva = stats.eva;
    const evaLabel = eva.actualDays > 0 ? `${eva.efficiencyPct}%` : '—';

    const achvHtml = achievements.length
      ? achievements.map(a => `
          <div class="achv-row">
            <span class="achv-icon">${a.icon}</span>
            <span class="achv-title">${escapeHtml(a.title)}</span>
            <span class="achv-date">${fmtDate((a.earnedAt||'').slice(0,10))}</span>
          </div>`).join('')
      : `<div class="achv-empty">No milestones yet — they'll show up here as you complete work.</div>`;

    body.innerHTML = `
      <div class="click-score-block">
        <div>
          <div class="click-score-num">${clickScore.score}<span> / 100</span></div>
          <div class="click-score-stars">${starsFilled}${starsEmpty}</div>
          <div class="click-score-rating">${escapeHtml(clickScore.rating)}</div>
        </div>
        <div style="margin-left:auto;font-size:11px;color:var(--text-dim-on-paper);line-height:1.7;font-family:'IBM Plex Mono',monospace;">
          On-time ${clickScore.breakdown.onTime}% · Est. vs actual ${clickScore.breakdown.eva}%<br>
          No overdue ${clickScore.breakdown.noOverdue}% · Consistency ${clickScore.breakdown.consistency}%
        </div>
      </div>
      <div class="stats-section-label">This month</div>
      <div class="stats-grid">
        <div class="stat-box"><div class="num">${stats.completedThisMonth}</div><div class="lbl">Completed</div></div>
        <div class="stat-box"><div class="num">${stats.onTimeRate}%</div><div class="lbl">On-time rate</div></div>
        <div class="stat-box"><div class="num">${stats.currentStreak}</div><div class="lbl">Day streak</div></div>
        <div class="stat-box"><div class="num">${stats.overdueCount}</div><div class="lbl">Overdue now</div></div>
        <div class="stat-box"><div class="num">${stats.avgCompletionDays ?? '—'}</div><div class="lbl">Avg. days/task</div></div>
        <div class="stat-box"><div class="num">${evaLabel}</div><div class="lbl">Est. vs actual</div></div>
      </div>
      <div class="stats-section-label">Milestones</div>
      <div class="achv-list">${achvHtml}</div>
    `;
  }

  document.getElementById('myStatsBtn').addEventListener('click', ()=>{
    renderStatsModal();
    document.getElementById('statsModalOverlay').classList.add('open');
  });
  document.getElementById('closeStatsBtn').addEventListener('click', ()=>{
    document.getElementById('statsModalOverlay').classList.remove('open');
  });

  // ---------- DASHBOARD ----------
  function memberStats(memberId, pool){
    const tasks = pool.filter(t=>t.assignee===memberId);
    const completed = tasks.filter(t=>t.status==='done');
    const onTime = completed.filter(t=> !t.due || (t.completedAt && t.completedAt<=t.due));
    return {total:tasks.length, completed:completed.length, onTime:onTime.length, open:tasks.length-completed.length};
  }

  function diffDaysInclusiveLocal(startStr, endStr){
    const s = parseIsoUTC(startStr), e = parseIsoUTC(endStr);
    return Math.round((e-s)/86400000)+1;
  }

  function getActualStartDate(t){
    const hist = (t.history||[]).find(h=>h.status==='inprogress');
    return (hist && hist.at) || t.startDate || t.createdAt || null;
  }

  function computeEstimatedVsActual(tasks, filters){
    const rows = tasks.filter(t=>{
      if(t.status!=='done') return false;
      if(!t.startDate || !t.endDate || !t.completedAt) return false;
      if(filters.engineer && t.assignee!==filters.engineer) return false;
      if(filters.team){
        const m = memberById(t.assignee);
        if(!m || m.teamId!==filters.team) return false;
      }
      if(filters.from && t.completedAt < filters.from) return false;
      if(filters.to && t.completedAt > filters.to) return false;
      return true;
    });
    let estTotal=0, actTotal=0;
    rows.forEach(t=>{
      const est = diffDaysInclusiveLocal(t.startDate, t.endDate);
      const actualStart = getActualStartDate(t);
      const act = actualStart ? diffDaysInclusiveLocal(actualStart, t.completedAt) : est;
      estTotal += est; actTotal += act;
    });
    const diff = actTotal - estTotal;
    const efficiency = actTotal>0 ? Math.round((estTotal/actTotal)*100) : 100;
    return {count: rows.length, estTotal, actTotal, diff, efficiency};
  }

  function renderEstimatedVsActualCard(pool){
    const stats = computeEstimatedVsActual(pool, evaFilters);
    const engineerOptions = isLeaderLike()
      ? (isOwner() ? state.members : state.members.filter(m=>m.reportsTo===session.id || m.id===session.id))
      : [];
    const filterRow = isLeaderLike() ? `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <select id="evaEngineerFilter" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
          <option value="">All engineers</option>
          ${engineerOptions.map(m=>`<option value="${m.id}" ${evaFilters.engineer===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
        <select id="evaTeamFilter" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
          <option value="">All teams</option>
          ${state.teams.map(t=>`<option value="${t.id}" ${evaFilters.team===t.id?'selected':''}>${escapeHtml(t.name)}</option>`).join('')}
        </select>
        <input type="date" id="evaFromDate" value="${evaFilters.from}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
        <input type="date" id="evaToDate" value="${evaFilters.to}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
      </div>
    ` : `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <input type="date" id="evaFromDate" value="${evaFilters.from}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
        <input type="date" id="evaToDate" value="${evaFilters.to}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
      </div>
    `;
    return `
      <div class="dash-card">
        <h3>Estimated vs Actual (${stats.count} completed task${stats.count===1?'':'s'})</h3>
        ${filterRow}
        <div class="dash-stats-row">
          <div class="dash-stat"><div class="num">${stats.estTotal}</div><div class="lbl">Estimated days</div></div>
          <div class="dash-stat"><div class="num">${stats.actTotal}</div><div class="lbl">Actual days</div></div>
          <div class="dash-stat"><div class="num">${stats.diff>=0?'+':''}${stats.diff}</div><div class="lbl">Difference</div></div>
          <div class="dash-stat"><div class="num">${stats.efficiency}%</div><div class="lbl">Efficiency</div></div>
        </div>
      </div>
    `;
  }

  function wireEstimatedVsActualFilters(){
    const eng = document.getElementById('evaEngineerFilter');
    const team = document.getElementById('evaTeamFilter');
    const from = document.getElementById('evaFromDate');
    const to = document.getElementById('evaToDate');
    if(eng) eng.addEventListener('change', ()=>{ evaFilters.engineer = eng.value; renderDashboard(); });
    if(team) team.addEventListener('change', ()=>{ evaFilters.team = team.value; renderDashboard(); });
    if(from) from.addEventListener('change', ()=>{ evaFilters.from = from.value; renderDashboard(); });
    if(to) to.addEventListener('change', ()=>{ evaFilters.to = to.value; renderDashboard(); });
  }

  function renderDashboard(){
    const el = document.getElementById('dashboardView');
    if(isLeaderLike()){
      const pool = state.dashboardTasks || state.tasks;
      const visibleMembers = isOwner() ? state.members : state.members.filter(m=>m.reportsTo===session.id || m.id===session.id);
      let rows = visibleMembers.map(m=>{
        const s = memberStats(m.id, pool);
        const pct = s.completed>0 ? Math.round((s.onTime/s.completed)*100) : 0;
        const team = teamById(m.teamId);
        return `<tr>
          <td>${escapeHtml(m.name)}${m.isTeamLead?' <span class="lead-tag">LEAD</span>':''}</td>
          <td>${escapeHtml(team?team.name:'—')}</td>
          <td>${s.total}</td><td>${s.open}</td><td>${s.completed}</td>
          <td><div style="display:flex;align-items:center;gap:8px;"><div class="bar-track"><div class="bar-fill" style="width:${pct}%;"></div></div><span>${pct}%</span></div></td>
        </tr>`;
      }).join('');
      el.innerHTML = `
        <div class="dash-card">
          <h3>Team performance</h3>
          <table class="dash-table">
            <thead><tr><th>Name</th><th>Team</th><th>Assigned</th><th>Open</th><th>Completed</th><th>On-time rate</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6">No members yet</td></tr>'}</tbody>
          </table>
        </div>
        ${renderEstimatedVsActualCard(pool)}
      `;
      wireEstimatedVsActualFilters();
    } else {
      const pool = state.dashboardTasks || state.tasks;
      const s = memberStats(session.id, pool);
      const pct = s.completed>0 ? Math.round((s.onTime/s.completed)*100) : 0;
      el.innerHTML = `
        <div class="dash-card">
          <h3>Your performance</h3>
          <div class="dash-stats-row">
            <div class="dash-stat"><div class="num">${s.total}</div><div class="lbl">Assigned</div></div>
            <div class="dash-stat"><div class="num">${s.open}</div><div class="lbl">Open</div></div>
            <div class="dash-stat"><div class="num">${s.completed}</div><div class="lbl">Completed</div></div>
            <div class="dash-stat"><div class="num">${s.onTime}</div><div class="lbl">On time</div></div>
          </div>
          <div style="margin-top:16px;display:flex;align-items:center;gap:10px;">
            <div class="bar-track" style="width:200px;"><div class="bar-fill" style="width:${pct}%;"></div></div>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-dim-on-ink);">${pct}% on-time completion</span>
          </div>
        </div>
        ${renderEstimatedVsActualCard(pool)}
      `;
      wireEstimatedVsActualFilters();
    }
  }

  let capacityLoaded = false;
  async function loadAndRenderCapacity(){
    const el = document.getElementById('capacityView');
    // Only show the loading placeholder the first time — this gets called
    // again every ~8s by the regular poll while this tab is open, and
    // wiping the whole panel back to "Loading…" each time (even though
    // nothing changed) was the visible flicker/glitch here. Subsequent
    // refreshes now update the list quietly in place.
    if(!capacityLoaded) el.innerHTML = '<div class="notif-empty">Loading…</div>';
    try{
      const data = await api('GET', '/api/capacity');
      capacityData = data.capacity || [];
      capacityLoaded = true;
      renderCapacityList();
    }catch(e){
      if(!capacityLoaded) el.innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`;
    }
  }

  function renderCapacityList(){
    const el = document.getElementById('capacityView');
    let rows = capacityData.slice();
    if(capacitySortMode==='availability'){
      rows.sort((a,b)=> a.nextAvailable < b.nextAvailable ? -1 : a.nextAvailable > b.nextAvailable ? 1 : 0);
    } else {
      rows.sort((a,b)=> b.capacityPct - a.capacityPct);
    }
    const today = todayStr();
    const rowsHtml = rows.map(m=>{
      const daysUntilFree = Math.max(0, Math.round((parseIsoUTC(m.nextAvailable) - parseIsoUTC(today)) / 86400000));
      const availLabel = daysUntilFree<=0 ? 'Available now' : `Available in ${daysUntilFree} day${daysUntilFree===1?'':'s'}`;
      return `
        <div class="capacity-row">
          <div class="capacity-name">${escapeHtml(m.name)}</div>
          <div class="capacity-bar-track bar-track"><div class="bar-fill" style="width:${m.capacityPct}%;"></div></div>
          <div class="capacity-pct-label">${m.capacityPct}%</div>
          <div class="capacity-avail">${availLabel}</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim-on-ink);">${m.totalAssigned} open · ${m.occupiedDays}d scheduled</div>
        </div>
      `;
    }).join('');
    el.innerHTML = `
      <div class="dash-card">
        <h3>Team capacity</h3>
        <div class="sort-toggle">
          <button class="mini-btn ${capacitySortMode==='availability'?'primary':''}" id="sortByAvailBtn">Sort by availability</button>
          <button class="mini-btn ${capacitySortMode==='capacity'?'primary':''}" id="sortByCapBtn">Sort by capacity %</button>
        </div>
        ${rowsHtml || '<div class="notif-empty">No one to show yet.</div>'}
      </div>
    `;
    document.getElementById('sortByAvailBtn').addEventListener('click', ()=>{ capacitySortMode='availability'; renderCapacityList(); });
    document.getElementById('sortByCapBtn').addEventListener('click', ()=>{ capacitySortMode='capacity'; renderCapacityList(); });
  }

  // ---------- LOG TAB (productivity + project progress) ----------
  // Fetched lazily, only while this tab is open — same pattern as Capacity —
  // so it adds no load to the regular board polling. WorkDays/ProjectTargets
  // are owner-entered and small, so re-fetching them on each ~8s poll while
  // the tab is open is cheap; the completed-tasks log itself reuses
  // state.dashboardTasks (already fetched for the Dashboard tab) instead of
  // hitting the sheet again.
  let logLoaded = false;
  let logWorkdays = [];
  let logTargets = [];
  let logFilters = { engineer:'', zone:'', project:'', from:'', to:'' };
  let logMonth = (()=>{ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0'); })();

  async function loadAndRenderLog(){
    const el = document.getElementById('logView');
    if(!logLoaded) el.innerHTML = '<div class="notif-empty">Loading…</div>';
    try{
      const [wd, pt] = await Promise.all([ api('GET','/api/workdays'), api('GET','/api/project-targets') ]);
      logWorkdays = wd.workdays || [];
      logTargets = pt.targets || [];
      logLoaded = true;
      renderLogView();
    }catch(e){
      if(!logLoaded) el.innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`;
    }
  }

  function doneTasksPool(){ return (state.dashboardTasks || state.tasks).filter(t=>t.status==='done'); }

  function filteredLogRows(){
    return doneTasksPool().filter(t=>{
      if(logFilters.engineer && t.assignee!==logFilters.engineer) return false;
      if(logFilters.zone && t.zone!==logFilters.zone) return false;
      if(logFilters.project && t.project!==logFilters.project) return false;
      if(logFilters.from && t.completedAt < logFilters.from) return false;
      if(logFilters.to && t.completedAt > logFilters.to) return false;
      return true;
    }).sort((a,b)=> (b.completedAt||'').localeCompare(a.completedAt||''));
  }

  function renderLogTable(){
    const rows = filteredLogRows();
    const zones = Object.keys((state.taxonomy && state.taxonomy.zoneProjects) || {});
    const filterRow = isLeaderLike() ? `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <select id="logEngineerFilter" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
          <option value="">All engineers</option>
          ${productivityVisibleMembers().map(m=>`<option value="${m.id}" ${logFilters.engineer===m.id?'selected':''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
        <select id="logZoneFilter" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
          <option value="">All zones</option>
          ${zones.map(z=>`<option value="${escapeHtml(z)}" ${logFilters.zone===z?'selected':''}>${escapeHtml(z)}</option>`).join('')}
        </select>
        <select id="logProjectFilter" ${logFilters.zone?'':'disabled'} style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
          <option value="">${logFilters.zone?'All projects':'Select a zone first…'}</option>
          ${logFilters.zone ? (state.taxonomy.zoneProjects[logFilters.zone]||[]).map(p=>`<option value="${escapeHtml(p)}" ${logFilters.project===p?'selected':''}>${escapeHtml(p)}</option>`).join('') : ''}
        </select>
        <input type="date" id="logFromDate" value="${logFilters.from}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
        <input type="date" id="logToDate" value="${logFilters.to}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
      </div>
    ` : `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
        <input type="date" id="logFromDate" value="${logFilters.from}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
        <input type="date" id="logToDate" value="${logFilters.to}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
      </div>
    `;
    const tableRows = rows.map(t=>{
      const m = memberById(t.assignee);
      return `<tr>
        <td>${fmtDate(t.completedAt)}</td>
        <td>${escapeHtml(m?m.name:'—')}</td>
        <td>${escapeHtml(t.zone||'—')}</td>
        <td>${escapeHtml(t.project||'—')}</td>
        <td>${escapeHtml(t.building||'—')}</td>
        <td>${escapeHtml(t.taskType||'—')}</td>
        <td>${t.numDrawings||0}</td>
        <td>${escapeHtml(t.revisionNo||'—')}</td>
        <td>${escapeHtml(t.sheetFormat||'—')}</td>
      </tr>`;
    }).join('');
    return `
      <div class="dash-card">
        <h3>Completed Tasks Log (${rows.length})</h3>
        ${filterRow}
        <div style="overflow-x:auto;">
          <table class="dash-table">
            <thead><tr><th>Completed</th><th>Engineer</th><th>Zone</th><th>Project</th><th>Building</th><th>Task Type</th><th>Drawings</th><th>Rev.</th><th>Format</th></tr></thead>
            <tbody>${tableRows || '<tr><td colspan="9">No completed tasks match these filters.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // Owner/viewer see everyone; a team leader sees their own team; a plain
  // member sees just themselves — same scoping rule used elsewhere.
  function productivityVisibleMembers(){
    if(isOwner() || isViewer()) return state.members.filter(m=>!m.isViewer);
    if(isTeamLead()) return state.members.filter(m=> !m.isViewer && (m.reportsTo===session.id || m.id===session.id));
    return state.members.filter(m=>m.id===session.id);
  }

  function computeProductivity(memberId, month){
    const drawings = doneTasksPool().filter(t=> t.assignee===memberId && (t.completedAt||'').slice(0,7)===month)
      .reduce((sum,t)=> sum + (parseInt(t.numDrawings,10)||0), 0);
    const wd = logWorkdays.find(w=>w.memberId===memberId && w.month===month);
    const days = wd ? (parseInt(wd.days,10)||0) : 0;
    const rate = days>0 ? Math.round((drawings/days)*100)/100 : null;
    return {drawings, days, rate};
  }

  function renderProductivitySection(){
    const members = productivityVisibleMembers();
    let rows = members.map(m=> ({member:m, ...computeProductivity(m.id, logMonth)}));
    rows.sort((a,b)=> (b.rate??-1) - (a.rate??-1));
    const cardsHtml = rows.map((r,i)=>{
      const daysField = isOwner()
        ? `<input type="number" min="0" class="wd-input" data-member="${r.member.id}" value="${r.days}">`
        : `<span>${r.days}</span>`;
      return `
      <div class="prod-card">
        <div class="prod-rank">#${i+1}</div>
        <div class="prod-name">${escapeHtml(r.member.name)}</div>
        <div class="prod-rate">${r.rate!==null ? r.rate : '—'}</div>
        <div class="prod-rate-lbl">drawings / day</div>
        <div class="prod-row"><span>Drawings this month</span><span>${r.drawings}</span></div>
        <div class="prod-row"><span>Work days</span>${daysField}</div>
      </div>`;
    }).join('');
    return `
      <div class="dash-card">
        <h3>Engineer Productivity</h3>
        <div style="margin-bottom:14px;">
          <input type="month" id="logMonthPicker" value="${logMonth}" style="padding:6px 8px;border-radius:3px;border:1px solid var(--line-on-ink);background:var(--ink);color:var(--text-on-ink);font-size:12px;">
          ${isOwner() ? '<span style="margin-left:10px;font-size:11px;color:var(--text-dim-on-ink);">Enter each engineer\'s work days for the selected month to compute their rate.</span>' : ''}
        </div>
        <div class="prod-grid">${cardsHtml || '<div class="notif-empty">No engineers to show.</div>'}</div>
      </div>
    `;
  }

  function computeProjectProgress(zone, project){
    const completed = doneTasksPool().filter(t=>t.zone===zone && t.project===project)
      .reduce((sum,t)=> sum + (parseInt(t.numDrawings,10)||0), 0);
    const targetRow = logTargets.find(t=>t.zone===zone && t.project===project);
    const target = targetRow ? (parseInt(targetRow.targetDrawings,10)||0) : 0;
    const pct = target>0 ? Math.min(100, Math.round((completed/target)*100)) : 0;
    return {completed, target, pct};
  }

  function renderProjectProgressSection(){
    const zoneProjects = (state.taxonomy && state.taxonomy.zoneProjects) || {};
    const cards = [];
    Object.keys(zoneProjects).forEach(zone=>{
      zoneProjects[zone].forEach(project=>{
        const p = computeProjectProgress(zone, project);
        if(!isOwner() && p.target===0 && p.completed===0) return; // hide untouched projects for non-owners
        const targetField = isOwner()
          ? `<input type="number" min="0" class="target-input" data-zone="${escapeHtml(zone)}" data-project="${escapeHtml(project)}" value="${p.target}">`
          : `<span>${p.target || '—'}</span>`;
        cards.push(`
          <div class="prog-card">
            <div class="prog-zone">${escapeHtml(zone)}</div>
            <div class="prog-name">${escapeHtml(project)}</div>
            <div class="bar-track" style="width:100%;"><div class="bar-fill" style="width:${p.pct}%;"></div></div>
            <div class="prog-stats" style="margin-top:10px;">
              <span>${p.completed} done</span>
              <span>Target: ${targetField}</span>
              <span>${p.pct}%</span>
            </div>
          </div>
        `);
      });
    });
    return `
      <div class="dash-card">
        <h3>Project Progress</h3>
        <div class="prog-grid">${cards.join('') || '<div class="notif-empty">No projects to show yet.</div>'}</div>
      </div>
    `;
  }

  function wireLogInteractions(){
    const eng = document.getElementById('logEngineerFilter');
    const zone = document.getElementById('logZoneFilter');
    const project = document.getElementById('logProjectFilter');
    const from = document.getElementById('logFromDate');
    const to = document.getElementById('logToDate');
    if(eng) eng.addEventListener('change', ()=>{ logFilters.engineer=eng.value; renderLogView(); });
    if(zone) zone.addEventListener('change', ()=>{ logFilters.zone=zone.value; logFilters.project=''; renderLogView(); });
    if(project) project.addEventListener('change', ()=>{ logFilters.project=project.value; renderLogView(); });
    if(from) from.addEventListener('change', ()=>{ logFilters.from=from.value; renderLogView(); });
    if(to) to.addEventListener('change', ()=>{ logFilters.to=to.value; renderLogView(); });

    const monthPicker = document.getElementById('logMonthPicker');
    if(monthPicker) monthPicker.addEventListener('change', ()=>{ logMonth = monthPicker.value; renderLogView(); });

    document.querySelectorAll('.wd-input').forEach(inp=>{
      inp.addEventListener('change', async ()=>{
        const memberId = inp.dataset.member;
        const days = parseInt(inp.value,10)||0;
        try{
          await api('POST','/api/workdays',{memberId, month: logMonth, days});
          const existing = logWorkdays.find(w=>w.memberId===memberId && w.month===logMonth);
          if(existing) existing.days = days; else logWorkdays.push({memberId, month: logMonth, days});
          renderLogView();
        }catch(e){ alert(e.message); }
      });
    });

    document.querySelectorAll('.target-input').forEach(inp=>{
      inp.addEventListener('change', async ()=>{
        const zoneVal = inp.dataset.zone, projectVal = inp.dataset.project;
        const targetDrawings = parseInt(inp.value,10)||0;
        try{
          await api('POST','/api/project-targets',{zone: zoneVal, project: projectVal, targetDrawings});
          const existing = logTargets.find(t=>t.zone===zoneVal && t.project===projectVal);
          if(existing) existing.targetDrawings = targetDrawings; else logTargets.push({zone: zoneVal, project: projectVal, targetDrawings});
          renderLogView();
        }catch(e){ alert(e.message); }
      });
    });
  }

  function renderLogView(){
    const el = document.getElementById('logView');
    el.innerHTML = renderLogTable() + renderProductivitySection() + renderProjectProgressSection();
    wireLogInteractions();
  }

  function doExport(){
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `click-snapshot-${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  boot();
})();
