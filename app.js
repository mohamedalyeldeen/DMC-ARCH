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
      document.getElementById('loadingScreen').textContent = 'Could not reach the Nexus server. Check that it is running.';
    }
  }

  document.getElementById('setupBtn').addEventListener('click', async ()=>{
    const pw1 = document.getElementById('setupPw1').value;
    const pw2 = document.getElementById('setupPw2').value;
    const err = document.getElementById('setupError');
    if(!pw1 || pw1.length<3){ err.textContent='Choose a password (3+ characters).'; return; }
    if(pw1!==pw2){ err.textContent='Passwords do not match.'; return; }
    try{
      const data = await api('POST', '/api/auth/setup', {password: pw1});
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
  function canApproveOrSendBack(){ return isLeaderLike(); }
  function canAdvance(task, fromIdx){
    if(isLeaderLike()) return true;
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
    renderSidebar();
    if(activeTab==='board'){
      document.getElementById('viewTitle').textContent = isLeaderLike() ? "This Week's Jobs" : 'My Tasks';
      document.getElementById('board').style.display='flex';
      document.getElementById('dashboardView').style.display='none';
      document.getElementById('newTaskBtn').style.display = canManageTasks() ? 'inline-block' : 'none';
      renderBoard();
    } else {
      document.getElementById('viewTitle').textContent = 'Performance Ledger';
      document.getElementById('board').style.display='none';
      document.getElementById('dashboardView').style.display='block';
      document.getElementById('newTaskBtn').style.display='none';
      renderDashboard();
    }
    renderStats();
  }

  function renderRoleBadge(){
    let label = '';
    if(isOwner()) label = 'Owner';
    else if(isTeamLead()) label = 'Team Leader — ' + (teamById(session.teamId)||{name:''}).name;
    else label = 'Member — ' + (teamById(session.teamId)||{name:''}).name;
    document.getElementById('roleBadge').textContent = label;
  }

  document.getElementById('tabBoardBtn').addEventListener('click', ()=>{
    activeTab='board';
    document.getElementById('tabBoardBtn').classList.add('active');
    document.getElementById('tabDashBtn').classList.remove('active');
    renderApp();
  });
  document.getElementById('tabDashBtn').addEventListener('click', ()=>{
    activeTab='dashboard';
    document.getElementById('tabDashBtn').classList.add('active');
    document.getElementById('tabBoardBtn').classList.remove('active');
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
        <div class="brand">Nex<span>us</span></div>
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
        <div class="brand">Nex<span>us</span></div>
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
      teamSel.value = m.teamId;
      document.getElementById('mmLead').checked = !!m.isTeamLead;
    } else {
      document.getElementById('memberModalTitle').textContent = 'Add team member';
      document.getElementById('saveMemberBtn').textContent = 'Add member';
      document.getElementById('deleteMemberBtn').style.display='none';
      document.getElementById('mmLead').checked = false;
    }
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
    if(!name || !username) return;
    if(!id && !password){ alert('Set a password for the new member.'); return; }
    try{
      if(id){
        await api('PUT', '/api/members/'+id, {name, username, password, teamId, isTeamLead});
      } else {
        await api('POST', '/api/members', {name, username, password, teamId, isTeamLead});
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
      const colTasks = tasks.filter(t=>t.status===col.key);
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
    const overdue = t.due && t.due < todayStr() && t.status!=='done';
    let dots=''; for(let i=0;i<COLUMNS.length;i++){ dots += `<span class="${i<=colIdx?'done':''}"></span>`; }

    const canFwd = colIdx<COLUMNS.length-1 && canAdvance(t, colIdx);
    const canBack = colIdx>0 && canApproveOrSendBack();
    const canEdit = canManageTasks();

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
          <div class="ticket-due ${overdue?'overdue':''}">${overdue?'⚠ ':''}${fmtDate(t.due)}</div>
        </div>
        <div class="lifecycle">${dots}</div>
        <div class="ticket-actions">
          ${colIdx>0? `<button class="tk-btn back" data-act="back" ${canBack?'':'disabled'}>◂ Back</button>`:''}
          ${colIdx<COLUMNS.length-1? `<button class="tk-btn" data-act="forward" ${canFwd?'':'disabled'}>${nextActionLabel(colIdx)}</button>`:''}
          ${canEdit? `<button class="tk-btn back" data-act="edit" style="max-width:34px;flex:0 0 34px;">✎</button>`:''}
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
  function fillAssigneeOptions(selected){
    const sel = document.getElementById('fAssignee');
    let html = '<option value="">Unassigned</option>';
    state.teams.forEach(team=>{
      const members = state.members.filter(m=>m.teamId===team.id);
      if(members.length===0) return;
      html += `<optgroup label="${escapeHtml(team.name)}">` + members.map(m=>`<option value="${m.id}">${escapeHtml(m.name)}</option>`).join('') + '</optgroup>';
    });
    sel.innerHTML = html;
    sel.value = selected || '';
  }

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
      document.getElementById('fDue').value=t.due||'';
    } else {
      document.getElementById('modalTitle').textContent='Assign a new task';
      document.getElementById('saveTaskBtn').textContent='Assign task';
      document.getElementById('deleteTaskBtn').style.display='none';
      fillAssigneeOptions('');
      document.getElementById('fPriority').value='M';
    }
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
    const due = document.getElementById('fDue').value || '';
    try{
      if(id){
        await api('PUT', '/api/tasks/'+id, {title, description, assignee, priority, due});
      } else {
        await api('POST', '/api/tasks', {title, description, assignee, priority, due});
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

  function renderDashboard(){
    const el = document.getElementById('dashboardView');
    if(isLeaderLike()){
      const pool = state.dashboardTasks || state.tasks;
      let rows = state.members.map(m=>{
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
      `;
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
      `;
    }
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
