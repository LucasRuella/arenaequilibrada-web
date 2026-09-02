(() => {
  'use strict';
  const DRIVE_API = 'https://www.googleapis.com/drive/v3/files';
  const SCORING = {
    winPoints: 3, drawPoints: 1, lossPoints: 0,
    peladaVictoryBonus: 10, peladaDrawBonus: 5,
    goalPoints: 2, assistPoints: 1,
  };
  const state = { folderId: null, snapshots: [], players: new Map(), aggregated: null };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const show = (el) => { el.hidden = false; };
  const hide = (el) => { el.hidden = true; };
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  };
  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  function boot() {
    const folderId = getFolderIdFromUrl();
    if (!folderId) { showError('Link inválido. Use o link enviado pelo organizador.'); return; }
    state.folderId = folderId;
    load();
  }
  function getFolderIdFromUrl() {
    const url = new URL(window.location.href);
    const queryFolder = url.searchParams.get('folder');
    if (queryFolder) return queryFolder;
    const m = window.location.pathname.match(/\/v\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return null;
  }
  async function load() {
    try {
      const fileList = await listSnapshotsInFolder(state.folderId);
      if (fileList.length === 0) {
        hide($('#loading')); show($('#empty'));
        $('#subtitle').textContent = 'Nenhuma pelada ainda';
        return;
      }
      const snapshots = await Promise.all(fileList.map((f) => fetchSnapshot(f.id, f.name)));
      const allPeladas = [];
      for (const s of snapshots) {
        if (!s || !s.peladas) continue;
        for (const p of s.peladas) allPeladas.push(p);
        if (s.players) {
          for (const pl of s.players) {
            state.players.set(pl.id, {
              name: pl.name, mainPosition: pl.mainPosition, isGoalkeeper: !!pl.isGoalkeeper,
            });
          }
        }
      }
      allPeladas.sort((a, b) => new Date(a.date) - new Date(b.date));
      state.snapshots = allPeladas;
      state.aggregated = computeRankings(allPeladas);
      hide($('#loading')); show($('#content'));
      $('#subtitle').textContent = `${allPeladas.length} pelada${allPeladas.length === 1 ? '' : 's'} finalizada${allPeladas.length === 1 ? '' : 's'}`;
      $('#generated-at').textContent = `atualizado ${new Date().toLocaleString('pt-BR')}`;
      renderRankings(); renderScorers(); renderAssists(); renderHistory(); setupTabs();
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
    }
  }
  function showError(message) {
    hide($('#loading')); show($('#error-box'));
    $('#error-message').textContent = message;
  }
  async function listSnapshotsInFolder(folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and name contains 'snapshot_' and trashed = false`);
    const fields = encodeURIComponent('files(id,name,createdTime)');
    const url = `${DRIVE_API}?q=${q}&fields=${fields}&orderBy=createdTime desc`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Drive API retornou ${res.status}. A pasta está pública? (${text.slice(0, 120)})`);
    }
    const data = await res.json();
    return data.files || [];
  }
  async function fetchSnapshot(fileId, fileName) {
    const url = `${DRIVE_API}/${fileId}?alt=media`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao baixar ${fileName}: ${res.status}`);
    return res.json();
  }
  function computeRankings(peladas) {
    const stats = new Map();
    const ensure = (id) => {
      if (!stats.has(id)) {
        stats.set(id, { goals: 0, assists: 0, wins: 0, draws: 0, losses: 0, peladaWins: 0, peladaDraws: 0 });
      }
      return stats.get(id);
    };
    const teamWinLoss = (pelada) => {
      const totals = new Map();
      for (const g of pelada.games) {
        totals.set(g.homeTeamId, (totals.get(g.homeTeamId) || 0) + g.homeScore);
        totals.set(g.awayTeamId, (totals.get(g.awayTeamId) || 0) + g.awayScore);
      }
      const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted.length === 0) return { winner: null, drawn: true };
      if (sorted.length === 1) return { winner: sorted[0][0], drawn: false };
      if (sorted[0][1] === sorted[1][1]) return { winner: null, drawn: true };
      return { winner: sorted[0][0], drawn: false };
    };
    for (const pelada of peladas) {
      const { winner: peladaWinner, drawn: peladaDrawn } = teamWinLoss(pelada);
      const playerTeam = new Map();
      for (const t of pelada.teams || []) {
        for (const pid of t.players || []) playerTeam.set(pid, t.id);
        if (t.goalkeeper != null) playerTeam.set(t.goalkeeper, t.id);
      }
      for (const game of pelada.games) {
        const isDraw = game.homeScore === game.awayScore;
        const homeWin = game.homeScore > game.awayScore;
        for (const t of pelada.teams || []) {
          if (t.id !== game.homeTeamId && t.id !== game.awayTeamId) continue;
          const isHome = t.id === game.homeTeamId;
          const playerIds = [...(t.players || []), ...(t.goalkeeper != null ? [t.goalkeeper] : [])];
          for (const pid of playerIds) {
            const s = ensure(pid);
            if (isDraw) s.draws++;
            else if ((isHome && homeWin) || (!isHome && !homeWin)) s.wins++;
            else s.losses++;
          }
        }
        for (const e of game.events || []) {
          if (e.scorerId && e.scorerId !== 0) {
            ensure(e.scorerId).goals++;
            if (e.assistId) ensure(e.assistId).assists++;
          }
        }
      }
      if (peladaDrawn) {
        for (const pid of playerTeam.keys()) ensure(pid).peladaDraws++;
      } else if (peladaWinner) {
        for (const [pid, tid] of playerTeam.entries()) if (tid === peladaWinner) ensure(pid).peladaWins++;
      }
    }
    const ranking = [];
    for (const [playerId, s] of stats.entries()) {
      const bonus = s.peladaWins * SCORING.peladaVictoryBonus + s.peladaDraws * SCORING.peladaDrawBonus;
      const points = s.wins * SCORING.winPoints + s.draws * SCORING.drawPoints + s.losses * SCORING.lossPoints
        + s.goals * SCORING.goalPoints + s.assists * SCORING.assistPoints + bonus;
      ranking.push({ playerId, points, goals: s.goals, assists: s.assists, wins: s.wins, draws: s.draws, losses: s.losses });
    }
    ranking.sort((a, b) => b.points - a.points);
    const topScorers = [...ranking].sort((a, b) => b.goals - a.goals).filter((r) => r.goals > 0).slice(0, 50);
    const topAssisters = [...ranking].sort((a, b) => b.assists - a.assists).filter((r) => r.assists > 0).slice(0, 50);
    return { ranking, topScorers, topAssisters };
  }
  function setupTabs() {
    $$('.tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        $$('.tab-panel').forEach((p) => p.classList.remove('active'));
        const panel = $(`.tab-panel[data-panel="${btn.dataset.tab}"]`);
        if (panel) panel.classList.add('active');
      });
    });
  }
  function playerName(id) { return state.players.get(id)?.name || `Jogador #${id}`; }
  function rankBadgeClass(pos) {
    if (pos === 1) return 'rank gold';
    if (pos === 2) return 'rank silver';
    if (pos === 3) return 'rank bronze';
    return 'rank';
  }
  function renderRankings() {
    const list = $('#rankings-list');
    if (!state.aggregated.ranking.length) { list.innerHTML = '<p class="hint">Sem dados ainda.</p>'; return; }
    list.innerHTML = state.aggregated.ranking.slice(0, 100).map((r, i) => `
      <div class="list-item">
        <div class="${rankBadgeClass(i + 1)}">${i + 1}</div>
        <div class="list-main">
          <div class="list-name">${escapeHtml(playerName(r.playerId))}</div>
          <div class="list-sub">V:${r.wins} E:${r.draws} D:${r.losses} • ⚽${r.goals} 🎯${r.assists}</div>
        </div>
        <div class="list-value">${r.points.toFixed(0)}</div>
      </div>`).join('');
  }
  function renderScorers() {
    const list = $('#scorers-list');
    const top = state.aggregated.topScorers;
    if (!top.length) { list.innerHTML = '<p class="hint">Nenhum gol registrado ainda.</p>'; return; }
    list.innerHTML = top.map((r, i) => `
      <div class="list-item">
        <div class="${rankBadgeClass(i + 1)}">${i + 1}</div>
        <div class="list-main">
          <div class="list-name">${escapeHtml(playerName(r.playerId))}</div>
          <div class="list-sub">Artilharia</div>
        </div>
        <div class="list-value">⚽ ${r.goals}</div>
      </div>`).join('');
  }
  function renderAssists() {
    const list = $('#assists-list');
    const top = state.aggregated.topAssisters;
    if (!top.length) { list.innerHTML = '<p class="hint">Nenhuma assistência registrada ainda.</p>'; return; }
    list.innerHTML = top.map((r, i) => `
      <div class="list-item">
        <div class="${rankBadgeClass(i + 1)}">${i + 1}</div>
        <div class="list-main">
          <div class="list-name">${escapeHtml(playerName(r.playerId))}</div>
          <div class="list-sub">Assistências</div>
        </div>
        <div class="list-value">🎯 ${r.assists}</div>
      </div>`).join('');
  }
  function renderHistory() {
    const list = $('#history-list');
    if (!state.snapshots.length) { list.innerHTML = '<p class="hint">Sem peladas finalizadas.</p>'; return; }
    list.innerHTML = state.snapshots.map((p, idx) => {
      const turns = (p.games || []).length;
      const totalGoals = (p.games || []).reduce((acc, g) => acc + g.homeScore + g.awayScore, 0);
      const modeLabel = { NORMAL: 'Normal', AB: 'Rodízio A/B', KING: 'Rei da Quadra' }[p.mode] || p.mode;
      const title = p.nickname?.trim() ? `${fmtDate(p.date)} • ${escapeHtml(p.nickname)}` : fmtDate(p.date);
      const detailsId = `details-${idx}`;
      return `
        <div class="pelada-card mode-${p.mode}">
          <div class="pelada-header">
            <div class="pelada-title">${title}</div>
            <div class="pelada-date">${turns} turno${turns === 1 ? '' : 's'}</div>
          </div>
          <div class="pelada-mode mode-${p.mode}">${modeLabel}</div>
          <div class="pelada-summary">
            <div><strong>${totalGoals}</strong> gol${totalGoals === 1 ? '' : 's'}</div>
            <div><strong>${(p.teams || []).length}</strong> time${(p.teams || []).length === 1 ? '' : 's'}</div>
          </div>
          <button class="pelada-toggle" data-target="${detailsId}">Ver turnos ▾</button>
          <div class="pelada-details" id="${detailsId}">${renderTurns(p)}</div>
        </div>`;
    }).join('');
    $$('.pelada-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = $('#' + btn.dataset.target);
        const open = target.classList.toggle('open');
        btn.textContent = open ? 'Ocultar turnos ▴' : 'Ver turnos ▾';
      });
    });
  }
  function renderTurns(pelada) {
    if (!pelada.games || pelada.games.length === 0) return '<p class="hint">Nenhum turno registrado.</p>';
    return pelada.games.map((g) => {
      const teamName = (tid) => {
        const t = (pelada.teams || []).find((tt) => tt.id === tid);
        if (!t) return tid;
        const color = t.color || '';
        const side = t.side ? ` ${t.side}` : '';
        return `${color}${side}`;
      };
      return `
        <div class="turn">
          <strong>Turno ${g.turn}:</strong>
          <span class="turn-score">${g.homeScore} × ${g.awayScore}</span>
          <div class="list-sub">${escapeHtml(teamName(g.homeTeamId))} × ${escapeHtml(teamName(g.awayTeamId))}</div>
          ${renderEvents(g.events, pelada)}
        </div>`;
    }).join('');
  }
  function renderEvents(events, pelada) {
    if (!events || events.length === 0) return '';
    const lines = events.map((e) => {
      if (e.ownGoal) return `<div class="list-sub">⚽ Gol contra de ${escapeHtml(playerName(e.scorerId))}</div>`;
      if (e.scorerId) {
        const assist = e.assistId ? ` (assist: ${escapeHtml(playerName(e.assistId))})` : '';
        return `<div class="list-sub">⚽ ${escapeHtml(playerName(e.scorerId))}${assist}</div>`;
      }
      if (e.assistId) return `<div class="list-sub">🎯 ${escapeHtml(playerName(e.assistId))}</div>`;
      return '';
    }).filter(Boolean);
    return lines.join('');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
