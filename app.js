/* ArenaEquilibrada — PWA logic (Supabase) */
(() => {
  'use strict';
  const SUPABASE_URL = 'https://zfdnedvoyujcxacprrna.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_lKDQsn7yVdQfMhvigk6TBQ_Y9lV4FCh';
  const REST_BASE = `${SUPABASE_URL}/rest/v1`;
  const SCORING = { winPoints:3, drawPoints:1, lossPoints:0, peladaVictoryBonus:10, peladaDrawBonus:5, goalPoints:2, assistPoints:1 };
  const state = { organizerId:null, peladas:[], players:new Map(), aggregated:null };
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const show = el => { el.hidden = false; };
  const hide = el => { el.hidden = true; };
  const fmtDate = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'numeric'}); };
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function boot() {
    const id = getOrganizerIdFromUrl();
    if (!id) return showError('Link inválido. Use o link enviado pelo organizador.');
    if (SUPABASE_ANON_KEY === 'SUBSTITUIR_PELA_CHAVE_PUBLISHABLE') return showError('PWA não configurada. Edite app.js e preencha SUPABASE_ANON_KEY.');
    state.organizerId = id;
    load();
  }
  function getOrganizerIdFromUrl() {
    const u = new URL(window.location.href);
    const q = u.searchParams.get('org');
    if (q) return q;
    const m = window.location.pathname.match(/\/v\/([0-9a-fA-F-]+)/);
    return m ? m[1] : null;
  }
  function showError(m) { hide($('#loading')); show($('#error-box')); $('#error-message').textContent = m; }
  async function load() {
    try {
      const rows = await fetchPeladas(state.organizerId);
      if (!rows.length) { hide($('#loading')); show($('#empty')); $('#subtitle').textContent = 'Nenhuma pelada ainda'; return; }
      const all = [];
      for (const row of rows) {
        const s = row.snapshot;
        if (!s || !s.peladas) continue;
        for (const p of s.peladas) all.push(p);
        if (s.players) for (const pl of s.players) state.players.set(pl.id, { name: pl.name, mainPosition: pl.mainPosition, isGoalkeeper: !!pl.isGoalkeeper });
      }
      all.sort((a,b) => new Date(a.date) - new Date(b.date));
      state.peladas = all;
      state.aggregated = computeRankings(all);
      hide($('#loading')); show($('#content'));
      $('#subtitle').textContent = `${all.length} pelada${all.length===1?'':'s'} finalizada${all.length===1?'':'s'}`;
      $('#generated-at').textContent = `atualizado ${new Date().toLocaleString('pt-BR')}`;
      renderRankings(); renderScorers(); renderAssists(); renderHistory(); setupTabs();
    } catch (e) { console.error(e); showError(e.message || String(e)); }
  }
  async function fetchPeladas(id) {
    const u = new URL(`${REST_BASE}/peladas`);
    u.searchParams.set('select','*');
    u.searchParams.set('organizer_id', `eq.${id}`);
    u.searchParams.set('order','pelada_date.desc');
    const r = await fetch(u, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } });
    if (!r.ok) { const t = await r.text(); throw new Error(`Supabase ${r.status}: ${t.slice(0,120)}`); }
    return r.json();
  }
  function computeRankings(peladas) {
    const stats = new Map();
    const ensure = id => { if (!stats.has(id)) stats.set(id, { goals:0, assists:0, wins:0, draws:0, losses:0, peladaWins:0, peladaDraws:0 }); return stats.get(id); };
    const teamWinLoss = p => {
      const t = new Map();
      for (const g of p.games) { t.set(g.homeTeamId,(t.get(g.homeTeamId)||0)+g.homeScore); t.set(g.awayTeamId,(t.get(g.awayTeamId)||0)+g.awayScore); }
      const s = [...t.entries()].sort((a,b)=>b[1]-a[1]);
      if (s.length===0) return { winner:null, drawn:true };
      if (s.length===1) return { winner:s[0][0], drawn:false };
      if (s[0][1]===s[1][1]) return { winner:null, drawn:true };
      return { winner:s[0][0], drawn:false };
    };
    for (const p of peladas) {
      const { winner, drawn } = teamWinLoss(p);
      const pt = new Map();
      for (const t of p.teams || []) { for (const pid of t.players || []) pt.set(pid, t.id); if (t.goalkeeper != null) pt.set(t.goalkeeper, t.id); }
      for (const g of p.games) {
        const draw = g.homeScore === g.awayScore;
        const hw = g.homeScore > g.awayScore;
        for (const t of p.teams || []) {
          if (t.id !== g.homeTeamId && t.id !== g.awayTeamId) continue;
          const isHome = t.id === g.homeTeamId;
          const ids = [...(t.players||[]), ...(t.goalkeeper!=null?[t.goalkeeper]:[])];
          for (const pid of ids) { const s = ensure(pid); if (draw) s.draws++; else if ((isHome && hw) || (!isHome && !hw)) s.wins++; else s.losses++; }
        }
        for (const e of g.events || []) { if (e.scorerId && e.scorerId !== 0) { ensure(e.scorerId).goals++; if (e.assistId) ensure(e.assistId).assists++; } }
      }
      if (drawn) for (const pid of pt.keys()) ensure(pid).peladaDraws++;
      else if (winner) for (const [pid, tid] of pt.entries()) if (tid === winner) ensure(pid).peladaWins++;
    }
    const ranking = [];
    for (const [id, s] of stats.entries()) {
      const bonus = s.peladaWins*SCORING.peladaVictoryBonus + s.peladaDraws*SCORING.peladaDrawBonus;
      ranking.push({ playerId:id, points: s.wins*SCORING.winPoints + s.draws*SCORING.drawPoints + s.losses*SCORING.lossPoints + s.goals*SCORING.goalPoints + s.assists*SCORING.assistPoints + bonus, goals:s.goals, assists:s.assists, wins:s.wins, draws:s.draws, losses:s.losses });
    }
    ranking.sort((a,b)=>b.points-a.points);
    const topScorers = ranking.slice().sort((a,b)=>b.goals-a.goals).filter(r=>r.goals>0).slice(0,50);
    const topAssisters = ranking.slice().sort((a,b)=>b.assists-a.assists).filter(r=>r.assists>0).slice(0,50);
    return { ranking, topScorers, topAssisters };
  }
  function setupTabs() { $$('.tab').forEach(b => b.addEventListener('click', () => { $$('.tab').forEach(x => x.classList.remove('active')); b.classList.add('active'); $$('.tab-panel').forEach(p => p.classList.remove('active')); const p = $(`.tab-panel[data-panel="${b.dataset.tab}"]`); if (p) p.classList.add('active'); })); }
  function playerName(id) { return state.players.get(id)?.name || `Jogador #${id}`; }
  function rankBadgeClass(p) { if (p===1) return 'rank gold'; if (p===2) return 'rank silver'; if (p===3) return 'rank bronze'; return 'rank'; }
  function renderRankings() { const l = $('#rankings-list'); if (!state.aggregated.ranking.length) { l.innerHTML = '<p class="hint">Sem dados ainda.</p>'; return; } l.innerHTML = state.aggregated.ranking.slice(0,100).map((r,i) => `<div class="list-item"><div class="${rankBadgeClass(i+1)}">${i+1}</div><div class="list-main"><div class="list-name">${escapeHtml(playerName(r.playerId))}</div><div class="list-sub">V:${r.wins} E:${r.draws} D:${r.losses} • ⚽${r.goals} 🎯${r.assists}</div></div><div class="list-value">${r.points.toFixed(0)}</div></div>`).join(''); }
  function renderScorers() { const l = $('#scorers-list'); const t = state.aggregated.topScorers; if (!t.length) { l.innerHTML = '<p class="hint">Nenhum gol registrado ainda.</p>'; return; } l.innerHTML = t.map((r,i) => `<div class="list-item"><div class="${rankBadgeClass(i+1)}">${i+1}</div><div class="list-main"><div class="list-name">${escapeHtml(playerName(r.playerId))}</div><div class="list-sub">Artilharia</div></div><div class="list-value">⚽ ${r.goals}</div></div>`).join(''); }
  function renderAssists() { const l = $('#assists-list'); const t = state.aggregated.topAssisters; if (!t.length) { l.innerHTML = '<p class="hint">Nenhuma assistência registrada ainda.</p>'; return; } l.innerHTML = t.map((r,i) => `<div class="list-item"><div class="${rankBadgeClass(i+1)}">${i+1}</div><div class="list-main"><div class="list-name">${escapeHtml(playerName(r.playerId))}</div><div class="list-sub">Assistências</div></div><div class="list-value">🎯 ${r.assists}</div></div>`).join(''); }
  function renderHistory() { const l = $('#history-list'); if (!state.peladas.length) { l.innerHTML = '<p class="hint">Sem peladas finalizadas.</p>'; return; } l.innerHTML = state.peladas.map((p,idx) => { const turns = (p.games||[]).length; const total = (p.games||[]).reduce((a,g)=>a+g.homeScore+g.awayScore,0); const mode = {NORMAL:'Normal',AB:'Rodízio A/B',KING:'Rei da Quadra'}[p.mode]||p.mode; const title = p.nickname?.trim() ? `${fmtDate(p.date)} • ${escapeHtml(p.nickname)}` : fmtDate(p.date); const id = `details-${idx}`; return `<div class="pelada-card mode-${p.mode}"><div class="pelada-header"><div class="pelada-title">${title}</div><div class="pelada-date">${turns} turno${turns===1?'':'s'}</div></div><div class="pelada-mode mode-${p.mode}">${mode}</div><div class="pelada-summary"><div><strong>${total}</strong> gol${total===1?'':'s'}</div><div><strong>${(p.teams||[]).length}</strong> time${(p.teams||[]).length===1?'':'s'}</div></div><button class="pelada-toggle" data-target="${id}">Ver turnos ▾</button><div class="pelada-details" id="${id}">${renderTurns(p)}</div></div>`; }).join(''); $$('.pelada-toggle').forEach(b => b.addEventListener('click', () => { const t = $('#'+b.dataset.target); const o = t.classList.toggle('open'); b.textContent = o ? 'Ocultar turnos ▴' : 'Ver turnos ▾'; })); }
  function renderTurns(p) { if (!p.games || !p.games.length) return '<p class="hint">Nenhum turno registrado.</p>'; return p.games.map(g => { const tn = id => { const t = (p.teams||[]).find(x=>x.id===id); if (!t) return id; return `${t.color||''}${t.side?' '+t.side:''}`; }; return `<div class="turn"><strong>Turno ${g.turn}:</strong> <span class="turn-score">${g.homeScore} × ${g.awayScore}</span><div class="list-sub">${escapeHtml(tn(g.homeTeamId))} × ${escapeHtml(tn(g.awayTeamId))}</div>${renderEvents(g.events)}</div>`; }).join(''); }
  function renderEvents(ev) { if (!ev || !ev.length) return ''; return ev.map(e => { if (e.ownGoal) return `<div class="list-sub">⚽ Gol contra de ${escapeHtml(playerName(e.scorerId))}</div>`; if (e.scorerId) return `<div class="list-sub">⚽ ${escapeHtml(playerName(e.scorerId))}${e.assistId?` (assist: ${escapeHtml(playerName(e.assistId))})`:''}</div>`; if (e.assistId) return `<div class="list-sub">🎯 ${escapeHtml(playerName(e.assistId))}</div>`; return ''; }).filter(Boolean).join(''); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
