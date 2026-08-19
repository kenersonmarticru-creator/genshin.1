const CHAR_LEVELS = [0,1,2,3,4,5,6];
const WEAPON_LEVELS = [1,2,3,4,5];

let ME = null;
let CHAR_CATALOG = [];
let WEAPON_CATALOG = [];
let BUFF_CATALOG = [];

function rarityClass(r){ return r>=5?'r5': r===4?'r4':'r3'; }

async function loadCatalog(){
  const res = await fetch('/api/personagens?tipo=catalogo');
  const json = await res.json();
  if(!json.ok) throw new Error(json.msg || 'Não foi possível carregar o catálogo.');
  return json;
}

async function loadBuffCatalog(){
  const res = await fetch('/api/personagens?tipo=buffs');
  const json = await res.json();
  if(!json.ok) throw new Error(json.msg || 'Não foi possível carregar os buffs.');
  return json.buffs;
}

function renderCharsTable(filter){
  const body = document.getElementById('charsBody');
  body.innerHTML = '';
  const q = (filter||'').toLowerCase();
  CHAR_CATALOG
    .filter(c => c.name.toLowerCase().includes(q))
    .sort((a,b)=> a.name.localeCompare(b.name))
    .forEach(c => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.innerHTML = `<div class="admin-row-name">${c.image?`<img src="${c.image}" onerror="this.style.display='none'">`:''}<span>${c.name}</span><span class="rarity">${c.rarity}★</span></div>`;
      tr.appendChild(nameTd);

      CHAR_LEVELS.forEach(lvl => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'cost-input';
        input.value = c.costs['C'+lvl];
        input.min = 0;
        input.addEventListener('change', () => saveCharacterCost(c.name, lvl, input));
        td.appendChild(input);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
}

function renderWeaponsTable(filter){
  const body = document.getElementById('weaponsBody');
  body.innerHTML = '';
  const q = (filter||'').toLowerCase();
  WEAPON_CATALOG
    .filter(w => w.name.toLowerCase().includes(q))
    .sort((a,b)=> a.name.localeCompare(b.name))
    .forEach(w => {
      const tr = document.createElement('tr');
      const nameTd = document.createElement('td');
      nameTd.innerHTML = `<div class="admin-row-name">${w.image?`<img src="${w.image}" onerror="this.style.display='none'">`:''}<span>${w.name}</span><span class="rarity">${w.rarity}★</span></div>`;
      tr.appendChild(nameTd);

      WEAPON_LEVELS.forEach(lvl => {
        const td = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'cost-input';
        input.value = w.costs['R'+lvl];
        input.min = 0;
        input.addEventListener('change', () => saveWeaponCost(w.name, lvl, input));
        td.appendChild(input);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
}

async function saveCharacterCost(name, level, input){
  input.classList.remove('saved','erro');
  try{
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action:'updateCharacterCost', requesterId: ME.id, name, level, value: Number(input.value)||0 })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);
    input.classList.add('saved');
    setTimeout(()=> input.classList.remove('saved'), 1200);
  } catch(e){
    input.classList.add('erro');
    alert('Erro ao salvar: ' + e.message);
  }
}

async function saveWeaponCost(name, level, input){
  input.classList.remove('saved','erro');
  try{
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action:'updateWeaponCost', requesterId: ME.id, name, level, value: Number(input.value)||0 })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);
    input.classList.add('saved');
    setTimeout(()=> input.classList.remove('saved'), 1200);
  } catch(e){
    input.classList.add('erro');
    alert('Erro ao salvar: ' + e.message);
  }
}

// field = nome exato da coluna na planilha PersonagensBuffs (ver
// CHAR_BUFFS_HEADER em lib/sheets.js). rawValue já vem no formato certo
// (número, texto, ou 'TRUE'/'' pro checkbox) — quem chama decide isso.
async function saveKitBuffField(name, field, rawValue, el){
  el.classList.remove('saved','erro');
  try{
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action:'updateCharacterKitBuff', requesterId: ME.id, name, field, value: rawValue })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);
    el.classList.add('saved');
    setTimeout(()=> el.classList.remove('saved'), 1200);
  } catch(e){
    el.classList.add('erro');
    alert('Erro ao salvar: ' + e.message);
  }
}

function statSelect(name, field, current){
  const select = document.createElement('select');
  select.className = 'buff-input';
  [['atk','ATQ'],['hp','HP'],['def','DEF']].forEach(([val, label]) => {
    const opt = document.createElement('option');
    opt.value = val; opt.textContent = label;
    if (current === val) opt.selected = true;
    select.appendChild(opt);
  });
  // Terceira opção "em branco" pra voltar a usar o chute automático — só
  // aparece se ainda não tiver valor escolhido, senão o dropdown sempre
  // teria 4 opções visíveis o tempo todo.
  if (!current) {
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = '— auto —'; blank.selected = true;
    select.insertBefore(blank, select.firstChild);
  }
  select.addEventListener('change', () => saveKitBuffField(name, field, select.value, select));
  return select;
}

function numberInput(name, field, current){
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'buff-input';
  input.value = current || 0;
  input.step = '0.1';
  input.addEventListener('change', () => saveKitBuffField(name, field, Number(input.value)||0, input));
  return input;
}

function textInput(name, field, current, placeholder){
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'buff-input wide';
  input.value = current || '';
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('change', () => saveKitBuffField(name, field, input.value.trim(), input));
  return input;
}

function checkboxInput(name, field, current){
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'buff-check';
  input.checked = !!current;
  input.addEventListener('change', () => saveKitBuffField(name, field, input.checked ? 'TRUE' : '', input));
  return input;
}

function renderBuffsTable(filter){
  const body = document.getElementById('buffsBody');
  body.innerHTML = '';
  const q = (filter||'').toLowerCase();
  BUFF_CATALOG
    .filter(b => b.name.toLowerCase().includes(q))
    .sort((a,b)=> a.name.localeCompare(b.name))
    .forEach(b => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      const cat = CHAR_CATALOG.find(c => c.name === b.name);
      nameTd.innerHTML = `<div class="admin-row-name">${cat && cat.image?`<img src="${cat.image}" onerror="this.style.display='none'">`:''}<span>${b.name}</span></div>`;
      tr.appendChild(nameTd);

      const cells = [
        [statSelect(b.name, 'StatHabilidade', b.statHabilidade)],
        [statSelect(b.name, 'StatExplosao', b.statExplosao)],
        [numberInput(b.name, 'BuffDanoTimePercent', b.buffDanoTimePercent)],
        [textInput(b.name, 'BuffDanoTimeCondicao', b.buffDanoTimeCondicao, 'ex: até 20s após a Explosão')],
        [numberInput(b.name, 'BuffAtqTimePercent', b.buffAtqTimePercent)],
        [numberInput(b.name, 'BuffResShredPercent', b.buffResShredPercent)],
        [textInput(b.name, 'BuffResShredElementos', b.buffResShredElementos, 'ex: Hydro, Pyro')],
        [numberInput(b.name, 'BuffReacaoPercent', b.buffReacaoPercent)],
        [textInput(b.name, 'BuffReacaoTipos', b.buffReacaoTipos, 'ex: vaporizar, sobrecarregar')],
        [checkboxInput(b.name, 'AtivoPadrao', b.ativoPadrao)],
      ];
      cells.forEach(([el]) => { const td = document.createElement('td'); td.appendChild(el); tr.appendChild(td); });
      body.appendChild(tr);
    });
}

document.getElementById('importBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('importStatusMsg');
  const btn = document.getElementById('importBtn');
  btn.disabled = true;
  msgEl.textContent = 'Buscando personagens novos na Yatta…';
  try{
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action:'importCatalogFromYatta', requesterId: ME.id })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);
    msgEl.textContent = json.total > 0
      ? `${json.total} personagem(ns) novo(s) adicionado(s): ${json.novos.join(', ')}`
      : 'Nenhum personagem novo — o catálogo já está em dia.';
    BUFF_CATALOG = await loadBuffCatalog();
    renderBuffsTable(document.getElementById('adminSearchInput').value);
  } catch(e){
    msgEl.textContent = 'Erro: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

function showTab(which){
  document.getElementById('tabChars').classList.toggle('active', which==='chars');
  document.getElementById('tabWeapons').classList.toggle('active', which==='weapons');
  document.getElementById('tabBuffs').classList.toggle('active', which==='buffs');
  document.getElementById('charsTable').classList.toggle('hidden', which!=='chars');
  document.getElementById('weaponsTable').classList.toggle('hidden', which!=='weapons');
  document.getElementById('buffsPanel').classList.toggle('hidden', which!=='buffs');
}
document.getElementById('tabChars').addEventListener('click', ()=> showTab('chars'));
document.getElementById('tabWeapons').addEventListener('click', ()=> showTab('weapons'));
document.getElementById('tabBuffs').addEventListener('click', ()=> showTab('buffs'));
document.getElementById('adminSearchInput').addEventListener('input', (e)=>{
  renderCharsTable(e.target.value);
  renderWeaponsTable(e.target.value);
  renderBuffsTable(e.target.value);
});

async function loadDeckLimit(){
  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action:'getDeckPointLimit' })
  });
  const json = await res.json();
  if(json.ok && json.limit !== null){
    document.getElementById('deckLimitInput').value = json.limit;
  }
}

document.getElementById('deckLimitBtn').addEventListener('click', async ()=>{
  const msgEl = document.getElementById('deckLimitMsg');
  const raw = document.getElementById('deckLimitInput').value;
  try{
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action:'updateDeckPointLimit', requesterId: ME.id, value: raw === '' ? '' : Number(raw) })
    });
    const json = await res.json();
    if(!json.ok) throw new Error(json.msg);
    msgEl.textContent = 'Salvo!';
    msgEl.className = 'msg ok';
  } catch(e){
    msgEl.textContent = e.message;
    msgEl.className = 'msg error';
  }
});

async function boot(){
  ME = await getSession();
  if(!ME || !ME.isAdmin){
    document.getElementById('loadingBox').classList.add('hidden');
    document.getElementById('notAuthorized').classList.remove('hidden');
    return;
  }

  try{
    const catalogo = await loadCatalog();
    CHAR_CATALOG = catalogo.characters;
    WEAPON_CATALOG = catalogo.weapons;
    renderCharsTable('');
    renderWeaponsTable('');
    BUFF_CATALOG = await loadBuffCatalog();
    renderBuffsTable('');
    await loadDeckLimit();
    document.getElementById('loadingBox').classList.add('hidden');
    document.getElementById('deckLimitPanel').classList.remove('hidden');
    document.getElementById('adminPanel').classList.remove('hidden');
  } catch(e){
    document.getElementById('loadingBox').innerHTML = `<p style="color:var(--danger);">Erro ao carregar: ${e.message}</p>`;
  }
}
boot();
