// ===================================================================
// RUN & RATE PWA — 양산 초기 검증 + 공정별 CPK 분석
// 저장방식: Firebase Firestore (개인 사용 전용, 실시간 동기화 + 오프라인 캐시)
// ===================================================================

let fb = null; // firebase-init.js가 노출한 {db, collection, doc, ...} 핸들
let DB = { projects: [] };
let state = {
  activeProjectId: null,
  activeTab: 'overview',
  activeProcessId: null,      // 분석 탭에서 선택된 공정
  cpkProcessId: null,         // CPK 탭에서 선택된 공정
  cpkInputMode: 'raw',        // 'raw' (개별측정값) | 'stats' (통계값직접입력)
  timer: { running:false, startTs:0, intervalId:null },
  connected: false,
  unsubProjects: null,
  unsubDetail: []            // 활성 프로젝트의 서브컬렉션 리스너들 (전환 시 해제)
};

// ---------- Utility ----------
function uid(prefix){ return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function nowISO(){ return new Date().toISOString(); }
function fmtDate(ts){
  const d = new Date(ts);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function fmtDateShort(iso){
  const d = new Date(iso);
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function round(n, d=2){
  if(n===null||n===undefined||isNaN(n)) return null;
  const f = Math.pow(10,d);
  return Math.round(n*f)/f;
}
function escapeHtml(s){
  if(s===null||s===undefined) return '';
  return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toast(msg, type=''){
  const wrap = document.getElementById('toast-wrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' t-'+type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(), 300); }, 2600);
}
function setConnStatus(connected){
  const prev = state.connected;
  state.connected = connected;
  const status = document.getElementById('sync-status');
  const dot = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');
  if(status){
    status.classList.toggle('ok', connected);
    status.classList.toggle('bad', !connected);
  }
  if(dot) dot.style.background = connected ? 'var(--green)' : 'var(--red)';
  if(label) label.textContent = connected ? '동기화 완료' : '연결 끊김 (오프라인 캐시 사용 중)';
  if(connected && !prev){
    toast('동기화 완료', 'success');
  }
}

// ---------- Persistence (Firestore) ----------
// 주의: 측정 데이터(cycles/defects/raw 등)는 절대 배열 전체를 덮어쓰지 않음.
//       항상 addDoc(추가)/deleteDoc(단일삭제)만 사용 — 머신카드 데이터손실 버그 재발 방지.

function projectsCol(){ return fb.collection(fb.db, 'projects'); }
function processesCol(pid){ return fb.collection(fb.db, 'projects', pid, 'processes'); }
function cyclesCol(pid){ return fb.collection(fb.db, 'projects', pid, 'cycles'); }
function defectsCol(pid){ return fb.collection(fb.db, 'projects', pid, 'defects'); }
function cpkCol(pid){ return fb.collection(fb.db, 'projects', pid, 'cpkData'); }

// 최상위 프로젝트 목록 실시간 구독 (앱 시작 시 1회만 호출)
function subscribeProjects(){
  state.unsubProjects = fb.onSnapshot(projectsCol(), (snap)=>{
    setConnStatus(true);
    const prevActiveId = state.activeProjectId;
    const newList = snap.docs.map(d=>{
      const data = d.data();
      const existing = getProject(d.id);
      return {
        id: d.id,
        pn: data.pn, pname: data.pname,
        targetUph: data.targetUph ?? null,
        targetQty: data.targetQty ?? null,
        remark: data.remark || '',
        createdAt: data.createdAt || nowISO(),
        // 상세 서브컬렉션은 별도 리스너가 채움. 기존 값 보존(프로젝트 목록 갱신 시 상세 날아가지 않게).
        processes: existing? existing.processes : [],
        cycles: existing? existing.cycles : {},
        defects: existing? existing.defects : [],
        cpkData: existing? existing.cpkData : {}
      };
    });
    DB.projects = newList;
    renderSidebar();
    if(prevActiveId && !getProject(prevActiveId)){
      // 활성 프로젝트가 삭제된 경우 (다른 기기에서 삭제했을 수도 있음)
      state.activeProjectId = null;
      document.getElementById('proj-view').style.display='none';
      document.getElementById('main-empty').style.display='flex';
    } else if(prevActiveId){
      renderProjectHeader();
      if(document.getElementById('proj-view').style.display !== 'none') renderContent();
    }
  }, (err)=>{
    console.error('projects listener error', err);
    setConnStatus(false);
    toast('Firestore 연결 오류: ' + err.message, 'error');
  });
}

// 프로젝트 선택 시 해당 프로젝트의 서브컬렉션 4개를 실시간 구독
function subscribeProjectDetail(pid){
  // 이전 구독 해제
  state.unsubDetail.forEach(u=>u());
  state.unsubDetail = [];

  const u1 = fb.onSnapshot(fb.query(processesCol(pid), fb.orderBy('seq')), (snap)=>{
    const proj = getProject(pid);
    if(!proj) return;
    proj.processes = snap.docs.map(d=> ({ id:d.id, ...d.data() }));
    if(document.getElementById('proj-view').style.display !== 'none'){
      renderProjectHeader(); renderContent(); renderSidebar();
    }
  }, (err)=>{ console.error('processes listener error', err); });

  const u2 = fb.onSnapshot(cyclesCol(pid), (snap)=>{
    const proj = getProject(pid);
    if(!proj) return;
    const byProc = {};
    snap.docs.forEach(d=>{
      const c = d.data();
      if(!byProc[c.processId]) byProc[c.processId] = [];
      byProc[c.processId].push({ id:d.id, ts: Number(c.ts), ct: Number(c.ct) });
    });
    proj.cycles = byProc;
    if(state.timer.running){
      // 타이머 작동 중엔 전체 재렌더(분석탭 DOM 재생성) 대신 기록 테이블만 갱신해 타이머가 끊기지 않게 함
      refreshCycleTableOnly(proj);
    } else if(state.activeTab==='analysis' || state.activeTab==='overview'){
      renderContent();
    }
    renderSidebar();
  }, (err)=>{ console.error('cycles listener error', err); });

  const u3 = fb.onSnapshot(defectsCol(pid), (snap)=>{
    const proj = getProject(pid);
    if(!proj) return;
    proj.defects = snap.docs.map(d=> ({ id:d.id, ...d.data() }));
    if(state.activeTab==='history' || state.activeTab==='overview') renderContent();
    renderSidebar();
  }, (err)=>{ console.error('defects listener error', err); });

  const u4 = fb.onSnapshot(cpkCol(pid), (snap)=>{
    const proj = getProject(pid);
    if(!proj) return;
    const byProc = {};
    snap.docs.forEach(d=>{ byProc[d.id] = d.data(); });
    proj.cpkData = byProc;
    if(state.activeTab==='cpk' || state.activeTab==='overview') renderContent();
    renderSidebar();
  }, (err)=>{ console.error('cpkData listener error', err); });

  state.unsubDetail = [u1,u2,u3,u4];
}

// ---------- Data model helpers ----------
function getProject(id){ return DB.projects.find(p=>p.id===id); }
function activeProject(){ return getProject(state.activeProjectId); }

function newProjectData(data){
  return {
    pn: data.pn,
    pname: data.pname,
    targetUph: data.targetUph || null,
    targetQty: data.targetQty || null,
    remark: data.remark || '',
    createdAt: nowISO()
  };
}

function projectStatus(proj){
  const procs = proj.processes;
  if(procs.length === 0) return 'warn';
  let worst = 'good';
  procs.forEach(p=>{
    const r = computeRate(proj, p.id);
    const c = computeCpkSummary(proj, p.id);
    let s = 'good';
    if(r.ratePct !== null && r.ratePct < 90) s = 'bad';
    else if(r.ratePct !== null && r.ratePct < 100) s = 'warn';
    if(c.cpk !== null){
      if(c.cpk < 1.0 && s!=='bad') s = 'bad';
      else if(c.cpk < 1.33 && s==='good') s = 'warn';
    }
    if(s==='bad') worst='bad';
    else if(s==='warn' && worst!=='bad') worst='warn';
  });
  return worst;
}

// ---------- Cycle time / Rate calculations ----------
function getCycles(proj, processId){
  return (proj.cycles[processId] || []).slice().sort((a,b)=> Number(a.ts) - Number(b.ts));
}
function computeRate(proj, processId){
  const proc = proj.processes.find(p=>p.id===processId);
  const cycles = getCycles(proj, processId);
  if(!proc || cycles.length===0) return { avgCt:null, uph:null, ratePct:null, n:0, minCt:null, maxCt:null, stdCt:null };
  const cts = cycles.map(c=> Number(c.ct)).filter(v=>!isNaN(v) && v>0);
  if(cts.length===0) return { avgCt:null, uph:null, ratePct:null, n:0, minCt:null, maxCt:null, stdCt:null };
  const avgCt = cts.reduce((a,b)=>a+b,0)/cts.length;
  const uph = avgCt > 0 ? 3600/avgCt : null;
  let ratePct = null;
  if(proc.targetCt && proc.targetCt > 0){
    ratePct = (proc.targetCt/avgCt)*100;
  }
  const meanV = avgCt;
  const variance = cts.reduce((s,v)=>s+Math.pow(v-meanV,2),0)/cts.length;
  return {
    avgCt: round(avgCt,2),
    uph: uph!==null? round(uph,1): null,
    ratePct: ratePct!==null? round(ratePct,1): null,
    n: cts.length,
    minCt: round(Math.min(...cts),2),
    maxCt: round(Math.max(...cts),2),
    stdCt: round(Math.sqrt(variance),3)
  };
}

function processManpower(proc){
  const m = Number(proc?.manpower);
  if(isNaN(m) || m <= 0) return 1;
  return m;
}

function computeCapacity(proj, processId){
  const proc = proj.processes.find(p=>p.id===processId);
  const r = computeRate(proj, processId);
  if(!proc) return { manpower:1, targetUph:null, actualUph:r.uph, targetCapa:null, actualCapa:null, capaGap:null };
  const manpower = processManpower(proc);
  const targetUph = (proc.targetCt && proc.targetCt>0) ? round(3600/proc.targetCt, 1) : null;
  const actualUph = r.uph;
  const targetCapa = targetUph!==null ? round(targetUph * manpower, 1) : null;
  const actualCapa = actualUph!==null ? round(actualUph * manpower, 1) : null;
  const capaGap = (targetCapa!==null && actualCapa!==null) ? round(actualCapa - targetCapa, 1) : null;
  return { manpower, targetUph, actualUph, targetCapa, actualCapa, capaGap };
}

function capaInsight(ratePct){
  if(ratePct===null) return { tone:'warn', title:'측정 데이터 부족', msg:'사이클타임 5건 이상을 먼저 측정하세요.' };
  if(ratePct>=110) return { tone:'good', title:'목표 대비 여유 있음', msg:'현재 조건 유지 + 표준작업 고정으로 재현성을 확보하세요.' };
  if(ratePct>=100) return { tone:'good', title:'목표 충족', msg:'병목 후보 공정과 교대별 편차를 점검해 안정화하세요.' };
  if(ratePct>=90) return { tone:'warn', title:'경계 구간', msg:'작업 분해(동작/이동/대기) 후 5~10% 단축 CAPA를 수립하세요.' };
  return { tone:'bad', title:'즉시 개선 필요', msg:'설비/치공구/동선 개선과 인력 재배치 CAPA를 즉시 실행하세요.' };
}

function projectOverallRate(proj){
  if(proj.processes.length===0) return null;
  let min = null;
  proj.processes.forEach(p=>{
    const r = computeRate(proj, p.id);
    if(r.ratePct !== null){
      if(min===null || r.ratePct < min) min = r.ratePct;
    }
  });
  return min;
}
function findBottleneck(proj){
  let bottleneck = null, maxCt = -1;
  proj.processes.forEach(p=>{
    const r = computeRate(proj, p.id);
    if(r.avgCt !== null && r.avgCt > maxCt){ maxCt = r.avgCt; bottleneck = p; }
  });
  return bottleneck;
}

// ---------- Defect rate ----------
function defectSummary(proj, processId){
  const list = processId ? proj.defects.filter(d=>d.processId===processId) : proj.defects;
  const totalDefect = list.reduce((s,d)=>s+Number(d.qty||0),0);
  const producedFromDefect = list.reduce((m,d)=>{
    const v = Number(d.total);
    return (isNaN(v) || v < 0) ? m : Math.max(m, v);
  }, 0);
  const totalProduced = producedFromDefect;
  const goodQty = Math.max(totalProduced - totalDefect, 0);
  const ppm = totalProduced>0 ? round((totalDefect/totalProduced)*1000000,0) : null;
  const defectRate = totalProduced>0 ? round((totalDefect/totalProduced)*100,3) : null;
  const yieldRate = totalProduced>0 ? round((goodQty/totalProduced)*100,3) : null;
  const targetQty = (!processId && proj.targetQty) ? Number(proj.targetQty) : null;
  const runProgressPct = (targetQty && targetQty>0) ? round((totalProduced/targetQty)*100,1) : null;
  return {
    totalDefect,
    totalProduced,
    goodQty,
    ppm,
    defectRate,
    yieldRate,
    targetQty,
    runProgressPct,
    count: list.length
  };
}

function processDefectSummaryList(proj){
  return proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>{
    const list = proj.defects.filter(d=>d.processId===p.id);
    const produced = list.reduce((m,d)=>{
      const v = Number(d.total);
      return (isNaN(v) || v < 0) ? m : Math.max(m, v);
    }, 0);
    const defect = list.reduce((s,d)=>s+Number(d.qty||0),0);
    const good = Math.max(produced - defect, 0);
    const defectRate = produced>0 ? round((defect/produced)*100,3) : null;
    const yieldRate = produced>0 ? round((good/produced)*100,3) : null;
    const r = computeRate(proj, p.id);
    const targetQty = Number(proj.targetQty || 0);
    const progressPct = targetQty>0 ? round((produced/targetQty)*100,1) : null;
    return {
      processId: p.id,
      seq: p.seq,
      name: p.name,
      produced,
      good,
      defect,
      defectRate,
      yieldRate,
      ratePct: r.ratePct,
      progressPct
    };
  });
}

// ---------- CPK calculations ----------
function meanArr(arr){ return arr.reduce((a,b)=>a+b,0)/arr.length; }
function stdDev(arr){
  const m = meanArr(arr);
  const v = arr.reduce((s,x)=>s+Math.pow(x-m,2),0)/(arr.length-1); // sample std dev (n-1)
  return Math.sqrt(v);
}
function computeCpk({mean:m, sd, usl, lsl}){
  if(sd===0 || sd===null || sd===undefined || isNaN(sd)) return null;
  if((usl===null||usl===undefined) && (lsl===null||lsl===undefined)) return null;
  let cpu = (usl!==null && usl!==undefined) ? (usl - m) / (3*sd) : Infinity;
  let cpl = (lsl!==null && lsl!==undefined) ? (m - lsl) / (3*sd) : Infinity;
  return Math.min(cpu, cpl);
}
function computeCp({sd, usl, lsl}){
  if(sd===0 || !sd || usl===null||usl===undefined||lsl===null||lsl===undefined) return null;
  return (usl-lsl)/(6*sd);
}
function isLowerBetterCpk(cd){
  const text = `${cd?.itemName||''} ${cd?.unit||''}`;
  return /리크|누설|leak|leakage/i.test(text);
}
function getCpkOrientation(cd){
  if(!cd) return 'mid';
  if(cd?.analysisMode === 'high') return 'high';
  if(cd?.analysisMode === 'mid') return 'mid';
  if(cd?.analysisMode === 'low') return 'low';
  return isLowerBetterCpk(cd) ? 'low' : 'mid';
}
function cpkGrade(cpk){
  if(cpk===null) return {label:'데이터 없음', cls:'warn'};
  if(cpk >= 1.67) return {label:'매우 우수 (S급)', cls:'good'};
  if(cpk >= 1.33) return {label:'양호 (합격)', cls:'good'};
  if(cpk >= 1.0) return {label:'관리 필요 (주의)', cls:'warn'};
  return {label:'불합격 (개선 필요)', cls:'bad'};
}

function computeCpkSummary(proj, processId){
  const cd = proj.cpkData[processId];
  if(!cd) return { cpk:null, cp:null, m:null, sd:null, n:0 };
  let m=null, sd=null, n=0;
  if(cd.mode === 'raw'){
    const vals = (cd.raw||[]).map(Number).filter(v=>!isNaN(v));
    n = vals.length;
    if(n < 2) return { cpk:null, cp:null, m:null, sd:null, n, usl: cd.usl, lsl: cd.lsl };
    m = meanArr(vals);
    sd = stdDev(vals);
  } else {
    if(!cd.statsMean || !cd.statsSd) return { cpk:null, cp:null, m:null, sd:null, n:cd.statsN||0, usl: cd.usl, lsl: cd.lsl };
    m = Number(cd.statsMean);
    sd = Number(cd.statsSd);
    n = Number(cd.statsN)||0;
  }
  const usl = cd.usl!==undefined && cd.usl!==null && cd.usl!=='' ? Number(cd.usl) : null;
  const lsl = cd.lsl!==undefined && cd.lsl!==null && cd.lsl!=='' ? Number(cd.lsl) : null;
  const cpu = (usl!==null && usl!==undefined) ? (usl - m) / (3*sd) : null;
  const cpl = (lsl!==null && lsl!==undefined) ? (m - lsl) / (3*sd) : null;
  const orientation = getCpkOrientation(cd);
  const lowerBetter = orientation === 'low';
  const upperBetter = orientation === 'high';
  const cpk = orientation === 'high' ? cpl : orientation === 'low' ? cpu : computeCpk({mean:m, sd, usl, lsl});
  const cp = computeCp({sd, usl, lsl});
  return {
    cpk: cpk!==null? round(cpk,3): null,
    cp: cp!==null? round(cp,3): null,
    cpu: cpu!==null? round(cpu,3): null,
    cpl: cpl!==null? round(cpl,3): null,
    m: round(m,4),
    sd: round(sd,4),
    n,
    usl,
    lsl,
    target: cd.target,
    lowerBetter,
    upperBetter,
    orientation,
    metricName: orientation === 'high' ? 'Cpl' : orientation === 'low' ? 'Cpu' : 'CPK',
    modeLabel: orientation === 'high' ? '높음 중심' : orientation === 'low' ? '낮음 중심' : '중간 중심',
    modeTone: orientation === 'high' ? 'higher' : orientation === 'low' ? 'lower' : 'standard',
    modeNote: orientation === 'high'
      ? '높을수록 좋은 항목은 하한 여유(Cpl)를 중심으로 해석합니다.'
      : orientation === 'low'
        ? '낮을수록 좋은 항목은 상한 여유(Cpu)를 중심으로 해석합니다.'
        : '일반적인 ± 공차는 양측 규격(CPK)으로 해석합니다.'
  };
}

// ===================================================================
// RENDERING
// ===================================================================

function renderSidebar(){
  const list = document.getElementById('proj-list');
  if(DB.projects.length===0){
    list.innerHTML = '<div class="sb-empty">등록된 프로젝트가 없습니다.<br>상단의 "신규" 버튼으로<br>품번 프로젝트를 생성하세요.</div>';
    return;
  }
  list.innerHTML = DB.projects.slice().sort((a,b)=> b.createdAt.localeCompare(a.createdAt)).map(p=>{
    const status = projectStatus(p);
    const chipClass = status==='good'?'chip-green':status==='warn'?'chip-amber':'chip-red';
    const chipLabel = status==='good'?'정상':status==='warn'?'주의':'경고';
    return `<div class="proj-item ${p.id===state.activeProjectId?'active':''}" data-id="${p.id}">
      <div class="pn">${escapeHtml(p.pn)}</div>
      <div class="pname">${escapeHtml(p.pname)}</div>
      <div class="pmeta">
        <span>공정 ${p.processes.length}개</span>
        <span class="chip ${chipClass}">${chipLabel}</span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.proj-item').forEach(el=>{
    el.addEventListener('click', ()=>selectProject(el.dataset.id));
  });
}

function selectProject(id){
  state.activeProjectId = id;
  state.activeProcessId = null;
  state.cpkProcessId = null;
  state.activeTab = 'overview';
  document.getElementById('main-empty').style.display='none';
  document.getElementById('proj-view').style.display='flex';
  setSidebarOpen(false);
  subscribeProjectDetail(id);
  renderSidebar();
  renderProjectHeader();
  setTab('overview');
}

function renderProjectHeader(){
  const proj = activeProject();
  if(!proj) return;
  document.getElementById('ph-pn').textContent = proj.pn;
  document.getElementById('ph-name').textContent = proj.pname;
  document.getElementById('ph-meta').textContent = `등록일 ${fmtDateShort(proj.createdAt)} · 공정 ${proj.processes.length}개${proj.remark ? ' · '+proj.remark : ''}`;
  document.getElementById('badge-proc-count').textContent = proj.processes.length;
}

function setTab(tab){
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active', t.dataset.tab===tab));
  renderContent();
}

function renderContent(){
  const proj = activeProject();
  if(!proj) return;
  const root = document.getElementById('content');
  if(state.activeTab === 'overview') root.innerHTML = renderOverview(proj);
  else if(state.activeTab === 'process') root.innerHTML = renderProcessTab(proj);
  else if(state.activeTab === 'analysis') root.innerHTML = renderAnalysisTab(proj);
  else if(state.activeTab === 'cpk') root.innerHTML = renderCpkTab(proj);
  else if(state.activeTab === 'history') root.innerHTML = renderHistoryTab(proj);
  attachContentEvents(proj);
}

// ---------- OVERVIEW ----------
function renderOverview(proj){
  const overallRate = projectOverallRate(proj);
  const bottleneck = findBottleneck(proj);
  const ds = defectSummary(proj, null);
  const totalManpower = proj.processes.reduce((s,p)=>s+(Number(p.manpower)||0), 0);
  let cpkWorst=null;
  proj.processes.forEach(p=>{
    const c = computeCpkSummary(proj, p.id);
    if(c.cpk!==null){
      if(cpkWorst===null || c.cpk < cpkWorst) cpkWorst = c.cpk;
    }
  });

  const rateStatus = overallRate===null? '' : overallRate>=100?'status-good':overallRate>=90?'status-warn':'status-bad';
  const rateValClass = overallRate===null? '' : overallRate>=100?'good':overallRate>=90?'warn':'bad';
  const cpkStatus = cpkWorst===null? '' : cpkWorst>=1.33?'status-good':cpkWorst>=1.0?'status-warn':'status-bad';
  const cpkValClass = cpkWorst===null? '' : cpkWorst>=1.33?'good':cpkWorst>=1.0?'warn':'bad';
  const defStatus = ds.defectRate===null? '' : ds.defectRate<=1?'status-good':ds.defectRate<=3?'status-warn':'status-bad';
  const defValClass = ds.defectRate===null? '' : ds.defectRate<=1?'good':ds.defectRate<=3?'warn':'bad';

  return `
  <div class="kpi-strip cols-6">
    <div class="kpi-card ${rateStatus}">
      <div class="kpi-label">라인 Rate% (병목기준)</div>
      <div class="kpi-value ${rateValClass}">${overallRate!==null? overallRate : '—'}<span class="kpi-unit">%</span></div>
      <div class="kpi-sub">목표 100% 대비</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">병목 공정</div>
      <div class="kpi-value" style="font-size:18px;">${bottleneck? escapeHtml(bottleneck.name) : '—'}</div>
      <div class="kpi-sub">${bottleneck? 'Avg C/T '+computeRate(proj,bottleneck.id).avgCt+'초' : '측정 데이터 없음'}</div>
    </div>
    <div class="kpi-card ${cpkStatus}">
      <div class="kpi-label">최저 CPK (공정중)</div>
      <div class="kpi-value ${cpkValClass}">${cpkWorst!==null? cpkWorst.toFixed(2) : '—'}</div>
      <div class="kpi-sub">${cpkWorst!==null? cpkGrade(cpkWorst).label : '측정 데이터 없음'}</div>
    </div>
    <div class="kpi-card ${defStatus}">
      <div class="kpi-label">불량률</div>
      <div class="kpi-value ${defValClass}">${ds.defectRate!==null? ds.defectRate : '—'}<span class="kpi-unit">%</span></div>
      <div class="kpi-sub">${ds.totalDefect}건 / 생산 ${ds.totalProduced}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">목표 수량 진척</div>
      <div class="kpi-value">${proj.targetQty? round((ds.totalProduced/proj.targetQty)*100,1)+'%' : '—'}</div>
      <div class="kpi-sub">${proj.targetQty? ds.totalProduced+' / '+proj.targetQty : '목표 미설정'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">공정 투입 인원</div>
      <div class="kpi-value">${totalManpower}<span class="kpi-unit">명</span></div>
      <div class="kpi-sub">${proj.processes.length}개 공정 합계</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h3>공정별 현황 요약</h3>
      <span class="ph-tag">${proj.processes.length}개 공정</span>
    </div>
    <div class="panel-body overflow-x" style="padding:0;">
      ${proj.processes.length===0 ? `<div class="mini-empty"><div class="ico">⚙</div><p>아직 등록된 공정이 없습니다. "공정 등록" 탭에서 조립 공정을 추가하세요.</p></div>` : `
      <div class="col-headers"><div></div><div>공정명</div><div>인원</div><div>Avg C/T</div><div>UPH</div><div>Rate%</div><div>CPK</div><div></div></div>
      ${proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>{
        const r = computeRate(proj, p.id);
        const c = computeCpkSummary(proj, p.id);
        const rateClass = r.ratePct===null?'':r.ratePct>=100?'chip-green':r.ratePct>=90?'chip-amber':'chip-red';
        const cpkClass = c.cpk===null?'':c.cpk>=1.33?'chip-green':c.cpk>=1.0?'chip-amber':'chip-red';
        return `<div class="process-row" data-goto-process="${p.id}">
          <div class="proc-num">${p.seq}</div>
          <div class="proc-name">${escapeHtml(p.name)}${p.eq?`<span class="proc-eq">${escapeHtml(p.eq)}</span>`:''}</div>
          <div class="mono">${p.manpower!=null? p.manpower+'명' : '—'}</div>
          <div class="mono">${r.avgCt!==null? r.avgCt+'초' : '—'}</div>
          <div class="mono">${r.uph!==null? r.uph : '—'}</div>
          <div><span class="rate-pill ${rateClass}">${r.ratePct!==null? r.ratePct+'%' : '—'}</span></div>
          <div><span class="rate-pill ${cpkClass}">${c.cpk!==null? c.cpk.toFixed(2) : '—'}</span></div>
          <div></div>
        </div>`;
      }).join('')}
      `}
    </div>
  </div>`;
}

// ---------- PROCESS REGISTER TAB ----------
function renderProcessTab(proj){
  return `
  <div class="panel">
    <div class="panel-head">
      <h3>등록된 조립 공정 (순서대로)</h3>
      <button class="btn btn-primary btn-sm" id="btn-open-process-modal">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        공정 추가/수정
      </button>
    </div>
    <div class="panel-body overflow-x" style="padding:0;">
      ${proj.processes.length===0 ? `<div class="mini-empty"><div class="ico">📋</div><p>품번 ${escapeHtml(proj.pn)}의 조립 공정을 등록하세요.<br>예: 1차 압입 → 부품 체결 → 토크 검사 → 외관 검사</p></div>` : `
      <div class="col-headers"><div></div><div>공정명 / 설비</div><div>목표 C/T</div><div>인원</div><div>측정수</div><div>Avg C/T</div><div></div></div>
      ${proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>{
        const r = computeRate(proj, p.id);
        return `<div class="process-row">
          <div class="proc-num">${p.seq}</div>
          <div class="proc-name">${escapeHtml(p.name)}${p.eq?`<span class="proc-eq">${escapeHtml(p.eq)}</span>`:''}</div>
          <div class="mono">${p.targetCt? p.targetCt+'초' : '미설정'}</div>
          <div class="mono">${processManpower(p)}명</div>
          <div class="mono">${r.n}건</div>
          <div class="mono">${r.avgCt!==null? r.avgCt+'초' : '—'}</div>
          <div class="row-actions">
            <div class="icon-mini" data-del-process="${p.id}" title="삭제">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
            </div>
          </div>
        </div>`;
      }).join('')}
      `}
    </div>
  </div>`;
}

function renderAnalysisOverallChart(rows){
  const rated = rows.filter(r=>r.ratePct!==null);
  const maxRate = rated.length ? Math.max(...rated.map(r=>r.ratePct), 100) : 100;
  return `
  <div style="display:flex; flex-direction:column; gap:10px;">
    ${rows.map(r=>{
      const w = r.ratePct===null ? 0 : Math.max(3, Math.min(100, (r.ratePct/maxRate)*100));
      const tone = r.ratePct===null ? '#9CA3AF' : r.ratePct>=100 ? 'var(--green)' : r.ratePct>=90 ? 'var(--amber)' : 'var(--red)';
      return `<div class="rate-bar-row">
        <div class="rate-bar-label">${escapeHtml(r.label)}${r.manpower!=null?`<span style="color:var(--gauge-grey);font-size:11px;font-weight:400;margin-left:6px;">${r.manpower}명</span>`:''}
        </div>
        <div style="height:10px; background:#ECE9E0; border-radius:999px; overflow:hidden;">
          <div style="width:${w}%; height:100%; background:${tone};"></div>
        </div>
        <div class="mono rate-bar-val">${r.ratePct===null?'—':r.ratePct+'%'}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderAnalysisAllTab(proj){
  const bottleneck = findBottleneck(proj);
  const rows = proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>{
    const r = computeRate(proj, p.id);
    return {
      id: p.id,
      label: `${p.seq}. ${p.name}`,
      manpower: p.manpower,
      targetCt: p.targetCt,
      avgCt: r.avgCt,
      uph: r.uph,
      ratePct: r.ratePct,
      n: r.n
    };
  });
  const measured = rows.filter(r=>r.n>0).length;
  const totalSamples = rows.reduce((s,r)=>s+r.n,0);
  const totalManpower = proj.processes.reduce((s,p)=>s+(Number(p.manpower)||0), 0);
  const avgRate = rows.filter(r=>r.ratePct!==null).length
    ? round(rows.filter(r=>r.ratePct!==null).reduce((s,r)=>s+r.ratePct,0)/rows.filter(r=>r.ratePct!==null).length,1)
    : null;

  const bnRate = bottleneck ? computeRate(proj, bottleneck.id) : null;
  const bnUph = bnRate ? bnRate.uph : null;
  const dayQty  = bnUph ? Math.floor(bnUph * 8) : null;
  const weekQty = bnUph ? Math.floor(bnUph * 8 * 5) : null;
  const monQty  = bnUph ? Math.floor(bnUph * 8 * 22) : null;

  return `
  <div class="kpi-strip cols-6">
    <div class="kpi-card"><div class="kpi-label">등록 공정 수</div><div class="kpi-value">${rows.length}<span class="kpi-unit">개</span></div></div>
    <div class="kpi-card"><div class="kpi-label">측정 완료 공정</div><div class="kpi-value">${measured}<span class="kpi-unit">개</span></div></div>
    <div class="kpi-card"><div class="kpi-label">총 측정 건수</div><div class="kpi-value">${totalSamples}<span class="kpi-unit">건</span></div></div>
    <div class="kpi-card"><div class="kpi-label">공정 평균 Rate</div><div class="kpi-value">${avgRate??'—'}<span class="kpi-unit">%</span></div></div>
    <div class="kpi-card"><div class="kpi-label">공정 투입 인원</div><div class="kpi-value">${totalManpower}<span class="kpi-unit">명</span></div></div>
    <div class="kpi-card"><div class="kpi-label">병목 공정</div><div class="kpi-value" style="font-size:18px;">${bottleneck?escapeHtml(bottleneck.name):'—'}</div></div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>병목 기준 생산 가능 수량</h3><span class="ph-tag">${bottleneck?escapeHtml(bottleneck.name)+' 기준':'측정 데이터 필요'}</span></div>
    <div class="panel-body">
      <div class="kpi-strip cols-3" style="margin:0;">
        <div class="kpi-card"><div class="kpi-label">일 생산 가능 (8h)</div><div class="kpi-value">${dayQty!==null?dayQty.toLocaleString():'—'}<span class="kpi-unit">EA</span></div></div>
        <div class="kpi-card"><div class="kpi-label">주 생산 가능 (5일)</div><div class="kpi-value">${weekQty!==null?weekQty.toLocaleString():'—'}<span class="kpi-unit">EA</span></div></div>
        <div class="kpi-card"><div class="kpi-label">월 생산 가능 (22일)</div><div class="kpi-value">${monQty!==null?monQty.toLocaleString():'—'}<span class="kpi-unit">EA</span></div></div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>공정별 Rate% 비교 그래프</h3><span class="ph-tag">전체 보기</span></div>
    <div class="panel-body">${rows.length===0?'<div class="mini-empty"><p>등록된 공정이 없습니다.</p></div>':renderAnalysisOverallChart(rows)}</div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>공정별 분석 요약</h3><span class="ph-tag">${rows.length}개 공정</span></div>
    <div class="panel-body" style="padding:0; overflow-x:auto;">
      <table class="data-table">
        <thead><tr><th>공정</th><th>인원</th><th>목표 C/T(초)</th><th>Avg C/T(초)</th><th>UPH</th><th>Rate(%)</th><th>측정건수</th></tr></thead>
        <tbody>
        ${rows.map(r=>`<tr class="${bottleneck && bottleneck.id===r.id ? 'bottleneck-row' : ''}">
          <td>${escapeHtml(r.label)}</td>
          <td>${r.manpower!=null?r.manpower+'명':'—'}</td>
          <td>${r.targetCt??'—'}</td>
          <td>${r.avgCt??'—'}</td>
          <td>${r.uph??'—'}</td>
          <td>${r.ratePct??'—'}</td>
          <td>${r.n}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>

  <div class="panel"><div class="panel-body"><p style="font-size:12px; color:var(--gauge-grey);">사이클타임 입력/랩 측정은 공정 칩에서 개별 공정을 선택하면 사용할 수 있습니다.</p></div></div>`;
}

// ---------- ANALYSIS TAB ----------
function renderAnalysisTab(proj){
  if(proj.processes.length===0){
    return `<div class="panel"><div class="panel-body"><div class="mini-empty"><div class="ico">📊</div><p>먼저 "공정 등록" 탭에서 공정을 추가하세요.</p></div></div></div>`;
  }
  if(!state.activeProcessId || (state.activeProcessId!=='__all__' && !proj.processes.find(p=>p.id===state.activeProcessId))){
    state.activeProcessId = proj.processes.slice().sort((a,b)=>a.seq-b.seq)[0].id;
  }

  if(state.activeProcessId === '__all__'){
    return `
    <div class="analysis-toolbar">
      <div class="proc-selector">
        <div class="proc-chip active" data-select-process="__all__">전체</div>
        ${proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>`<div class="proc-chip" data-select-process="${p.id}">${p.seq}. ${escapeHtml(p.name)}</div>`).join('')}
      </div>
      <button class="btn btn-sm" id="btn-export-cycles">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        CSV 다운로드
      </button>
    </div>
    ${renderAnalysisAllTab(proj)}`;
  }

  const proc = proj.processes.find(p=>p.id===state.activeProcessId);
  const r = computeRate(proj, proc.id);
  const cap = computeCapacity(proj, proc.id);
  const insight = capaInsight(r.ratePct);
  const ctGapSec = (proc.targetCt && r.avgCt!==null) ? round(proc.targetCt - r.avgCt, 2) : null;
  const cycles = getCycles(proj, proc.id).slice().reverse();

  const rateClass = r.ratePct===null?'':r.ratePct>=100?'good':r.ratePct>=90?'warn':'bad';

  return `
  <div class="analysis-toolbar">
    <div class="proc-selector">
      <div class="proc-chip" data-select-process="__all__">전체</div>
      ${proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>`<div class="proc-chip ${p.id===proc.id?'active':''}" data-select-process="${p.id}">${p.seq}. ${escapeHtml(p.name)}</div>`).join('')}
    </div>
    <button class="btn btn-sm" id="btn-export-cycles">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      CSV 다운로드
    </button>
  </div>

  <div class="kpi-strip cols-6" id="analysis-kpi-strip">
    <div class="kpi-card">
      <div class="kpi-label">평균 사이클타임</div>
      <div class="kpi-value">${r.avgCt!==null?r.avgCt:'—'}<span class="kpi-unit">초</span></div>
      <div class="kpi-sub">Min ${r.minCt??'—'} / Max ${r.maxCt??'—'} / σ ${r.stdCt??'—'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">UPH (시간당 생산량)</div>
      <div class="kpi-value">${r.uph!==null?r.uph:'—'}<span class="kpi-unit">EA/h</span></div>
      <div class="kpi-sub">목표 C/T ${proc.targetCt? proc.targetCt+'초' : '미설정'}</div>
    </div>
    <div class="kpi-card ${rateClass!==''?'status-'+rateClass:''}">
      <div class="kpi-label">Rate %</div>
      <div class="kpi-value ${rateClass}">${r.ratePct!==null?r.ratePct:'—'}<span class="kpi-unit">%</span></div>
      <div class="kpi-sub">목표 대비 ${ctGapSec===null?'—':(ctGapSec>=0?'+':'')+ctGapSec+'초'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">투입 인원</div>
      <div class="kpi-value">${cap.manpower}<span class="kpi-unit">명</span></div>
      <div class="kpi-sub">0.5 단위 입력 지원</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">CAPA (인력 반영)</div>
      <div class="kpi-value">${cap.actualCapa!==null?cap.actualCapa:'—'}<span class="kpi-unit">EA/h</span></div>
      <div class="kpi-sub">목표 ${cap.targetCapa??'—'} / GAP ${cap.capaGap??'—'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">측정 횟수</div>
      <div class="kpi-value">${r.n}<span class="kpi-unit">건</span></div>
      <div class="kpi-sub">${cycles.length>0? '최근 '+fmtDate(cycles[0].ts) : '측정 없음'}</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>CAPA 분석</h3></div>
    <div class="panel-body">
      <div class="kpi-strip cols-3" style="margin-bottom:12px;">
        <div class="kpi-card"><div class="kpi-label">목표 UPH</div><div class="kpi-value">${cap.targetUph??'—'}</div></div>
        <div class="kpi-card"><div class="kpi-label">실측 UPH</div><div class="kpi-value">${cap.actualUph??'—'}</div></div>
        <div class="kpi-card"><div class="kpi-label">CT 차이(목표-실측)</div><div class="kpi-value ${ctGapSec===null?'':ctGapSec>=0?'good':'bad'}">${ctGapSec??'—'}<span class="kpi-unit">초</span></div></div>
      </div>
      <div class="history-row" style="border:1px solid var(--line); border-radius:8px; margin-top:2px;">
        <div>
          <div class="h-main"><span class="status-dot ${insight.tone}"></span>${insight.title}</div>
          <div class="h-sub">${insight.msg}</div>
        </div>
      </div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>사이클타임 측정 입력</h3></div>
    <div class="panel-body">
      <div class="cycle-input-panel">
        <div class="timer-display" id="timer-display">00.0</div>
        <button class="btn btn-primary" id="btn-timer-toggle">측정 시작</button>
        <div style="display:flex; flex-direction:column; gap:4px; align-items:flex-start;">
          <div id="lap-no-label" class="mono" style="font-size:11px; color:var(--gauge-grey);">LAP #${cycles.length+1}</div>
          <button class="btn" id="btn-timer-lap" disabled>랩 기록 (Enter)</button>
        </div>
        <div class="field" style="max-width:160px;">
          <label>또는 직접 입력 (초)</label>
          <input type="number" step="0.01" id="manual-ct-input" class="mono" placeholder="예: 28.5">
        </div>
        <button class="btn" id="btn-manual-ct-add">추가</button>
      </div>
      <p style="font-size:11px; color:var(--gauge-grey);">측정 시작 후 한 사이클이 끝날 때마다 "랩 기록"을 누르거나 Enter를 누르면 자동 기록됩니다.</p>
    </div>
  </div>

  <div class="panel" id="cycle-record-panel">
    <div class="panel-head">
      <h3>측정 기록</h3>
      <span class="ph-tag">${cycles.length}건</span>
    </div>
    <div class="panel-body" style="padding:0; max-height:360px; overflow-y:auto;">
      ${cycles.length===0? `<div class="mini-empty"><div class="ico">⏱</div><p>측정된 사이클타임이 없습니다.</p></div>` : `
      <table class="data-table">
        <thead><tr><th>#</th><th>측정시각</th><th>사이클타임(초)</th><th></th></tr></thead>
        <tbody>
        ${cycles.map((c,i)=>`<tr><td>${cycles.length-i}</td><td>${fmtDate(c.ts)}</td><td>${c.ct.toFixed(2)}</td><td class="del-cell" data-del-cycle="${c.id}">삭제</td></tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  </div>`;
}

// ---------- CPK TAB ----------
function renderCpkTab(proj){
  if(proj.processes.length===0){
    return `<div class="panel"><div class="panel-body"><div class="mini-empty"><div class="ico">📐</div><p>먼저 "공정 등록" 탭에서 공정을 추가하세요.</p></div></div></div>`;
  }
  if(!state.cpkProcessId || !proj.processes.find(p=>p.id===state.cpkProcessId)){
    state.cpkProcessId = proj.processes.slice().sort((a,b)=>a.seq-b.seq)[0].id;
  }
  const proc = proj.processes.find(p=>p.id===state.cpkProcessId);
  if(!proj.cpkData[proc.id]) proj.cpkData[proc.id] = { mode:'raw', raw:[], usl:null, lsl:null, target:null, statsMean:null, statsSd:null, statsN:null, itemName:'', unit:'', analysisMode:'mid' };
  const cd = proj.cpkData[proc.id];
  if(!cd.analysisMode) cd.analysisMode = getCpkOrientation(cd);
  state.cpkInputMode = cd.mode || 'raw';
  const summary = computeCpkSummary(proj, proc.id);
  const grade = cpkGrade(summary.cpk);

  return `
  <div class="analysis-toolbar">
    <div class="proc-selector">
      ${proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>`<div class="proc-chip ${p.id===proc.id?'active':''}" data-select-cpk-process="${p.id}">${p.seq}. ${escapeHtml(p.name)}</div>`).join('')}
    </div>
    <button class="btn btn-sm" id="btn-export-cpk">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      CSV 다운로드
    </button>
  </div>

  <div class="panel">
    <div class="panel-head"><h3>측정 항목 / 규격 설정</h3></div>
    <div class="panel-body">
      <div class="form-grid cols-3">
        <div class="field">
          <label>측정 항목명</label>
          <input type="text" id="cpk-item-name" value="${escapeHtml(cd.itemName||'')}" placeholder="예: 압입 깊이">
        </div>
        <div class="field">
          <label>단위</label>
          <input type="text" id="cpk-unit" value="${escapeHtml(cd.unit||'')}" placeholder="예: mm, N, sec">
        </div>
        <div class="field">
          <label>목표값 (Target)</label>
          <input type="number" step="any" id="cpk-target" class="mono" value="${cd.target??''}" placeholder="예: 10.0">
        </div>
        <div class="field">
          <label>USL (상한)</label>
          <input type="number" step="any" id="cpk-usl" class="mono" value="${cd.usl??''}" placeholder="예: 10.5">
        </div>
        <div class="field">
          <label>LSL (하한)</label>
          <input type="number" step="any" id="cpk-lsl" class="mono" value="${cd.lsl??''}" placeholder="예: 9.5">
        </div>
        <div class="field" style="justify-content:flex-end;">
          <button class="btn btn-sm" id="btn-save-spec">규격 저장</button>
        </div>
      </div>
      <div class="cpk-orientation-wrap">
        <div class="cpk-orientation-label">해석 모드</div>
        <div class="cpk-orientation-toggle" role="group" aria-label="CPK 해석 모드">
          <button class="cpk-orientation-btn ${summary.orientation==='high'?'active':''} mode-high" data-cpk-orientation="high">높음</button>
          <button class="cpk-orientation-btn ${summary.orientation==='mid'?'active':''} mode-mid" data-cpk-orientation="mid">중간</button>
          <button class="cpk-orientation-btn ${summary.orientation==='low'?'active':''} mode-low" data-cpk-orientation="low">낮음</button>
        </div>
        <div class="cpk-orientation-help">높음은 하한 중심, 중간은 양측 규격, 낮음은 상한 중심으로 해석합니다.</div>
      </div>
    </div>
  </div>

  <div class="cpk-layout">
    <div class="cpk-gauge-box">
      <div class="kpi-label" style="margin-bottom:4px;">${summary.orientation==='high' ? '하한 중심 품질지수' : summary.orientation==='low' ? '상한 중심 품질지수' : 'CPK 지수'}</div>
      <div class="cpk-big ${grade.cls}">${summary.cpk!==null? summary.cpk.toFixed(2) : '—'}</div>
      <div class="cpk-mode-badge ${summary.orientation==='high' ? 'higher' : summary.orientation==='low' ? 'lower' : 'standard'}">${summary.modeLabel}</div>
      <div class="cpk-grade" style="background:${grade.cls==='good'?'var(--green-soft)':grade.cls==='warn'?'var(--amber-soft)':'var(--red-soft)'}; color:${grade.cls==='good'?'var(--green)':grade.cls==='warn'?'#9A6B1F':'var(--red)'};">${grade.label}</div>
      <div class="cpk-stats">
        <div class="cpk-stat"><div class="lbl">${summary.metricName}</div><div class="val">${summary.cpk!==null?summary.cpk.toFixed(2):'—'}</div></div>
        <div class="cpk-stat"><div class="lbl">CP</div><div class="val">${summary.cp!==null?summary.cp.toFixed(2):'—'}</div></div>
        <div class="cpk-stat"><div class="lbl">표본수 N</div><div class="val">${summary.n}</div></div>
        <div class="cpk-stat"><div class="lbl">평균</div><div class="val">${summary.m??'—'}</div></div>
        <div class="cpk-stat"><div class="lbl">표준편차σ</div><div class="val">${summary.sd??'—'}</div></div>
      </div>
      <div class="h-sub" style="margin-top:10px; color:var(--gauge-grey);">${summary.modeNote}</div>
      <div style="margin-top:14px;">${renderCpkSvg(summary)}</div>
    </div>

    <div class="panel" style="margin-bottom:0;">
      <div class="panel-head">
        <h3>측정 데이터 입력</h3>
        <div class="input-mode-toggle">
          <button class="imt-btn ${state.cpkInputMode==='raw'?'active':''}" data-cpk-mode="raw">개별 측정값</button>
          <button class="imt-btn ${state.cpkInputMode==='stats'?'active':''}" data-cpk-mode="stats">통계값 직접입력</button>
        </div>
      </div>
      <div class="panel-body">
        ${state.cpkInputMode==='raw' ? renderCpkRawInput(cd) : renderCpkStatsInput(cd)}
      </div>
    </div>
  </div>`;
}

function renderCpkSvg(summary){
  const w=240, h=110;
  if(summary.m===null || summary.sd===null || summary.sd===0){
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><text x="${w/2}" y="${h/2}" text-anchor="middle" fill="#9CA3AF" font-size="11" font-family="Inter">데이터 부족</text></svg>`;
  }
  const usl = summary.usl, lsl = summary.lsl, m = summary.m, sd = summary.sd;
  const lo = Math.min(lsl??m-4*sd, m-4*sd);
  const hi = Math.max(usl??m+4*sd, m+4*sd);
  const range = hi-lo;
  const xPos = v => 10 + ((v-lo)/range)*(w-20);
  const pts = [];
  for(let i=0;i<=60;i++){
    const x = lo + (range*i/60);
    const z = (x-m)/sd;
    const y = Math.exp(-0.5*z*z);
    pts.push([xPos(x), 95 - y*75]);
  }
  const path = 'M ' + pts.map(p=>p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' L ');
  const baseline = 95;
  let specLines = '';
  if(usl!==null && usl!==undefined){
    const x = xPos(usl);
    specLines += `<line x1="${x}" y1="15" x2="${x}" y2="${baseline}" stroke="#C2410C" stroke-width="1.5" stroke-dasharray="3,2"/><text x="${x}" y="10" text-anchor="middle" font-size="9" fill="#C2410C" font-family="JetBrains Mono">USL</text>`;
  }
  if(lsl!==null && lsl!==undefined){
    const x = xPos(lsl);
    specLines += `<line x1="${x}" y1="15" x2="${x}" y2="${baseline}" stroke="#C2410C" stroke-width="1.5" stroke-dasharray="3,2"/><text x="${x}" y="10" text-anchor="middle" font-size="9" fill="#C2410C" font-family="JetBrains Mono">LSL</text>`;
  }
  const mx = xPos(m);
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <line x1="10" y1="${baseline}" x2="${w-10}" y2="${baseline}" stroke="#E4E1D8" stroke-width="1"/>
    <path d="${path}" fill="none" stroke="#2B5C8A" stroke-width="2"/>
    <line x1="${mx}" y1="20" x2="${mx}" y2="${baseline}" stroke="#2B5C8A" stroke-width="1" stroke-dasharray="2,2" opacity="0.5"/>
    ${specLines}
  </svg>`;
}

function renderCpkRawInput(cd){
  const raw = cd.raw || [];
  return `
  <div class="field" style="margin-bottom:12px;">
    <label>측정값 입력 (1개씩 기록)</label>
    <input type="number" step="any" id="cpk-raw-single" class="mono" placeholder="예: 10.02">
    <div class="hint">값 입력 후 Enter 키 또는 "기록" 버튼을 누르세요.</div>
  </div>
  <div style="display:flex; gap:8px; align-items:center;">
    <button class="btn btn-sm" id="btn-add-raw-one">기록</button>
    ${raw.length>0 ? `<button class="btn btn-sm" id="btn-clear-all-raw" style="color:var(--red); border-color:var(--red);">전체삭제</button>` : ''}
  </div>
  <div style="margin-top:14px; max-height:360px; overflow-y:auto;">
    <table class="data-table">
      <thead><tr><th>#</th><th>측정값</th><th></th></tr></thead>
      <tbody id="cpk-raw-tbody">
      ${raw.map((v,i)=>{
        const out = (cd.usl!==null && cd.usl!=='' && v>Number(cd.usl)) || (cd.lsl!==null && cd.lsl!=='' && v<Number(cd.lsl));
        return `<tr><td>${i+1}</td><td class="${out?'spec-out':''}">${v}</td><td class="del-cell" data-del-raw="${i}">삭제</td></tr>`;
      }).join('')}
      </tbody>
    </table>
    ${raw.length===0? '<div class="mini-empty"><p>측정값을 입력하세요. (CPK 계산에는 최소 2개 이상 필요, 신뢰도를 위해 25개 이상 권장)</p></div>':''}
  </div>`;
}

function renderCpkStatsInput(cd){
  return `
  <div class="form-grid cols-3">
    <div class="field">
      <label>평균 (X̄)</label>
      <input type="number" step="any" id="cpk-stats-mean" class="mono" value="${cd.statsMean??''}" placeholder="예: 10.01">
    </div>
    <div class="field">
      <label>표준편차 (σ)</label>
      <input type="number" step="any" id="cpk-stats-sd" class="mono" value="${cd.statsSd??''}" placeholder="예: 0.08">
    </div>
    <div class="field">
      <label>표본수 (N)</label>
      <input type="number" id="cpk-stats-n" class="mono" value="${cd.statsN??''}" placeholder="예: 30">
    </div>
  </div>
  <button class="btn btn-sm" id="btn-save-stats" style="margin-top:14px;">통계값 저장</button>
  <p style="font-size:11px; color:var(--gauge-grey); margin-top:10px; line-height:1.6;">게이지/측정기에서 이미 산출된 평균·표준편차를 직접 입력하는 방식입니다. USL/LSL은 위 "측정 항목 / 규격 설정"에서 입력하세요.</p>`;
}

// ---------- HISTORY TAB ----------
function renderHistoryTab(proj){
  const defects = proj.defects.filter(d=>Number(d.qty||0) > 0).slice().sort((a,b)=> b.ts - a.ts);
  const ds = defectSummary(proj, null);
  const procRows = processDefectSummaryList(proj);
  const overallRate = projectOverallRate(proj);
  const rrClass = overallRate===null? '' : overallRate>=100?'good':overallRate>=90?'warn':'bad';
  return `
  <div class="kpi-strip cols-6" style="margin-bottom:18px;">
    <div class="kpi-card">
      <div class="kpi-label">전체 RunRate%</div>
      <div class="kpi-value ${rrClass}">${overallRate??'—'}<span class="kpi-unit">%</span></div>
      <div class="kpi-sub">병목 공정 기준</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">목표 수량</div>
      <div class="kpi-value">${ds.targetQty??'—'}<span class="kpi-unit">EA</span></div>
      <div class="kpi-sub">프로젝트 목표</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">누적 생산수량</div>
      <div class="kpi-value">${ds.totalProduced}<span class="kpi-unit">EA</span></div>
      <div class="kpi-sub">진척 ${ds.runProgressPct??'—'}%</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">양품 수량</div>
      <div class="kpi-value good">${ds.goodQty}<span class="kpi-unit">EA</span></div>
      <div class="kpi-sub">수율 ${ds.yieldRate??'—'}%</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">불량 수량</div>
      <div class="kpi-value bad">${ds.totalDefect}<span class="kpi-unit">EA</span></div>
      <div class="kpi-sub">불량률 ${ds.defectRate??'—'}%</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">PPM</div>
      <div class="kpi-value">${ds.ppm??'—'}</div>
      <div class="kpi-sub">백만개당 불량</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h3>공정별 품질 상세</h3>
      <span class="ph-tag">${procRows.length}개 공정</span>
    </div>
    <div class="panel-body" style="padding:0; overflow-x:auto; -webkit-overflow-scrolling:touch;">
      ${procRows.length===0 ? `<div class="mini-empty"><p>등록된 공정이 없습니다.</p></div>` : `
      <table class="data-table">
        <thead><tr><th>공정</th><th>생산수량(EA)</th><th>양품수량(EA)</th><th>불량수량(EA)</th><th>불량률(%)</th><th>수율(%)</th><th>Rate%(RunRate)</th><th>목표대비 진척률(%)</th></tr></thead>
        <tbody>
        ${procRows.map(r=>`<tr>
          <td>${r.seq}. ${escapeHtml(r.name)}</td>
          <td>${r.produced}</td>
          <td>${r.good}</td>
          <td>${r.defect}</td>
          <td>${r.defectRate??'—'}</td>
          <td>${r.yieldRate??'—'}</td>
          <td>${r.ratePct??'—'}</td>
          <td>${r.progressPct===null ? '—' : `<span class="rate-pill ${r.progressPct>=100 ? 'chip-green' : r.progressPct>=80 ? 'chip-amber' : 'chip-red'}">${r.progressPct}%</span>`}</td>
        </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h3>불량 이력</h3>
      <div style="display:flex; gap:8px;">
        <button class="btn btn-sm" id="btn-export-defects">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          CSV
        </button>
        <button class="btn btn-primary btn-sm" id="btn-open-defect-modal">+ 결과 기록</button>
      </div>
    </div>
    <div class="panel-body" style="padding:0;">
      ${defects.length===0? `<div class="mini-empty"><div class="ico">✓</div><p>표시할 불량 기록이 없습니다.</p></div>` : defects.map(d=>{
        const proc = proj.processes.find(p=>p.id===d.processId);
        return `<div class="history-row">
          <div>
            <div class="h-main">${escapeHtml(d.type||'미분류')} <span class="mono" style="color:var(--red); font-weight:700;">×${d.qty}</span></div>
            <div class="h-sub">${proc?escapeHtml(proc.name):'공정 미지정'} · ${fmtDate(d.ts)}${d.total?' · 총생산 '+d.total:''}${d.remark?' · '+escapeHtml(d.remark):''}</div>
          </div>
          <div class="h-actions">
            <div class="icon-mini" data-edit-defect="${d.id}" title="수정">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.85 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5z"/></svg>
            </div>
            <div class="icon-mini" data-del-defect="${d.id}" title="삭제">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ===================================================================
// CSV EXPORT
// ===================================================================
function downloadCSV(filename, rows){
  const BOM = '\uFEFF'; // 한글 깨짐 방지
  const csv = BOM + rows.map(row => row.map(cell=>{
    const s = (cell===null||cell===undefined)?'':String(cell);
    if(/[",\n]/.test(s)) return '"'+s.replace(/"/g,'""')+'"';
    return s;
  }).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('CSV 파일이 다운로드되었습니다', 'success');
}

function csvReportHeader(title, proj, processName=''){
  const rows = [];
  rows.push([title]);
  rows.push(['생성시각', fmtDate(Date.now())]);
  rows.push(['품번', proj.pn, '품명', proj.pname]);
  if(processName) rows.push(['공정', processName]);
  rows.push([]);
  return rows;
}

function csvSection(rows, title){
  rows.push([`[${title}]`]);
}

function exportCyclesCSV(proj, proc){
  const cycles = getCycles(proj, proc.id);
  const rows = csvReportHeader('RUN&RATE 사이클타임 분석 리포트', proj, proc.name);
  csvSection(rows, '요약');
  rows.push(['목표 C/T(초)', proc.targetCt??'—']);
  const r = computeRate(proj, proc.id);
  rows.push(['평균 C/T(초)', r.avgCt??'—', 'UPH(EA/h)', r.uph??'—', 'Rate(%)', r.ratePct??'—']);
  rows.push(['최소 C/T(초)', r.minCt??'—', '최대 C/T(초)', r.maxCt??'—', '표준편차', r.stdCt??'—']);
  rows.push(['측정건수', r.n]);
  rows.push([]);
  csvSection(rows, '측정 상세');
  rows.push(['No','측정시각','사이클타임(초)']);
  cycles.forEach((c,i)=> rows.push([i+1, fmtDate(c.ts), c.ct]));
  rows.push([]);
  rows.push(['비고', 'Rate(%) = 목표 C/T ÷ 실측 평균 C/T × 100']);
  downloadCSV(`RunRate_${proj.pn}_${proc.name}_사이클타임_${fmtDateShort(nowISO())}.csv`, rows);
}

function exportAllCyclesCSV(proj){
  const rows = csvReportHeader('RUN&RATE 전체 공정 사이클타임 리포트', proj);
  csvSection(rows, '공정별 측정 상세');
  rows.push(['공정','No','측정시각','사이클타임(초)']);
  proj.processes.slice().sort((a,b)=>a.seq-b.seq).forEach(p=>{
    const cycles = getCycles(proj, p.id);
    if(cycles.length===0){
      rows.push([`${p.seq}. ${p.name}`,'—','—','—']);
      return;
    }
    cycles.forEach((c,i)=> rows.push([`${p.seq}. ${p.name}`, i+1, fmtDate(c.ts), c.ct]));
  });
  rows.push([]);
  csvSection(rows, '공정별 요약');
  rows.push(['공정','목표 C/T(초)','평균 C/T(초)','UPH','Rate(%)','측정건수']);
  proj.processes.slice().sort((a,b)=>a.seq-b.seq).forEach(p=>{
    const r = computeRate(proj, p.id);
    rows.push([`${p.seq}. ${p.name}`, p.targetCt??'—', r.avgCt??'—', r.uph??'—', r.ratePct??'—', r.n]);
  });
  downloadCSV(`RunRate_${proj.pn}_전체공정_사이클타임_${fmtDateShort(nowISO())}.csv`, rows);
}

function exportCpkCSV(proj, proc){
  const cd = proj.cpkData[proc.id] || {};
  const summary = computeCpkSummary(proj, proc.id);
  const rows = csvReportHeader('RUN&RATE CPK 품질 리포트', proj, proc.name);
  csvSection(rows, '규격 및 요약');
  rows.push(['측정항목', cd.itemName||'—', '단위', cd.unit||'—']);
  rows.push(['USL', cd.usl??'—', 'LSL', cd.lsl??'—', 'Target', cd.target??'—']);
  rows.push(['입력방식', cd.mode==='raw'?'개별측정값':'통계값 직접입력']);
  rows.push(['해석모드', summary.orientation==='high' ? '높음 중심 (Cpl 중심)' : summary.orientation==='low' ? '낮음 중심 (Cpu 중심)' : '중간 중심 (CPK 중심)']);
  rows.push(['평균', summary.m??'—', '표준편차', summary.sd??'—', '표본수', summary.n]);
  rows.push([summary.metricName, summary.cpk??'—', 'CP', summary.cp??'—', '판정', cpkGrade(summary.cpk).label]);
  rows.push([]);
  if(cd.mode==='raw'){
    csvSection(rows, '개별 측정값');
    rows.push(['No','측정값']);
    (cd.raw||[]).forEach((v,i)=> rows.push([i+1, v]));
    rows.push([]);
  }
  rows.push(['비고', '권장 표본수: 25개 이상']);
  downloadCSV(`RunRate_${proj.pn}_${proc.name}_CPK_${fmtDateShort(nowISO())}.csv`, rows);
}

function exportDefectsCSV(proj){
  const rows = csvReportHeader('RUN&RATE 결과 이력 리포트', proj);
  const ds = defectSummary(proj,null);
  csvSection(rows, '요약');
  rows.push(['목표수량(EA)', proj.targetQty??'—', '누적생산수량(EA)', ds.totalProduced]);
  rows.push(['양품수량(EA)', ds.goodQty, '불량수량(EA)', ds.totalDefect]);
  rows.push(['불량률(%)', ds.defectRate??'—', '수율(%)', ds.yieldRate??'—', 'PPM', ds.ppm??'—']);
  rows.push([]);

  const procRows = processDefectSummaryList(proj);
  csvSection(rows, '공정별 품질 상세');
  rows.push(['공정','생산수량(EA)','양품수량(EA)','불량수량(EA)','불량률(%)','수율(%)','RunRate(%)','목표대비 진척률(%)']);
  procRows.forEach(r=> rows.push([
    `${r.seq}. ${r.name}`,
    r.produced,
    r.good,
    r.defect,
    r.defectRate??'—',
    r.yieldRate??'—',
    r.ratePct??'—',
    r.progressPct??'—'
  ]));
  rows.push([]);

  csvSection(rows, '불량 이력 상세');
  rows.push(['No','기록시각','공정','불량유형','불량수량','총생산수량','비고']);
  proj.defects.slice().sort((a,b)=>a.ts-b.ts).forEach((d,i)=>{
    const proc = proj.processes.find(p=>p.id===d.processId);
    rows.push([i+1, fmtDate(d.ts), proc?proc.name:'', d.type, d.qty, d.total??'', d.remark??'']);
  });
  rows.push([]);
  rows.push(['비고', '공정별 품질 상세는 불량 기록의 총생산수량(total) 기준으로 계산됩니다.']);
  downloadCSV(`RunRate_${proj.pn}_결과이력_${fmtDateShort(nowISO())}.csv`, rows);
}

function exportOnePageSummaryCSV(proj){
  const rows = csvReportHeader('RUN&RATE 한장 요약 리포트', proj);
  const ds = defectSummary(proj, null);
  const overallRate = projectOverallRate(proj);
  const bottleneck = findBottleneck(proj);
  let cpkWorst = null;
  proj.processes.forEach(p=>{
    const c = computeCpkSummary(proj, p.id);
    if(c.cpk!==null && (cpkWorst===null || c.cpk < cpkWorst)) cpkWorst = c.cpk;
  });

  csvSection(rows, '요약 KPI');
  rows.push(['전체 RunRate(%)', overallRate??'—']);
  rows.push(['병목 공정', bottleneck?bottleneck.name:'—']);
  rows.push(['목표 수량(EA)', proj.targetQty??'—', '누적 생산(EA)', ds.totalProduced]);
  rows.push(['양품(EA)', ds.goodQty, '불량(EA)', ds.totalDefect]);
  rows.push(['불량률(%)', ds.defectRate??'—', '수율(%)', ds.yieldRate??'—']);
  rows.push(['PPM', ds.ppm??'—', '최저 CPK', cpkWorst??'—']);
  rows.push([]);

  const procRows = processDefectSummaryList(proj).slice(0, 5);
  csvSection(rows, '공정별 핵심 TOP5');
  rows.push(['공정','RunRate(%)','진척률(%)','생산(EA)','불량(EA)']);
  procRows.forEach(r=> rows.push([
    `${r.seq}. ${r.name}`,
    r.ratePct??'—',
    r.progressPct??'—',
    r.produced,
    r.defect
  ]));

  rows.push([]);
  rows.push(['비고', '상세 원본 데이터는 각 탭의 CSV 내보내기를 사용하세요.']);
  downloadCSV(`RunRate_${proj.pn}_한장요약_${fmtDateShort(nowISO())}.csv`, rows);
}

async function exportFullBackupJSON(){
  toast('백업 데이터를 모으는 중...', '');
  try{
    const projSnap = await fb.getDocsCompat(projectsCol());
    const fullProjects = await Promise.all(projSnap.docs.map(async (pd)=>{
      const pid = pd.id;
      const [procSnap, cycSnap, defSnap, cpkSnap] = await Promise.all([
        fb.getDocsCompat(processesCol(pid)),
        fb.getDocsCompat(cyclesCol(pid)),
        fb.getDocsCompat(defectsCol(pid)),
        fb.getDocsCompat(cpkCol(pid))
      ]);
      const cycles = {};
      cycSnap.docs.forEach(d=>{
        const c = d.data();
        if(!cycles[c.processId]) cycles[c.processId]=[];
        cycles[c.processId].push({ id:d.id, ts:c.ts, ct:c.ct });
      });
      const cpkData = {};
      cpkSnap.docs.forEach(d=>{ cpkData[d.id] = d.data(); });
      return {
        id: pid,
        ...pd.data(),
        processes: procSnap.docs.map(d=>({ id:d.id, ...d.data() })),
        cycles,
        defects: defSnap.docs.map(d=>({ id:d.id, ...d.data() })),
        cpkData
      };
    }));
    const blob = new Blob([JSON.stringify({ projects: fullProjects }, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `RunRate_백업_${fmtDateShort(nowISO())}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('전체 백업 파일이 다운로드되었습니다', 'success');
  }catch(e){
    console.error(e);
    toast('백업 실패: ' + e.message, 'error');
  }
}

// ===================================================================
// EVENT HANDLERS
// ===================================================================

function openModal(id){ document.getElementById(id).style.display='flex'; }
function closeModal(id){ document.getElementById(id).style.display='none'; }

let editingDefectId = null;
function openDefectModal(proj, defect){
  const sel = document.getElementById('defect-proc');
  sel.innerHTML = proj.processes.slice().sort((a,b)=>a.seq-b.seq).map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  const title = document.getElementById('modal-defect-title');
  const saveBtn = document.getElementById('btn-save-defect');
  if(defect){
    editingDefectId = defect.id;
    if(title) title.textContent = '결과 기록 수정';
    if(saveBtn) saveBtn.textContent = '수정 저장';
    sel.value = defect.processId || '';
    document.getElementById('defect-type').value = defect.type || '';
    document.getElementById('defect-qty').value = defect.qty ?? 0;
    document.getElementById('defect-total').value = defect.total ?? '';
    document.getElementById('defect-remark').value = defect.remark || '';
  } else {
    editingDefectId = null;
    if(title) title.textContent = 'Run&Rate 기록 추가';
    if(saveBtn) saveBtn.textContent = '결과 저장';
    document.getElementById('defect-type').value='';
    document.getElementById('defect-qty').value=0;
    document.getElementById('defect-total').value='';
    document.getElementById('defect-remark').value='';
  }
  openModal('modal-defect');
}

document.querySelectorAll('[data-close]').forEach(btn=>{
  btn.addEventListener('click', ()=> closeModal(btn.dataset.close));
});
document.querySelectorAll('.modal-overlay').forEach(ov=>{
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.style.display='none'; });
});

// ---- New project ----
let editingProjectId = null;
document.getElementById('btn-new-project').addEventListener('click', ()=>openProjectModal());
document.getElementById('btn-empty-new-project').addEventListener('click', ()=>openProjectModal());
const btnEditProject = document.getElementById('btn-edit-project');
if(btnEditProject) btnEditProject.addEventListener('click', ()=>openProjectModal(activeProject()));

function openProjectModal(proj){
  editingProjectId = proj? proj.id : null;
  document.getElementById('modal-project-title').textContent = proj? '프로젝트 수정' : '신규 프로젝트';
  document.getElementById('inp-pn').value = proj? proj.pn : '';
  document.getElementById('inp-pname').value = proj? proj.pname : '';
  document.getElementById('inp-target-uph').value = proj? (proj.targetUph??'') : '';
  document.getElementById('inp-target-qty').value = proj? (proj.targetQty??'') : '';
  document.getElementById('inp-remark').value = proj? (proj.remark??'') : '';
  openModal('modal-project');
}

document.getElementById('btn-save-project').addEventListener('click', async ()=>{
  const pn = document.getElementById('inp-pn').value.trim();
  const pname = document.getElementById('inp-pname').value.trim();
  if(!pn || !pname){ toast('품번과 품명은 필수입니다', 'error'); return; }
  const targetUph = document.getElementById('inp-target-uph').value;
  const targetQty = document.getElementById('inp-target-qty').value;
  const remark = document.getElementById('inp-remark').value.trim();
  const btn = document.getElementById('btn-save-project');
  btn.disabled = true;

  try{
    if(editingProjectId){
      await fb.updateDoc(fb.doc(fb.db, 'projects', editingProjectId), {
        pn, pname,
        targetUph: targetUph? Number(targetUph): null,
        targetQty: targetQty? Number(targetQty): null,
        remark
      });
      toast('프로젝트가 수정되었습니다', 'success');
    } else {
      const docRef = await fb.addDoc(projectsCol(), newProjectData({pn, pname, targetUph: targetUph?Number(targetUph):null, targetQty: targetQty?Number(targetQty):null, remark}));
      state.activeProjectId = docRef.id;
      toast('신규 프로젝트가 생성되었습니다', 'success');
    }
    closeModal('modal-project');
    if(state.activeProjectId){
      selectProject(state.activeProjectId);
    }
  }catch(e){
    console.error(e);
    toast('저장 실패: ' + e.message, 'error');
  }finally{
    btn.disabled = false;
  }
});

const btnDeleteProject = document.getElementById('btn-delete-project');
if(btnDeleteProject) btnDeleteProject.addEventListener('click', async ()=>{
  const proj = activeProject();
  if(!proj) return;
  if(!confirm(`품번 "${proj.pn}" 프로젝트를 삭제하시겠습니까?\n모든 공정/측정 데이터가 함께 삭제됩니다.`)) return;
  try{
    await deleteProjectDeep(proj.id);
    state.activeProjectId = null;
    document.getElementById('proj-view').style.display='none';
    document.getElementById('main-empty').style.display='flex';
    toast('프로젝트가 삭제되었습니다');
  }catch(e){
    console.error(e);
    toast('삭제 실패: ' + e.message, 'error');
  }
});

// 프로젝트 + 모든 서브컬렉션 삭제 (Firestore는 상위문서 삭제해도 서브컬렉션이 자동삭제 안 되므로 직접 순회)
async function deleteProjectDeep(pid){
  const batch = fb.writeBatch(fb.db);
  const [procSnap, cycSnap, defSnap, cpkSnap] = await Promise.all([
    fb.getDocsCompat(processesCol(pid)),
    fb.getDocsCompat(cyclesCol(pid)),
    fb.getDocsCompat(defectsCol(pid)),
    fb.getDocsCompat(cpkCol(pid))
  ]);
  [procSnap, cycSnap, defSnap, cpkSnap].forEach(snap=>{
    snap.docs.forEach(d=> batch.delete(d.ref));
  });
  batch.delete(fb.doc(fb.db, 'projects', pid));
  await batch.commit();
}

// 공정 1개 + 그 공정에 연결된 cycles/defects/cpkData 문서 삭제
async function deleteProcessDeep(pid, processId){
  const batch = fb.writeBatch(fb.db);
  const [cycSnap, defSnap] = await Promise.all([
    fb.getDocsCompat(cyclesCol(pid)),
    fb.getDocsCompat(defectsCol(pid))
  ]);
  cycSnap.docs.filter(d=> d.data().processId===processId).forEach(d=> batch.delete(d.ref));
  defSnap.docs.filter(d=> d.data().processId===processId).forEach(d=> batch.delete(d.ref));
  batch.delete(fb.doc(cpkCol(pid), processId));
  batch.delete(fb.doc(processesCol(pid), processId));
  await batch.commit();
}

// ---- Process modal (multi-row) ----
document.getElementById('btn-add-proc-row').addEventListener('click', ()=> addProcRow());
function addProcRow(data){
  const list = document.getElementById('proc-input-list');
  const idx = list.children.length + 1;
  const row = document.createElement('div');
  row.className = 'proc-input-row';
  row.innerHTML = `
    <div class="proc-order">${idx}</div>
    <input type="text" placeholder="공정명 (예: 1차 압입)" class="proc-name-inp" value="${data?escapeHtml(data.name):''}">
    <input type="text" placeholder="설비명 (선택)" class="proc-eq-inp" style="max-width:130px;" value="${data?escapeHtml(data.eq||''):''}">
    <input type="number" step="any" placeholder="목표C/T(초)" class="proc-ct-inp mono" style="max-width:110px;" value="${data&&data.targetCt?data.targetCt:''}">
    <input type="number" step="0.5" min="0.5" placeholder="인원(명)" class="proc-manpower-inp mono" style="max-width:90px;">
    <div class="icon-mini btn-remove-row" title="삭제">&times;</div>
  `;
  const mpInp = row.querySelector('.proc-manpower-inp');
  if(data && data.manpower != null) mpInp.value = data.manpower;
  else mpInp.value = '';
  row.querySelector('.btn-remove-row').addEventListener('click', ()=>{ row.remove(); renumberProcRows(); });
  list.appendChild(row);
}
function renumberProcRows(){
  document.querySelectorAll('#proc-input-list .proc-order').forEach((el,i)=> el.textContent = i+1);
}

function openProcessModal(){
  const proj = activeProject();
  const list = document.getElementById('proc-input-list');
  list.innerHTML = '';
  if(proj.processes.length){
    proj.processes.slice().sort((a,b)=>a.seq-b.seq).forEach(p=> addProcRow(p));
  } else {
    addProcRow(); addProcRow(); addProcRow();
  }
  openModal('modal-process');
}

document.getElementById('btn-save-process').addEventListener('click', async ()=>{
  const proj = activeProject();
  if(!proj) return;
  const rows = document.querySelectorAll('#proc-input-list .proc-input-row');
  const names = [];
  rows.forEach(r=>{
    const name = r.querySelector('.proc-name-inp').value.trim();
    if(!name) return;
    names.push({
      name,
      eq: r.querySelector('.proc-eq-inp').value.trim(),
      targetCt: r.querySelector('.proc-ct-inp').value ? Number(r.querySelector('.proc-ct-inp').value) : null,
      manpower: r.querySelector('.proc-manpower-inp').value ? Number(r.querySelector('.proc-manpower-inp').value) : 1
    });
  });
  if(names.length===0){ toast('최소 1개 이상의 공정을 입력하세요', 'error'); return; }

  const btn = document.getElementById('btn-save-process');
  btn.disabled = true;
  try{
    // 기존 공정 중 이름이 같은 것은 문서ID 보존 (측정 데이터 유지 — updateDoc), 신규는 새 문서(addDoc)
    // 목록에서 빠진 기존 공정은 공정 문서만 삭제(연결된 cycles/defects/cpkData는 남겨두고,
    // 같은 이름으로 재등록하면 다시 매칭되도록 함 — 측정데이터 보존 우선)
    const existing = proj.processes.slice();
    const usedIds = new Set();
    const batch = fb.writeBatch(fb.db);

    names.forEach((n, i)=>{
      const match = existing.find(e=> e.name===n.name && !usedIds.has(e.id));
      if(match){
        usedIds.add(match.id);
        batch.update(fb.doc(processesCol(proj.id), match.id), { seq:i+1, name:n.name, eq:n.eq, targetCt:n.targetCt, manpower:n.manpower });
      } else {
        const newRef = fb.doc(processesCol(proj.id)); // 자동 ID 생성
        batch.set(newRef, { seq:i+1, name:n.name, eq:n.eq, targetCt:n.targetCt, manpower:n.manpower });
      }
    });
    // 목록에서 완전히 빠진 기존 공정 문서는 삭제 (측정 데이터는 processId로 남아있으나 공정삭제와 동일플로우 사용)
    existing.filter(e=>!usedIds.has(e.id)).forEach(e=>{
      batch.delete(fb.doc(processesCol(proj.id), e.id));
    });

    await batch.commit();
    closeModal('modal-process');
    toast('공정이 저장되었습니다', 'success');
  }catch(e){
    console.error(e);
    toast('저장 실패: ' + e.message, 'error');
  }finally{
    btn.disabled = false;
  }
});

// ---- Tabs ----
document.getElementById('tabs').addEventListener('click', e=>{
  const tab = e.target.closest('.tab');
  if(tab) setTab(tab.dataset.tab);
});

// ---- Content-area dynamic events ----
function attachContentEvents(proj){
  // overview: jump to analysis
  document.querySelectorAll('[data-goto-process]').forEach(el=>{
    el.addEventListener('click', ()=>{ state.activeProcessId = el.dataset.gotoProcess; setTab('analysis'); });
  });

  const openProcBtn2 = document.getElementById('btn-open-process-modal');
  if(openProcBtn2) openProcBtn2.addEventListener('click', openProcessModal);

  document.querySelectorAll('[data-del-process]').forEach(el=>{
    el.addEventListener('click', async e=>{
      e.stopPropagation();
      const id = el.dataset.delProcess;
      if(!confirm('이 공정을 삭제하시겠습니까? 관련 측정 데이터도 함께 삭제됩니다.')) return;
      try{
        await deleteProcessDeep(proj.id, id);
        toast('공정이 삭제되었습니다');
      }catch(err){
        console.error(err);
        toast('삭제 실패: ' + err.message, 'error');
      }
    });
  });

  // analysis tab
  document.querySelectorAll('[data-select-process]').forEach(el=>{
    el.addEventListener('click', ()=>{ state.activeProcessId = el.dataset.selectProcess; renderContent(); });
  });
  const timerBtn = document.getElementById('btn-timer-toggle');
  if(timerBtn) timerBtn.addEventListener('click', ()=> toggleTimer(proj));
  const lapBtn = document.getElementById('btn-timer-lap');
  if(lapBtn) lapBtn.addEventListener('click', ()=> recordLap(proj));
  const manualAddBtn = document.getElementById('btn-manual-ct-add');
  if(manualAddBtn) manualAddBtn.addEventListener('click', ()=>{
    const val = Number(document.getElementById('manual-ct-input').value);
    if(!val || val<=0){ toast('유효한 사이클타임을 입력하세요', 'error'); return; }
    addCycle(proj.id, state.activeProcessId, val);
    document.getElementById('manual-ct-input').value = '';
  });
  const manualInput = document.getElementById('manual-ct-input');
  if(manualInput) manualInput.addEventListener('keydown', e=>{ if(e.key==='Enter') manualAddBtn.click(); });
  document.querySelectorAll('[data-del-cycle]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      const id = el.dataset.delCycle;
      try{
        await fb.deleteDoc(fb.doc(cyclesCol(proj.id), id));
      }catch(e){ toast('삭제 실패: '+e.message, 'error'); }
    });
  });
  const expCyclesBtn = document.getElementById('btn-export-cycles');
  if(expCyclesBtn) expCyclesBtn.addEventListener('click', ()=>{
    if(state.activeProcessId === '__all__'){
      exportAllCyclesCSV(proj);
      return;
    }
    const proc = proj.processes.find(p=>p.id===state.activeProcessId);
    if(proc) exportCyclesCSV(proj, proc);
  });

  // cpk tab
  document.querySelectorAll('[data-select-cpk-process]').forEach(el=>{
    el.addEventListener('click', ()=>{ state.cpkProcessId = el.dataset.selectCpkProcess; renderContent(); });
  });
  document.querySelectorAll('[data-cpk-mode]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      state.cpkInputMode = el.dataset.cpkMode;
      try{
        await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), { mode: state.cpkInputMode }, { merge: true });
      }catch(e){ toast('저장 실패: '+e.message, 'error'); }
      renderContent();
    });
  });
  document.querySelectorAll('[data-cpk-orientation]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      const analysisMode = el.dataset.cpkOrientation;
      try{
        const cd = proj.cpkData[state.cpkProcessId];
        if(cd) cd.analysisMode = analysisMode;
        await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), { analysisMode }, { merge: true });
        toast(analysisMode === 'high' ? '높음 중심으로 설정했습니다' : (analysisMode === 'low' ? '낮음 중심으로 설정했습니다' : '중간 중심으로 설정했습니다'), 'success');
      }catch(e){
        toast('저장 실패: '+e.message, 'error');
        return;
      }
      renderContent();
    });
  });
  const saveSpecBtn = document.getElementById('btn-save-spec');
  if(saveSpecBtn) saveSpecBtn.addEventListener('click', async ()=>{
    const itemName = document.getElementById('cpk-item-name').value.trim();
    const unit = document.getElementById('cpk-unit').value.trim();
    const t = document.getElementById('cpk-target').value;
    const u = document.getElementById('cpk-usl').value;
    const l = document.getElementById('cpk-lsl').value;
    try{
      await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), {
        itemName, unit,
        target: t===''? null : Number(t),
        usl: u===''? null : Number(u),
        lsl: l===''? null : Number(l),
        analysisMode: getCpkOrientation(proj.cpkData[state.cpkProcessId]),
        mode: state.cpkInputMode
      }, { merge: true });
      const cd = proj.cpkData[state.cpkProcessId];
      if(cd){
        cd.itemName = itemName;
        cd.unit = unit;
        cd.target = t===''? null : Number(t);
        cd.usl = u===''? null : Number(u);
        cd.lsl = l===''? null : Number(l);
        cd.analysisMode = getCpkOrientation(cd);
      }
      toast('규격이 저장되었습니다', 'success');
    }catch(e){ toast('저장 실패: '+e.message, 'error'); }
  });
  const clearAllBtn = document.getElementById('btn-clear-all-raw');
  if(clearAllBtn) clearAllBtn.addEventListener('click', async ()=>{
    if(!confirm('측정값 전체를 삭제하시겠습니까?')) return;
    try{
      const cd = proj.cpkData[state.cpkProcessId];
      await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), {
        raw: [],
        analysisMode: getCpkOrientation(cd),
        mode: state.cpkInputMode
      }, { merge: true });
      toast('측정값 전체가 삭제되었습니다', 'success');
    }catch(e){ toast('삭제 실패: '+e.message, 'error'); }
  });
  const addOneBtn = document.getElementById('btn-add-raw-one');
  if(addOneBtn) addOneBtn.addEventListener('click', async ()=>{
    const input = document.getElementById('cpk-raw-single');
    const val = Number(input.value);
    if(!input.value || isNaN(val)){ toast('유효한 측정값을 입력하세요', 'error'); return; }
    try{
      // 배열을 직접 읽어서 추가 — 중복값도 허용
      const cd = proj.cpkData[state.cpkProcessId];
      const newRaw = (cd.raw || []).concat([val]);
      await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), {
        raw: newRaw,
        analysisMode: getCpkOrientation(cd),
        mode: state.cpkInputMode
      }, { merge: true });
      input.value = '';
      toast(`측정값 #${newRaw.length} 기록되었습니다`, 'success');
      // 렌더링 완료 후 포커스 설정 — requestAnimationFrame으로 렌더링 사이클 대기
      requestAnimationFrame(()=>{
        requestAnimationFrame(()=>{
          document.getElementById('cpk-raw-single')?.focus();
        });
      });
    }catch(e){ toast('추가 실패: '+e.message, 'error'); }
  });
  const rawSingleInput = document.getElementById('cpk-raw-single');
  if(rawSingleInput) rawSingleInput.addEventListener('keydown', async (e)=>{
    if(e.key==='Enter'){
      e.preventDefault();
      const val = Number(rawSingleInput.value);
      if(!rawSingleInput.value || isNaN(val)){ toast('유효한 측정값을 입력하세요', 'error'); return; }
      try{
        // 배열을 직접 읽어서 추가 — 중복값도 허용
        const cd = proj.cpkData[state.cpkProcessId];
        const newRaw = (cd.raw || []).concat([val]);
        await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), {
          raw: newRaw,
          analysisMode: getCpkOrientation(cd),
          mode: state.cpkInputMode
        }, { merge: true });
        rawSingleInput.value = '';
        toast(`측정값 #${newRaw.length} 기록되었습니다`, 'success');
        // 렌더링 완료 후 포커스 설정 — requestAnimationFrame으로 렌더링 사이클 대기
        requestAnimationFrame(()=>{
          requestAnimationFrame(()=>{
            document.getElementById('cpk-raw-single')?.focus();
          });
        });
      }catch(ex){ toast('추가 실패: '+ex.message, 'error'); }
    }
  });
  document.querySelectorAll('[data-del-raw]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      const idx = Number(el.dataset.delRaw);
      const cd = proj.cpkData[state.cpkProcessId];
      const val = cd.raw[idx];
      try{
        // 동일 값이 여러개면 arrayRemove가 전부 지울 수 있어, 배열 전체를 새로 구성해 setDoc(merge)으로 안전 교체
        const newRaw = cd.raw.slice(); newRaw.splice(idx,1);
        await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), { raw: newRaw }, { merge: true });
      }catch(e){ toast('삭제 실패: '+e.message, 'error'); }
    });
  });
  const saveStatsBtn = document.getElementById('btn-save-stats');
  if(saveStatsBtn) saveStatsBtn.addEventListener('click', async ()=>{
    try{
      await fb.setDoc(fb.doc(cpkCol(proj.id), state.cpkProcessId), {
        statsMean: document.getElementById('cpk-stats-mean').value || null,
        statsSd: document.getElementById('cpk-stats-sd').value || null,
        statsN: document.getElementById('cpk-stats-n').value || null,
        mode: state.cpkInputMode
      }, { merge: true });
      toast('통계값이 저장되었습니다', 'success');
    }catch(e){ toast('저장 실패: '+e.message, 'error'); }
  });
  const expCpkBtn = document.getElementById('btn-export-cpk');
  if(expCpkBtn) expCpkBtn.addEventListener('click', ()=>{
    const proc = proj.processes.find(p=>p.id===state.cpkProcessId);
    exportCpkCSV(proj, proc);
  });

  // history tab
  const openDefectBtn = document.getElementById('btn-open-defect-modal');
  if(openDefectBtn) openDefectBtn.addEventListener('click', ()=> openDefectModal(proj, null));
  document.querySelectorAll('[data-edit-defect]').forEach(el=>{
    el.addEventListener('click', ()=>{
      const d = proj.defects.find(x=>x.id===el.dataset.editDefect);
      if(d) openDefectModal(proj, d);
    });
  });
  document.querySelectorAll('[data-del-defect]').forEach(el=>{
    el.addEventListener('click', async ()=>{
      const id = el.dataset.delDefect;
      try{
        await fb.deleteDoc(fb.doc(defectsCol(proj.id), id));
      }catch(e){ toast('삭제 실패: '+e.message, 'error'); }
    });
  });
  const expDefBtn = document.getElementById('btn-export-defects');
  if(expDefBtn) expDefBtn.addEventListener('click', ()=> exportDefectsCSV(proj));
}

// 타이머 작동 중 사이클 추가/삭제 시 호출 — 분석탭 KPI와 기록테이블만 갱신, 타이머 DOM은 건드리지 않음
function refreshCycleTableOnly(proj){
  if(state.activeTab !== 'analysis') return;
  if(!state.activeProcessId) return;
  const proc = proj.processes.find(p=>p.id===state.activeProcessId);
  if(!proc) return;
  const r = computeRate(proj, proc.id);
  const cap = computeCapacity(proj, proc.id);
  const ctGapSec = (proc.targetCt && r.avgCt!==null) ? round(proc.targetCt - r.avgCt, 2) : null;
  const cycles = getCycles(proj, proc.id).slice().reverse();
  const rateClass = r.ratePct===null?'':r.ratePct>=100?'good':r.ratePct>=90?'warn':'bad';

  const kpiStrip = document.getElementById('analysis-kpi-strip');
  if(kpiStrip){
    kpiStrip.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">평균 사이클타임</div>
      <div class="kpi-value">${r.avgCt!==null?r.avgCt:'—'}<span class="kpi-unit">초</span></div>
      <div class="kpi-sub">Min ${r.minCt??'—'} / Max ${r.maxCt??'—'} / σ ${r.stdCt??'—'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">UPH (시간당 생산량)</div>
      <div class="kpi-value">${r.uph!==null?r.uph:'—'}<span class="kpi-unit">EA/h</span></div>
      <div class="kpi-sub">목표 C/T ${proc.targetCt? proc.targetCt+'초' : '미설정'}</div>
    </div>
    <div class="kpi-card ${rateClass!==''?'status-'+rateClass:''}">
      <div class="kpi-label">Rate %</div>
      <div class="kpi-value ${rateClass}">${r.ratePct!==null?r.ratePct:'—'}<span class="kpi-unit">%</span></div>
      <div class="kpi-sub">목표 대비 ${ctGapSec===null?'—':(ctGapSec>=0?'+':'')+ctGapSec+'초'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">투입 인원</div>
      <div class="kpi-value">${cap.manpower}<span class="kpi-unit">명</span></div>
      <div class="kpi-sub">0.5 단위 입력 지원</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">CAPA (인력 반영)</div>
      <div class="kpi-value">${cap.actualCapa!==null?cap.actualCapa:'—'}<span class="kpi-unit">EA/h</span></div>
      <div class="kpi-sub">목표 ${cap.targetCapa??'—'} / GAP ${cap.capaGap??'—'}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">측정 횟수</div>
      <div class="kpi-value">${r.n}<span class="kpi-unit">건</span></div>
      <div class="kpi-sub">${cycles.length>0? '최근 '+fmtDate(cycles[0].ts) : '측정 없음'}</div>
    </div>`;
  }

  const recordPanel = document.getElementById('cycle-record-panel');
  if(recordPanel){
    const tag = recordPanel.querySelector('.ph-tag');
    if(tag) tag.textContent = cycles.length + '건';
    const body = recordPanel.querySelector('.panel-body');
    if(body){
      body.innerHTML = cycles.length===0? `<div class="mini-empty"><div class="ico">⏱</div><p>측정된 사이클타임이 없습니다.</p></div>` : `
      <table class="data-table">
        <thead><tr><th>#</th><th>측정시각</th><th>사이클타임(초)</th><th></th></tr></thead>
        <tbody>
        ${cycles.map((c,i)=>`<tr><td>${cycles.length-i}</td><td>${fmtDate(c.ts)}</td><td>${c.ct.toFixed(2)}</td><td class="del-cell" data-del-cycle="${c.id}">삭제</td></tr>`).join('')}
        </tbody>
      </table>`;
      // 새로 그려진 삭제버튼에 이벤트 다시 바인딩
      body.querySelectorAll('[data-del-cycle]').forEach(el=>{
        el.addEventListener('click', async ()=>{
          try{ await fb.deleteDoc(fb.doc(cyclesCol(proj.id), el.dataset.delCycle)); }
          catch(e){ toast('삭제 실패: '+e.message, 'error'); }
        });
      });
    }
  }

  const lapNoLabel = document.getElementById('lap-no-label');
  if(lapNoLabel) lapNoLabel.textContent = 'LAP #' + (cycles.length + 1);
}

async function addCycle(pid, processId, ct){
  try{
    await fb.addDoc(cyclesCol(pid), { processId, ts: Date.now(), ct: round(ct,2) });
  }catch(e){
    console.error(e);
    toast('측정 기록 저장 실패: ' + e.message, 'error');
  }
}

// ---- Timer ----
function toggleTimer(proj){
  const btn = document.getElementById('btn-timer-toggle');
  const lapBtn = document.getElementById('btn-timer-lap');
  const display = document.getElementById('timer-display');
  if(!state.timer.running){
    state.timer.running = true;
    state.timer.startTs = Date.now();
    display.classList.add('running');
    btn.textContent = '측정 중지';
    lapBtn.disabled = false;
    state.timer.intervalId = setInterval(()=>{
      const elapsed = (Date.now() - state.timer.startTs)/1000;
      const d = document.getElementById('timer-display');
      if(d) d.textContent = elapsed.toFixed(1);
    }, 100);
    document.addEventListener('keydown', timerEnterHandler);
  } else {
    state.timer.running = false;
    clearInterval(state.timer.intervalId);
    if(display){ display.classList.remove('running'); display.textContent = '00.0'; }
    btn.textContent = '측정 시작';
    lapBtn.disabled = true;
    document.removeEventListener('keydown', timerEnterHandler);
  }
}
function timerEnterHandler(e){
  if(e.key!=='Enter' || !state.timer.running) return;

  // 입력 필드에서 Enter는 해당 필드 동작(예: 수동 입력 추가)에 맡긴다.
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
  if(tag==='input' || tag==='textarea' || tag==='select' || (e.target && e.target.isContentEditable)) return;

  // Enter 기본 동작(포커스된 버튼 클릭 등)으로 타이머가 정지되는 것을 방지
  e.preventDefault();
  e.stopPropagation();

  const proj = activeProject();
  if(proj) recordLap(proj);
}
function recordLap(proj){
  if(!state.timer.running) return;
  const elapsed = (Date.now() - state.timer.startTs)/1000;
  addCycle(proj.id, state.activeProcessId, elapsed);
  state.timer.startTs = Date.now(); // lap reset
  // 측정기록 갱신은 Firestore 리스너가 처리. 타이머 표시 상태(러닝중)는 그대로 유지.
}

// ---- Defect save ----
document.getElementById('btn-save-defect').addEventListener('click', async ()=>{
  const proj = activeProject();
  const processId = document.getElementById('defect-proc').value;
  const type = document.getElementById('defect-type').value.trim();
  const qty = Number(document.getElementById('defect-qty').value);
  const total = document.getElementById('defect-total').value;
  const remark = document.getElementById('defect-remark').value.trim();
  if(!processId || qty < 0){ toast('공정을 확인하세요', 'error'); return; }
  const defectType = type || (qty === 0 ? '불량없음' : '미분류');
  try{
    if(editingDefectId){
      const prev = proj.defects.find(d=>d.id===editingDefectId);
      await fb.updateDoc(fb.doc(defectsCol(proj.id), editingDefectId), {
        ts: prev?.ts || Date.now(),
        processId,
        type: defectType,
        qty,
        total: total?Number(total):null,
        remark
      });
    } else {
      await fb.addDoc(defectsCol(proj.id), { ts: Date.now(), processId, type: defectType, qty, total: total?Number(total):null, remark });
    }
    closeModal('modal-defect');
    editingDefectId = null;
    toast('불량 기록이 저장되었습니다', 'success');
  }catch(e){
    toast('저장 실패: ' + e.message, 'error');
  }
});

// ---- Sidebar collapse ----
function setSidebarOpen(open){
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if(open){
    sidebar.classList.remove('collapsed');
    overlay.style.display = 'block';
  } else {
    sidebar.classList.add('collapsed');
    overlay.style.display = 'none';
  }
}
document.getElementById('btn-toggle-sidebar').addEventListener('click', ()=>{
  const isCollapsed = document.getElementById('sidebar').classList.contains('collapsed');
  setSidebarOpen(isCollapsed);
});
document.getElementById('sidebar-overlay').addEventListener('click', ()=>{
  setSidebarOpen(false);
});

// ---- Backup export/import ----
document.getElementById('btn-export-all').addEventListener('click', exportFullBackupJSON);
document.getElementById('btn-sync-refresh').addEventListener('click', ()=>{
  toast('동기화 새로고침 중...', '');
  location.reload();
});
document.getElementById('btn-export-summary').addEventListener('click', ()=>{
  const proj = activeProject();
  if(!proj){
    toast('먼저 프로젝트를 선택하세요', 'error');
    return;
  }
  exportOnePageSummaryCSV(proj);
});
document.getElementById('btn-import-all').addEventListener('click', ()=>{
  const inp = document.createElement('input');
  inp.type='file'; inp.accept='application/json';
  inp.addEventListener('change', e=>{
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async ev=>{
      try{
        const data = JSON.parse(ev.target.result);
        if(!data.projects) throw new Error('invalid format');
        if(!confirm(`백업 파일의 프로젝트 ${data.projects.length}개로 현재 Firestore 데이터를 모두 교체합니다.\n현재 저장된 모든 프로젝트가 삭제된 후 백업 내용으로 다시 채워집니다.\n계속하시겠습니까?`)) return;
        toast('데이터를 불러오는 중...', '');
        await restoreFromBackup(data);
        state.activeProjectId = null;
        document.getElementById('proj-view').style.display='none';
        document.getElementById('main-empty').style.display='flex';
        toast('백업 데이터를 불러왔습니다', 'success');
      }catch(err){
        console.error(err);
        toast('백업 파일 형식이 올바르지 않거나 복원에 실패했습니다', 'error');
      }
    };
    reader.readAsText(file);
  });
  inp.click();
});

// 백업 JSON으로 전체 교체: 기존 프로젝트 전부 삭제 후 백업 내용을 새 문서로 기록
async function restoreFromBackup(data){
  const existingSnap = await fb.getDocsCompat(projectsCol());
  for(const pd of existingSnap.docs){
    await deleteProjectDeep(pd.id);
  }
  for(const proj of data.projects){
    const batch = fb.writeBatch(fb.db);
    const newProjRef = fb.doc(projectsCol());
    batch.set(newProjRef, {
      pn: proj.pn, pname: proj.pname,
      targetUph: proj.targetUph ?? null, targetQty: proj.targetQty ?? null,
      remark: proj.remark || '', createdAt: proj.createdAt || nowISO()
    });
    (proj.processes||[]).forEach(p=>{
      const ref = fb.doc(processesCol(newProjRef.id));
      batch.set(ref, { seq:p.seq, name:p.name, eq:p.eq||'', targetCt:p.targetCt??null, manpower:p.manpower??1 });
      // 사이클/CPK는 공정 문서ID가 바뀌므로 별도 루프에서 매핑 필요 → 아래에서 처리
      p.__newId = ref.id;
    });
    await batch.commit();

    // 공정별 cycles/defects/cpkData는 새 공정ID로 매핑하여 별도 배치 처리(배치 1개당 최대 500건 제한 고려해 묶음 처리)
    const procIdMap = {};
    (proj.processes||[]).forEach(p=>{ procIdMap[p.id] = p.__newId; });

    const cycleEntries = [];
    Object.entries(proj.cycles||{}).forEach(([oldProcId, list])=>{
      const newProcId = procIdMap[oldProcId];
      if(!newProcId) return;
      list.forEach(c=> cycleEntries.push({ processId:newProcId, ts:c.ts, ct:c.ct }));
    });
    await commitInChunks(cyclesCol(newProjRef.id), cycleEntries);

    const defectEntries = (proj.defects||[]).map(d=>({
      processId: procIdMap[d.processId] || null,
      ts: d.ts, type: d.type, qty: d.qty, total: d.total ?? null, remark: d.remark || ''
    })).filter(d=>d.processId);
    await commitInChunks(defectsCol(newProjRef.id), defectEntries);

    const cpkBatch = fb.writeBatch(fb.db);
    Object.entries(proj.cpkData||{}).forEach(([oldProcId, cd])=>{
      const newProcId = procIdMap[oldProcId];
      if(!newProcId) return;
      cpkBatch.set(fb.doc(cpkCol(newProjRef.id), newProcId), cd);
    });
    await cpkBatch.commit();
  }
}

// addDoc 다건을 배치로 안전하게 적재 (배치 최대 500건 제한 대응)
async function commitInChunks(colRef, entries, chunkSize=400){
  for(let i=0;i<entries.length;i+=chunkSize){
    const batch = fb.writeBatch(fb.db);
    entries.slice(i,i+chunkSize).forEach(entry=>{
      batch.set(fb.doc(colRef), entry);
    });
    await batch.commit();
  }
}

document.getElementById('btn-clear-all').addEventListener('click', async ()=>{
  if(!confirm('모든 프로젝트와 측정 데이터를 초기화하시겠습니까?\n이 작업은 되돌릴 수 없습니다. 사전에 백업(JSON) 내보내기를 권장합니다.')) return;
  if(!confirm('정말로 진행하시겠습니까? Firestore에 저장된 모든 데이터가 영구적으로 삭제됩니다.')) return;
  try{
    toast('전체 데이터를 삭제하는 중...', '');
    const snap = await fb.getDocsCompat(projectsCol());
    for(const pd of snap.docs){
      await deleteProjectDeep(pd.id);
    }
    state.activeProjectId = null;
    document.getElementById('proj-view').style.display='none';
    document.getElementById('main-empty').style.display='flex';
    toast('전체 데이터가 초기화되었습니다');
  }catch(e){
    console.error(e);
    toast('초기화 실패: ' + e.message, 'error');
  }
});

// ===================================================================
// INIT
// ===================================================================
function init(){
  fb = window.__firebase;
  if(!fb){
    setConnStatus(false);
    toast('Firebase 초기화 실패: 네트워크 또는 설정을 확인하세요', 'error');
    return;
  }
  // 12초 내 첫 Firestore 응답이 없으면 '연결 끊김' 상태로 전환 (무한 대기 방지)
  setTimeout(() => {
    if(!state.connected) setConnStatus(false);
  }, 12000);
  subscribeProjects();
}

if(window.__firebase){
  init();
} else {
  window.addEventListener('firebase-ready', init, { once:true });
}

// register service worker for PWA (production only)
// localhost 개발 중에는 캐시된 index.html 때문에 최신 수정이 안 보일 수 있어 SW를 해제한다.
if('serviceWorker' in navigator){
  // 새 서비스워커가 제어권을 가져오면(업데이트 활성화) 페이지를 한 번 자동 새로고침해 최신 화면을 보여준다.
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', ()=>{
    if(swRefreshing) return;
    swRefreshing = true;
    window.location.reload();
  });
  window.addEventListener('load', async ()=>{
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if(isLocalhost){
      try{
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }catch(_e){}
      return;
    }
    try{
      const reg = await navigator.serviceWorker.register('sw.js');
      // 즉시 업데이트 확인
      reg.update().catch(()=>{});
    }catch(_e){}
  });
}
