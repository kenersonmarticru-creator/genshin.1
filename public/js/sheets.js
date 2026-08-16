/* ===================== DATA (carregado da planilha) ===================== */
const ELEMENTS = {
  Pyro:'--pyro', Hydro:'--hydro', Electro:'--electro', Cryo:'--cryo',
  Anemo:'--anemo', Geo:'--geo', Dendro:'--dendro'
};
const CHAR_LEVELS = [0,1,2,3,4,5,6];
const WEAPON_LEVELS = [1,2,3,4,5];

let CHARACTERS = [];
let WEAPONS = [];
// Mapas por id — usados pra resolver o item completo (nome, imagem, custos)
// a partir só do id salvo no pool do draft (ver buildInitialEstado), assim
// a gente não duplica o catálogo inteiro dentro do EstadoJSON da partida.
let CHAR_BY_ID = {};
let WEAPON_BY_ID = {};

/* ===================== SESSÃO / PARTIDA ===================== */
let ME = null;            // {id, email, username, isAdmin}
let MATCH = null;         // objeto retornado pela API (/api/partida)
let CFG = {};              // alias de MATCH.config
let ST = null;             // alias de MATCH.estado
let myPlayerIndex = null;  // 0 (Jogador 1) ou 1 (Jogador 2)

let pollHandle = null;
let timerHandle = null;
let pickInFlight = false;
let skipInFlight = false;

const SCREENS = ['loadingBox','loadError','authRequired','modeChoice','createForm','joinForm','waitingRoom','draft','summary'];
let currentScreen = '';

function showOnly(id){
  SCREENS.forEach(s => document.getElementById(s).classList.toggle('hidden', s!==id));
  currentScreen = id;
}

function showMsg(el, text, kind){
  el.textContent = text;
  el.className = 'msg ' + (kind || '');
}

function pname(p){
  if(p===0) return (MATCH && MATCH.jogador1 && MATCH.jogador1.nome) || 'Jogador 1';
  return (MATCH && MATCH.jogador2 && MATCH.jogador2.nome) || 'Jogador 2';
}

/* ===================== ESTADO DO DRAFT (funções puras) ===================== */
function buildSnakeOrder(slotsPerPlayer, startPlayer){
  const order = [];
  for(let i=0;i<slotsPerPlayer*2;i++){
    const round = Math.floor(i/2);
    const pair = (round % 2 === 0) ? [0,1] : [1,0];
    let p = pair[i%2];
    if(startPlayer===1) p = 1-p;
    order.push(p);
  }
  return order;
}

function cloneState(s){ return JSON.parse(JSON.stringify(s)); }

function buildInitialEstado(cfg){
  return {
    phase: 'characters',
    // Só os ids ficam salvos no estado da partida (não o catálogo inteiro
    // com nome/imagem/custos de cada item) — cada item já some da lista
    // conforme é escolhido. Isso evita estourar o limite de 50.000
    // caracteres por célula da planilha quando o EstadoJSON é salvo.
    pool: { characters: CHARACTERS.map(c=>c.id), weapons: WEAPONS.map(w=>w.id) },
    players: [
      {points:cfg.budget, picksChar:[], picksWeapon:[], fiveStar:0},
      {points:cfg.budget, picksChar:[], picksWeapon:[], fiveStar:0}
    ],
    globalFiveStarUsed: 0,
    order: buildSnakeOrder(cfg.charSlots, 0),
    turnIdx: 0,
    turnStartedAt: new Date().toISOString(),
    log: []
  };
}

function advancePhaseIfNeeded(estado){
  estado.turnIdx++;
  if(estado.turnIdx >= estado.order.length){
    if(estado.phase==='characters'){
      estado.phase = 'weapons';
      estado.order = buildSnakeOrder(CFG.weaponSlots, 1);
      estado.turnIdx = 0;
      estado.turnStartedAt = new Date().toISOString();
    } else {
      estado.phase = 'summary';
    }
  } else {
    estado.turnStartedAt = new Date().toISOString();
  }
  return estado;
}

function levelKeyFor(phase, level){
  return phase==='weapons' ? ('R'+level) : ('C'+level);
}

function levelLabelFor(phase, level){
  return phase==='weapons' ? ('R'+level) : ('C'+level);
}

function applyPick(estado, playerIdx, itemId, level){
  if(level === undefined || level === null || isNaN(Number(level))) throw new Error('Nível/constelação inválido — tente escolher de novo.');
  const poolKey = estado.phase==='weapons' ? 'weapons' : 'characters';
  const byId = estado.phase==='weapons' ? WEAPON_BY_ID : CHAR_BY_ID;
  const idx = estado.pool[poolKey].indexOf(itemId);
  if(idx===-1) throw new Error('Item não encontrado.');
  const item = byId[itemId];
  if(!item) throw new Error('Item não encontrado no catálogo.');
  const levelKey = levelKeyFor(estado.phase, level);
  const cost = item.costs[levelKey];
  if(cost === undefined) throw new Error('Nível inválido.');
  if(cost > estado.players[playerIdx].points) throw new Error('Pontos insuficientes.');
  if(item.rarity===5 && estado.globalFiveStarUsed >= CFG.fiveCap) throw new Error('Limite de armas 5★ atingido.');

  estado.pool[poolKey].splice(idx,1);
  estado.players[playerIdx].points -= cost;
  const picked = { id:item.id, name:item.name, element:item.element, rarity:item.rarity, image:item.image, level, cost };
  if(estado.phase==='weapons') estado.players[playerIdx].picksWeapon.push(picked);
  else estado.players[playerIdx].picksChar.push(picked);
  if(item.rarity===5 && estado.phase==='weapons'){
    estado.globalFiveStarUsed++;
    estado.players[playerIdx].fiveStar++;
  }
  estado.log.push({player:playerIdx, name:pname(playerIdx), text:`escolheu ${item.name} (${levelLabelFor(estado.phase,level)} · ${cost} pts)`});
  return advancePhaseIfNeeded(estado);
}

function applySkip(estado, playerIdx){
  estado.log.push({player:playerIdx, name:pname(playerIdx), text:'perdeu a vez (tempo esgotado)'});
  return advancePhaseIfNeeded(estado);
}

/* ===================== RENDER ===================== */
function rarityClass(r){ return r>=5?'r5': r===4?'r4':'r3'; }
function currentPool(){
  const ids = ST.phase==='weapons' ? ST.pool.weapons : ST.pool.characters;
  const byId = ST.phase==='weapons' ? WEAPON_BY_ID : CHAR_BY_ID;
  const resolved = ids.map(id => byId[id]).filter(Boolean);
  if(ids.length > 0 && resolved.length === 0){
    console.warn('[draft] pool tem', ids.length, 'ids mas nenhum bateu com o catálogo carregado (CHAR_BY_ID/WEAPON_BY_ID) — catálogo pode não ter carregado a tempo.');
  }
  return resolved;
}

function imgTag(it, size){
  if(!it.image) return '';
  return `<img src="${it.image}" style="width:${size}px;height:${size}px;" class="item-img" onerror="this.style.display='none'">`;
}

function renderSidePanels(){
  for(let p=0;p<2;p++){
    document.getElementById('dispName'+(p+1)).textContent = pname(p);
    document.getElementById('dispPoints'+(p+1)).textContent = ST.players[p].points;

    const list = document.getElementById('picksP'+(p+1));
    list.innerHTML = '';
    const allPicks = [
      ...ST.players[p].picksChar.map(x=>({...x,kind:'char'})),
      ...ST.players[p].picksWeapon.map(x=>({...x,kind:'weapon'}))
    ];
    const totalSlots = CFG.charSlots + CFG.weaponSlots;
    for(let i=0;i<totalSlots;i++){
      if(allPicks[i]){
        const it = allPicks[i];
        const chip = document.createElement('div');
        chip.className = 'pick-chip ' + rarityClass(it.rarity);
        const levelLabel = it.level !== undefined && it.level !== null ? levelLabelFor(it.kind==='weapon'?'weapons':'characters', it.level) : '';
        chip.innerHTML = `${imgTag(it,22)}<span>${it.name} <b style="color:var(--gold-bright);">${levelLabel}</b></span><span class="cost">${it.cost}</span>`;
        list.appendChild(chip);
      } else {
        const slot = document.createElement('div');
        slot.className = 'empty-slot';
        slot.textContent = i < CFG.charSlots ? '— personagem —' : '— arma —';
        list.appendChild(slot);
      }
    }

    const dotsWrap = document.getElementById('fsP'+(p+1));
    dotsWrap.innerHTML = '';
    for(let i=0;i<Math.max(CFG.fiveCap,1);i++){
      const d = document.createElement('div');
      d.className = 'dot' + (i < ST.players[p].fiveStar ? ' filled':'');
      dotsWrap.appendChild(d);
    }
    document.getElementById('panelP'+(p+1)).classList.toggle('turn-active', ST.order[ST.turnIdx]===p);
  }
}

function renderGrid(){
  const grid = document.getElementById('itemGrid');
  const search = document.getElementById('searchBox').value.toLowerCase();
  const sort = document.getElementById('sortBox').value;
  const activePlayer = ST.order[ST.turnIdx];
  const budgetLeft = ST.players[activePlayer].points;
  const notMyTurn = activePlayer !== myPlayerIndex;
  const levels = ST.phase==='weapons' ? WEAPON_LEVELS : CHAR_LEVELS;
  const cheapestCost = it => Math.min(...levels.map(lvl => it.costs[levelKeyFor(ST.phase, lvl)]));

  let items = currentPool().filter(it => it.name.toLowerCase().includes(search));
  if(sort==='cost-desc') items.sort((a,b)=>cheapestCost(b)-cheapestCost(a));
  else if(sort==='cost-asc') items.sort((a,b)=>cheapestCost(a)-cheapestCost(b));
  else items.sort((a,b)=>a.name.localeCompare(b.name));

  grid.innerHTML = '';
  items.forEach(it=>{
    const minCost = cheapestCost(it);
    const fiveStarBlocked = (it.rarity===5 && ST.globalFiveStarUsed >= CFG.fiveCap);
    const cantAfford = minCost > budgetLeft;
    const disabled = fiveStarBlocked || cantAfford || notMyTurn;

    const card = document.createElement('div');
    card.className = `item-card ${rarityClass(it.rarity)} ${disabled?'disabled':''}`;
    const elemLabel = it.element ? `<span class="elem-dot" style="background:var(${ELEMENTS[it.element]||'--ink-faint'})"></span>${it.element}` : (ST.phase==='weapons' ? 'Arma' : '');
    card.innerHTML = `
      ${imgTag(it,100)}
      <div style="font-size:10.5px; color:var(--ink-faint); text-transform:uppercase; letter-spacing:.04em; margin-top:6px;">${elemLabel}</div>
      <span class="iname">${it.name}</span>
      <div class="imeta"><span class="rarity-tag">${it.rarity}★</span><span class="cost-tag">a partir de ${minCost}</span></div>`;
    if(!disabled) card.addEventListener('click', ()=>openLevelModal(it));
    grid.appendChild(card);
  });
}

/* ===================== MODAL: escolher constelação/refinamento ===================== */
function openLevelModal(item){
  const activePlayer = ST.order[ST.turnIdx];
  const budgetLeft = ST.players[activePlayer].points;
  const levels = ST.phase==='weapons' ? WEAPON_LEVELS : CHAR_LEVELS;
  const isWeapon = ST.phase==='weapons';

  document.getElementById('levelModalTitle').textContent = item.name;
  document.getElementById('levelModalHint').textContent = isWeapon
    ? 'Escolha o refinamento — cada nível custa mais pontos.'
    : 'Escolha a constelação — cada nível custa mais pontos.';

  const grid = document.getElementById('levelGrid');
  grid.innerHTML = '';
  levels.forEach(lvl=>{
    const key = levelKeyFor(ST.phase, lvl);
    const cost = item.costs[key];
    const fiveStarBlocked = (item.rarity===5 && ST.globalFiveStarUsed >= CFG.fiveCap);
    const cantAfford = cost > budgetLeft;
    const disabled = fiveStarBlocked || cantAfford;

    const btn = document.createElement('div');
    btn.className = 'level-btn' + (disabled ? ' disabled' : '');
    btn.innerHTML = `<div class="lv-label">${levelLabelFor(ST.phase, lvl)}</div><div class="lv-cost">${cost} pts</div>`;
    if(!disabled) btn.addEventListener('click', ()=>{
      closeLevelModal();
      makePick(item.id, lvl);
    });
    grid.appendChild(btn);
  });

  document.getElementById('levelModal').classList.remove('hidden');
}
function closeLevelModal(){
  document.getElementById('levelModal').classList.add('hidden');
}
document.getElementById('levelModalCancel')?.addEventListener('click', closeLevelModal);


function renderTurnInfo(){
  const activePlayer = ST.order[ST.turnIdx];
  const isMe = activePlayer === myPlayerIndex;
  document.getElementById('turnTitle').innerHTML = `Vez de <b class="${activePlayer===0?'p-color-1':'p-color-2'}">${pname(activePlayer)}</b>` + (isMe ? ' <span style="color:var(--gold-bright);">(você)</span>' : '');
  document.getElementById('phaseCaption').textContent = ST.phase==='weapons' ? 'Fase 2 · Escolha de Armas' : 'Fase 1 · Escolha de Personagens';
  document.getElementById('phasePill').textContent = ST.phase==='weapons' ? 'Draft — Armas' : 'Draft — Personagens';
}

function renderLog(){
  const box = document.getElementById('logList');
  box.innerHTML = ST.log.slice().reverse().map(l=>{
    const who = l.player===0 ? 'who1' : 'who2';
    return `<div class="log-entry"><span class="${who}">${l.name}</span> ${l.text}</div>`;
  }).join('');
}

function renderTimerRing(){
  const circ = 2*Math.PI*66;
  const ring = document.getElementById('ringFg');
  ring.style.strokeDasharray = circ;
  const frac = Math.max(0, ST.timeLeft) / CFG.timer;
  ring.style.strokeDashoffset = circ * (1-frac);
  const low = frac < 0.25;
  ring.style.stroke = low ? 'var(--danger)' : 'var(--gold)';
  document.getElementById('ringTime').textContent = Math.max(0, ST.timeLeft);
  document.getElementById('ringTime').style.color = low ? 'var(--danger)' : 'var(--ink)';
}

function renderAll(){ renderSidePanels(); renderTurnInfo(); renderGrid(); renderLog(); renderTimerRing(); }

/* ===================== TIMER (baseado no relógio do servidor) ===================== */
function stopTimer(){ clearInterval(timerHandle); timerHandle = null; }

function syncTimerFromState(){
  stopTimer();
  if(!ST || ST.phase==='summary') return;
  renderTimerTick();
  timerHandle = setInterval(renderTimerTick, 1000);
}

function renderTimerTick(){
  if(!ST || ST.phase==='summary'){ stopTimer(); return; }
  const startedAt = new Date(ST.turnStartedAt).getTime();
  const elapsed = Math.floor((Date.now() - startedAt) / 1000);
  const remaining = Math.max(0, CFG.timer - elapsed);
  ST.timeLeft = remaining;
  renderTimerRing();

  const activePlayer = ST.order[ST.turnIdx];
  document.getElementById('skipNote').textContent = remaining<=0 ? `Tempo esgotado — ${pname(activePlayer)} perdeu a vez.` : '';

  // Só o dispositivo de quem está com a vez envia o "perdeu a vez" — evita
  // as duas pontas tentarem escrever ao mesmo tempo.
  if(remaining<=0 && activePlayer===myPlayerIndex && !skipInFlight){
    skipInFlight = true;
    stopTimer();
    const newEstado = applySkip(cloneState(ST), activePlayer);
    sendMatchUpdate(newEstado).finally(()=>{ skipInFlight = false; });
  }
}

/* ===================== ESCOLHAS / SINCRONIZAÇÃO ===================== */
async function makePick(itemId, level){
  if(pickInFlight) return;
  const activePlayer = ST.order[ST.turnIdx];
  if(activePlayer !== myPlayerIndex) return;

  const poolKey = ST.phase==='weapons' ? 'weapons' : 'characters';
  const byId = ST.phase==='weapons' ? WEAPON_BY_ID : CHAR_BY_ID;
  const idx = ST.pool[poolKey].indexOf(itemId);
  if(idx===-1) return;
  const item = byId[itemId];
  if(!item) return;
  const cost = item.costs[levelKeyFor(ST.phase, level)];
  if(cost === undefined) return;
  if(cost > ST.players[activePlayer].points) return;
  if(item.rarity===5 && ST.globalFiveStarUsed >= CFG.fiveCap) return;

  pickInFlight = true;
  stopTimer();
  try{
    const newEstado = applyPick(cloneState(ST), activePlayer, itemId, level);
    await sendMatchUpdate(newEstado);
  } catch(e){
    document.getElementById('skipNote').textContent = e.message;
    syncTimerFromState();
  } finally {
    pickInFlight = false;
  }
}

async function sendMatchUpdate(newEstado){
  const res = await fetch('/api/partida', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action:'pick', partidaId: MATCH.partidaId, userId: ME.id, estado: newEstado, versaoEsperada: MATCH.versao })
  });
  const json = await res.json();
  if(!json.ok){
    document.getElementById('skipNote').textContent = json.msg;
    return;
  }
  applyMatch(json.match); // servidor é a fonte da verdade — inclusive em caso de conflito
}

function applyMatch(match){
  MATCH = match;
  CFG = MATCH.config;
  ST = MATCH.estado;

  if(ST.phase==='summary'){
    showSummaryScreen();
  } else {
    if(currentScreen !== 'draft') showOnly('draft');
    renderAll();
    syncTimerFromState();
  }
}

/* ===================== POLLING (é o que sincroniza os dois dispositivos) ===================== */
function startPolling(){
  stopPolling();
  pollHandle = setInterval(async ()=>{
    if(!MATCH) return;
    try{
      const res = await fetch('/api/partida?id=' + encodeURIComponent(MATCH.partidaId));
      const json = await res.json();
      if(!json.ok) return;
      const match = json.match;

      if(currentScreen==='waitingRoom'){
        MATCH = match;
        renderWaitingRoom();
        if(match.status !== 'aguardando'){
          enterDraftScreen(match);
        }
      } else if(currentScreen==='draft' || currentScreen==='summary'){
        if(match.versao !== MATCH.versao || match.status !== MATCH.status){
          applyMatch(match);
        }
      }
    } catch(e){
      // falha de rede pontual — tenta de novo no próximo ciclo, sem travar a tela
    }
  }, 2500);
}
function stopPolling(){ if(pollHandle) clearInterval(pollHandle); pollHandle = null; }

function renderWaitingRoom(){
  document.getElementById('waitingCode').textContent = MATCH.partidaId;
  document.getElementById('waitingP1').textContent = MATCH.jogador1 ? MATCH.jogador1.nome : 'Aguardando…';
  document.getElementById('waitingP2').textContent = MATCH.jogador2 ? MATCH.jogador2.nome : 'Aguardando…';
}

function enterDraftScreen(match){
  MATCH = match;
  CFG = MATCH.config;
  ST = MATCH.estado;
  if(MATCH.jogador1 && MATCH.jogador1.id === ME.id) myPlayerIndex = 0;
  else if(MATCH.jogador2 && MATCH.jogador2.id === ME.id) myPlayerIndex = 1;
  else myPlayerIndex = null; // admin/organizador acompanha como espectador

  if(ST.phase==='summary'){
    showSummaryScreen();
  } else {
    showOnly('draft');
    renderAll();
    syncTimerFromState();
  }
  startPolling();
}

/* ===================== RESUMO + PONTUAÇÃO FINAL (admin) ===================== */
function showSummaryScreen(){
  stopTimer();
  showOnly('summary');
  document.getElementById('phasePill').textContent = 'Times Finalizados';

  const grid = document.getElementById('summaryGrid');
  grid.innerHTML = '';
  for(let p=0;p<2;p++){
    const spent = CFG.budget - ST.players[p].points;
    const col = document.createElement('div');
    col.className = 'sum-col panel';
    col.innerHTML = `
      <h3 class="${p===0?'p-color-1':'p-color-2'} font-display">${pname(p)}</h3>
      <div class="hint" style="margin-bottom:16px;">${spent} / ${CFG.budget} pontos usados · ${ST.players[p].fiveStar} arma(s) 5★</div>
      <div class="hint" style="text-transform:uppercase; letter-spacing:.08em; margin-bottom:8px;">Personagens</div>
      ${ST.players[p].picksChar.map(c=>`<div class="sum-item">${imgTag(c,26)}<span>${c.rarity}★ ${c.name} <b style="color:var(--gold-bright);">${levelLabelFor('characters',c.level)}</b></span><span class="cost">${c.cost}</span></div>`).join('') || '<div class="sum-item">Nenhum</div>'}
      <div class="hint" style="text-transform:uppercase; letter-spacing:.08em; margin:14px 0 8px;">Armas</div>
      ${ST.players[p].picksWeapon.map(w=>`<div class="sum-item">${imgTag(w,26)}<span>${w.rarity}★ ${w.name} <b style="color:var(--gold-bright);">${levelLabelFor('weapons',w.level)}</b></span><span class="cost">${w.cost}</span></div>`).join('') || '<div class="sum-item">Nenhuma</div>'}
    `;
    grid.appendChild(col);
  }

  renderFinalScoreBanner();
  renderAdminScorePanel();
}

function renderFinalScoreBanner(){
  const banner = document.getElementById('finalScoreBanner');
  if(MATCH.status === 'finalizada'){
    banner.classList.remove('hidden');
    const j1 = MATCH.pontosFinais.j1 ?? '—';
    const j2 = MATCH.pontosFinais.j2 ?? '—';
    document.getElementById('finalScoreText').textContent = `${pname(0)}  ${j1}  ×  ${j2}  ${pname(1)}`;
    document.getElementById('finalScoreWinner').textContent = MATCH.vencedor ? `Vencedor: ${MATCH.vencedor}` : 'Empate';
  } else {
    banner.classList.add('hidden');
  }
}

function renderAdminScorePanel(){
  const panel = document.getElementById('adminScorePanel');
  if(!ME.isAdmin || MATCH.status === 'finalizada'){
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  document.getElementById('adminScoreLabel1').textContent = 'Pontos — ' + pname(0);
  document.getElementById('adminScoreLabel2').textContent = 'Pontos — ' + pname(1);
  const winnerSelect = document.getElementById('adminScoreWinner');
  winnerSelect.innerHTML = `<option value="">Empate / não definir</option><option value="${pname(0)}">${pname(0)}</option><option value="${pname(1)}">${pname(1)}</option>`;
}

document.getElementById('adminScoreBtn')?.addEventListener('click', async ()=>{
  const msgEl = document.getElementById('adminScoreMsg');
  const j1 = document.getElementById('adminScoreJ1').value;
  const j2 = document.getElementById('adminScoreJ2').value;
  const vencedor = document.getElementById('adminScoreWinner').value;
  try{
    const res = await fetch('/api/partida', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        action: 'finalizar', partidaId: MATCH.partidaId, requesterId: ME.id,
        pontosJ1: j1===''?null:Number(j1), pontosJ2: j2===''?null:Number(j2), vencedor
      })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);
    MATCH = json.match;
    showMsg(msgEl, 'Pontuação final salva!', 'ok');
    renderFinalScoreBanner();
    renderAdminScorePanel();
  } catch(e){
    showMsg(msgEl, e.message, 'error');
  }
});

/* ===================== CRIAR / ENTRAR EM PARTIDA ===================== */
document.getElementById('chooseCreate')?.addEventListener('click', ()=> showOnly('createForm'));
document.getElementById('chooseJoin')?.addEventListener('click', ()=> showOnly('joinForm'));
document.getElementById('backFromCreate')?.addEventListener('click', ()=> showOnly('modeChoice'));
document.getElementById('backFromJoin')?.addEventListener('click', ()=> showOnly('modeChoice'));

document.getElementById('createBtn')?.addEventListener('click', async ()=>{
  const msgEl = document.getElementById('createMsg');
  const cfg = {
    budget: parseInt(document.getElementById('cfgBudget').value)||550,
    charSlots: parseInt(document.getElementById('cfgChars').value)||4,
    weaponSlots: parseInt(document.getElementById('cfgWeapons').value)||4,
    fiveCap: parseInt(document.getElementById('cfgFiveStar').value)||0,
    timer: parseInt(document.getElementById('cfgTimer').value)||45,
  };
  const estadoInicial = buildInitialEstado(cfg);

  try{
    const res = await fetch('/api/partida', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action:'create', hostId: ME.id, hostName: ME.username, config: cfg, estado: estadoInicial })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);

    const matchRes = await fetch('/api/partida?id=' + encodeURIComponent(json.partidaId));
    const matchJson = await matchRes.json();
    if(!matchJson.ok) throw new Error(matchJson.msg);

    MATCH = matchJson.match;
    myPlayerIndex = null; // admin acompanha como espectador — não ocupa vaga de jogador
    renderWaitingRoom();
    showOnly('waitingRoom');
    startPolling();
  } catch(e){
    showMsg(msgEl, e.message, 'error');
  }
});

document.getElementById('joinBtn')?.addEventListener('click', async ()=>{
  const msgEl = document.getElementById('joinMsg');
  const code = document.getElementById('joinCode').value.trim().toUpperCase();
  if(!code){ showMsg(msgEl, 'Digite o código da partida.', 'error'); return; }

  try{
    const res = await fetch('/api/partida', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action:'join', partidaId: code, userId: ME.id, userName: ME.username })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);

    // 'espectador' = o próprio admin reabrindo a tela da partida que criou.
    myPlayerIndex = json.papel==='jogador1' ? 0 : json.papel==='jogador2' ? 1 : null;
    MATCH = json.match;

    if(MATCH.status === 'aguardando'){
      renderWaitingRoom();
      showOnly('waitingRoom');
      startPolling();
    } else {
      enterDraftScreen(MATCH);
    }
  } catch(e){
    showMsg(msgEl, e.message, 'error');
  }
});

document.getElementById('searchBox')?.addEventListener('input', renderGrid);
document.getElementById('sortBox')?.addEventListener('change', renderGrid);
document.getElementById('restartBtn')?.addEventListener('click', ()=>{
  window.location.reload();
});

/* ===================== BOOT (carrega planilha + sessão) ===================== */
async function boot(){
  try{
    [CHARACTERS, WEAPONS] = await Promise.all([loadCharacters(), loadWeapons()]);
    CHAR_BY_ID = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));
    WEAPON_BY_ID = Object.fromEntries(WEAPONS.map(w => [w.id, w]));
  } catch(e){
    showOnly('loadError');
    document.getElementById('loadErrorText').textContent = 'Erro ao carregar a planilha: ' + e.message;
    return;
  }

  ME = await getSession();
  if(!ME){
    showOnly('authRequired');
    return;
  }

  document.getElementById('meName').textContent = ME.username || ME.email;
  document.getElementById('phasePill').textContent = 'Configuração';

  if(ME.isAdmin){
    const link = document.getElementById('navAdminLink');
    if(link) link.classList.remove('hidden');
  } else {
    document.getElementById('chooseCreate').classList.add('hidden');
    document.getElementById('notAdminNote').textContent = 'Só o administrador cria partidas — peça o código a ele.';
  }

  showOnly('modeChoice');
}
// sheets.js é compartilhado com index.html (que só usa as funções puras de
// pontuação/draft, não a tela em si) — só inicia o boot da tela de draft
// nas páginas que realmente têm essa tela (draft.html).
if(document.getElementById('draft')) boot();
