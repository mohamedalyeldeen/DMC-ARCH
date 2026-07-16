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

  function todayStr(){ return new Date().toISOString().slice(0,10); }
  function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso+'T00:00:00'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
  function escapeHtml(str){ const d=document.createElement('div'); d.textContent = str==null?'':String(str); return d.innerHTML; }
  function initials(name){ return (name||'').trim().split(/\s+/).map(w=>w[0]).slice(0,2).join('').toUpperCase(); }

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

  document.getElementById('ownerTabBtn').addEventListener('click', ()=>{
    document.getElementById('ownerTabBtn').classList.add('active');
    document.getElementById('memberTabBtn').classList.remove('active');
    document.getElementById('ownerLoginForm').style.display='block';
    document.getElementById('memberLoginForm').style.display='none';
  });
  document.getElementById('memberTabBtn').addEventListener('click', ()=>{
    document.getElementById('memberTabBtn').classList.add('active');
    document.getElementById('ownerTabBtn').classList.remove('active');
    document.getElementById('memberLoginForm').style.display='block';
    document.getElementById('ownerLoginForm').style.display='none';
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

  async function enterApp(){
    document.getElementById('authOverlay').classList.remove('open');
    document.getElementById('appShell').style.display = 'flex';
    activeTab = 'board';
    await refreshState();
    pollTimer = setInterval(()=>{ if(!modalOpenFlag) refreshState(); }, 8000);
  }

  document.getElementById('logoutBtn').addEventListener('click', ()=>{
    session = null;
    if(pollTimer) clearInterval(pollTimer);
    document.getElementById('appShell').style.display = 'none';
    document.getElementById('authOverlay').classList.add('open');
    document.getElementById('ownerPwInput').value='';
    document.getElementById('memberUserInput').value='';
    document.getElementById('memberPwInput').value='';
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
  function isLeaderLike(){ return isOwner() || isTeamLead(); }
  function canManageMembers(){ return isOwner(); }
  function canManageTasks(){ return isLeaderLike(); }
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
    if(activeTab==='board'){
      document.getElementById('viewTitle').textContent = isLeaderLike() ? "This Week's Jobs" : 'My Tasks';
      document.getElementById('board').style.display='flex';
      document.getElementById('dashboardView').style.display='none';
      document.getElementById('capacityView').style.display='none';
      document.getElementById('newTaskBtn').style.display = canManageTasks() ? 'inline-block' : 'none';
      renderBoard();
    } else if(activeTab==='dashboard'){
      document.getElementById('viewTitle').textContent = 'Performance Ledger';
      document.getElementById('board').style.display='none';
      document.getElementById('dashboardView').style.display='block';
      document.getElementById('capacityView').style.display='none';
      document.getElementById('newTaskBtn').style.display='none';
      renderDashboard();
    } else {
      document.getElementById('viewTitle').textContent = 'Capacity';
      document.getElementById('board').style.display='none';
      document.getElementById('dashboardView').style.display='none';
      document.getElementById('capacityView').style.display='block';
      document.getElementById('newTaskBtn').style.display='none';
      loadAndRenderCapacity();
    }
    renderStats();
  }

  function renderRoleBadge(){
    let label = '';
    if(isOwner()) label = (session.name || 'Owner') + ' (Owner)';
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

  document.getElementById('tabBoardBtn').addEventListener('click', ()=>{
    activeTab='board';
    document.getElementById('tabBoardBtn').classList.add('active');
    document.getElementById('tabDashBtn').classList.remove('active');
    document.getElementById('tabCapacityBtn').classList.remove('active');
    renderApp();
  });
  document.getElementById('tabDashBtn').addEventListener('click', ()=>{
    activeTab='dashboard';
    document.getElementById('tabDashBtn').classList.add('active');
    document.getElementById('tabBoardBtn').classList.remove('active');
    document.getElementById('tabCapacityBtn').classList.remove('active');
    renderApp();
  });
  document.getElementById('tabCapacityBtn').addEventListener('click', ()=>{
    activeTab='capacity';
    document.getElementById('tabCapacityBtn').classList.add('active');
    document.getElementById('tabBoardBtn').classList.remove('active');
    document.getElementById('tabDashBtn').classList.remove('active');
    renderApp();
  });

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
        <div class="brand">Cli<span>ck</span></div>
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
        <div class="brand">Cli<span>ck</span></div>
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
  document.getElementById('mmLead').addEventListener('change', toggleReportsToVisibility);
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
      populateReportsToOptions(m.teamId, m.reportsTo);
    } else {
      document.getElementById('memberModalTitle').textContent = 'Add team member';
      document.getElementById('saveMemberBtn').textContent = 'Add member';
      document.getElementById('deleteMemberBtn').style.display='none';
      document.getElementById('mmLead').checked = false;
      populateReportsToOptions(teamSel.value, '');
    }
    toggleReportsToVisibility();
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
    const reportsTo = document.getElementById('mmReportsTo').value;
    const email = document.getElementById('mmEmail').value.trim();
    if(!name || !username) return;
    if(!id && !password){ alert('Set a password for the new member.'); return; }
    try{
      if(id){
        await api('PUT', '/api/members/'+id, {name, username, password, teamId, isTeamLead, reportsTo, email});
      } else {
        await api('POST', '/api/members', {name, username, password, teamId, isTeamLead, reportsTo, email});
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
    el.draggable = true;
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
        <div class="ticket-title">${escapeHtml(t.title)}</div>
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
    try{
      await api('POST', `/api/tasks/${id}/move`, {status:newStatus});
      await refreshState();
    }catch(e){ alert(e.message); }
  }

  // ---------- TASK MODAL ----------
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
      await api('POST', `/api/tasks/${taskId}/duplicate`, {
        assignees,
        allowOverlap: document.getElementById('dupAllowOverlap').checked
      });
      closeDuplicateModal();
      await refreshState();
    }catch(e){ alert(e.message); }
  });

  function openTaskModal(taskId){
    if(!canManageTasks()) return;
    modalOpenFlag = true;
    const form = document.getElementById('taskForm');
    form.reset();
    document.getElementById('taskId').value = taskId || '';
    if(taskId){
      const t = state.tasks.find(x=>x.id===taskId);
      document.getElementById('modalTitle').textContent='Edit task';
      document.getElementById('saveTaskBtn').textContent='Save changes';
      document.getElementById('deleteTaskBtn').style.display='inline';
      document.getElementById('fTitle').value=t.title;
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
    const title = document.getElementById('fTitle').value.trim();
    if(!title) return;
    const description = document.getElementById('fDesc').value.trim();
    const assignee = document.getElementById('fAssignee').value || '';
    const priority = document.getElementById('fPriority').value;
    const isAuto = document.getElementById('fAutoSchedule').checked && !id;
    try{
      if(id){
        await api('PUT', '/api/tasks/'+id, {
          title, description, assignee, priority,
          startDate: document.getElementById('fStartDate').value || '',
          endDate: document.getElementById('fEndDate').value || '',
          allowOverlap: document.getElementById('fAllowOverlap').checked
        });
      } else if(isAuto){
        await api('POST', '/api/tasks', {
          title, description, assignee, priority,
          mode: 'auto',
          durationDays: parseInt(document.getElementById('fDuration').value,10) || 1,
          insertAfterTaskId: document.getElementById('fInsertAfter').value || null
        });
      } else {
        await api('POST', '/api/tasks', {
          title, description, assignee, priority,
          startDate: document.getElementById('fStartDate').value || '',
          endDate: document.getElementById('fEndDate').value || '',
          allowOverlap: document.getElementById('fAllowOverlap').checked
        });
      }
      closeTaskModal();
      await refreshState();
    }catch(e){ alert(e.message); }
  });
  document.getElementById('deleteTaskBtn').addEventListener('click', async ()=>{
    if(!canManageTasks()) return;
    const id = document.getElementById('taskId').value;
    if(!id || !confirm('Delete this task? This cannot be undone.')) return;
    try{
      await api('DELETE', '/api/tasks/'+id);
      closeTaskModal();
      await refreshState();
    }catch(e){ alert(e.message); }
  });

  document.getElementById('searchBox').addEventListener('input', renderBoard);

  // ---------- DASHBOARD ----------
  function memberStats(memberId, pool){
    const tasks = pool.filter(t=>t.assignee===memberId);
    const completed = tasks.filter(t=>t.status==='done');
    const onTime = completed.filter(t=> !t.due || (t.completedAt && t.completedAt<=t.due));
    return {total:tasks.length, completed:completed.length, onTime:onTime.length, open:tasks.length-completed.length};
  }

  function diffDaysInclusiveLocal(startStr, endStr){
    const s = new Date(startStr+'T00:00:00'), e = new Date(endStr+'T00:00:00');
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

  async function loadAndRenderCapacity(){
    const el = document.getElementById('capacityView');
    el.innerHTML = '<div class="notif-empty">Loading…</div>';
    try{
      const data = await api('GET', '/api/capacity');
      capacityData = data.capacity || [];
      renderCapacityList();
    }catch(e){
      el.innerHTML = `<div class="notif-empty">${escapeHtml(e.message)}</div>`;
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
      const daysUntilFree = Math.max(0, Math.round((new Date(m.nextAvailable+'T00:00:00') - new Date(today+'T00:00:00')) / 86400000));
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

  function doExport(){
    const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `nexus-snapshot-${todayStr()}.json`; a.click();
    URL.revokeObjectURL(url);
  }

  boot();
})();
