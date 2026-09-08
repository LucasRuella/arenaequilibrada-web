/* ============================================================
   ArenaEquilibrada — PWA logic
   Lê peladas do Supabase via REST API (PostgREST).
   ============================================================ */

(() => {
  'use strict';

  // ---------- Configuração ----------
  // IMPORTANTE: substitua os valores abaixo com as credenciais do seu
  // projeto Supabase antes de publicar a PWA.
  //
  // - SUPABASE_URL: o "Project URL" do dashboard do Supabase
  //   (Project Settings → API → Project URL)
  // - SUPABASE_ANON_KEY: a chave "Publishable" (anon) — pode ser pública
  //   (Project Settings → API → Publishable key / anon public)
  //
  // A segurança vem das RLS policies no banco, não do segredo da chave.
  const SUPABASE_URL = 'https://jfaygnbhhminmgylkamx.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_ZraTiNqO50PmBJIRxvT5rA_O3fSEBF3';

  // Endpoint REST do Supabase (PostgREST).
  const REST_BASE = `${SUPABASE_URL}/rest/v1`;

  // Pontuação padrão (mesma do ScoringConfig do app).
  const SCORING = {
    winPoints: 3,
    drawPoints: 1,
    lossPoints: 0,
    peladaVictoryBonus: 10,
    peladaDrawBonus: 5,
    goalPoints: 2,
    assistPoints: 1,
  };

  // SVG inline de chuteira. Usado em vez de emoji 👟 porque o glifo
  // varia entre sistemas (em fontes antigas cai em outro caractere).
  const SHOE_SVG = '<svg class="icon-shoe" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 16h20v3H2zM3 16V11c0-1.5 1-2.5 2.5-2.5h7C14 8.5 15 9.5 15 11l.5.5c1 1 1.5 2 1.5 3v1H3z"/><g fill="none" stroke="white" stroke-width="0.7" stroke-linecap="round"><line x1="6" y1="11" x2="13" y2="11"/><line x1="6" y1="13" x2="13" y2="13"/><line x1="6" y1="15" x2="13" y2="15"/></g><g fill="currentColor"><circle cx="5" cy="20" r="1"/><circle cx="9" cy="20" r="1"/><circle cx="13" cy="20" r="1"/><circle cx="17" cy="20" r="1"/></g></svg>';

  // Cores de time (espelha TeamColor do app).
  const TEAM_COLORS = {
    PRETO:    '#212121',
    AMARELO:  '#FFC107',
    AZUL:     '#1976D2',
    VERMELHO: '#D32F2F',
    VERDE:    '#388E3C',
    BRANCO:   '#FAFAFA',
  };

  // ---------- Estado ----------
  const state = {
    organizerId: null,
    peladas: [], // [pelada] — TODAS (sem filtro)
    peladasFiltered: [], // [pelada] — após aplicar filtro de período
    players: new Map(), // id -> { name, mainPosition, isGoalkeeper }
    aggregated: null,
    groupName: '', // nome do grupo (NICKNAME do organizador)
    filterYear: 'all', // 'all' | 'YYYY'
    filterMonth: 'all', // 'all' | '0-11'
  };

  // Nomes de meses em pt-BR.
  const MONTH_NAMES = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
  ];

  // ---------- Helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const show = (el) => { el.hidden = false; };
  const hide = (el) => { el.hidden = true; };
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric',
    });
  };
  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

  // ---------- Boot ----------
  function boot() {
    const organizerId = getOrganizerIdFromUrl();
    if (!organizerId) {
      showError('Link inválido. Use o link enviado pelo organizador.');
      return;
    }
    if (SUPABASE_ANON_KEY === 'SUBSTITUIR_PELA_CHAVE_PUBLISHABLE') {
      showError('PWA não configurada. Edite o arquivo app.js e preencha SUPABASE_URL e SUPABASE_ANON_KEY.');
      return;
    }
    state.organizerId = organizerId;
    load();
  }

  function getOrganizerIdFromUrl() {
    // Suporta ?org=ID e /v/ID
    const url = new URL(window.location.href);
    const queryOrg = url.searchParams.get('org');
    if (queryOrg) return queryOrg;
    const m = window.location.pathname.match(/\/v\/([0-9a-fA-F-]+)/);
    if (m) return m[1];
    return null;
  }

  // ---------- Carregamento ----------
  async function load() {
    try {
      const rows = await fetchPeladas(state.organizerId);
      if (rows.length === 0) {
        hide($('#loading'));
        show($('#empty'));
        $('#subtitle').textContent = 'Nenhuma pelada ainda';
        return;
      }

      // Cada row do Supabase é uma pelada única (snapshot no formato flat:
      // {id, date, mode, teams, games, players, ...}). A PWA trata cada
      // row como uma pelada individual, não como um envelope {peladas:[]}.
      const allPeladas = [];
      let groupName = '';
      for (const row of rows) {
        const snap = row.snapshot;
        if (!snap || snap.id == null || !Array.isArray(snap.games)) continue;
        allPeladas.push(snap);
        // groupName é uma propriedade por pelada (mesmo valor em todas).
        if (!groupName && typeof snap.groupName === 'string' && snap.groupName.trim()) {
          groupName = snap.groupName.trim();
        }
        // Indexa jogadores referenciados nesta pelada.
        if (Array.isArray(snap.players)) {
          for (const pl of snap.players) {
            state.players.set(pl.id, {
              name: pl.name,
              mainPosition: pl.mainPosition,
              isGoalkeeper: !!pl.isGoalkeeper,
            });
          }
        }
      }

      // Ordena por data ascendente.
      allPeladas.sort((a, b) => new Date(a.date) - new Date(b.date));
      state.peladas = allPeladas;
      state.groupName = groupName;

      // Atualiza o topbar com o nome do grupo (se houver).
      applyGroupNameToTopbar();

      hide($('#loading'));
      show($('#content'));
      $('#generated-at').textContent = `atualizado ${new Date().toLocaleString('pt-BR')}`;

      // Popula e renderiza os filtros de ano/mês.
      renderFilters();

      // Aplica o filtro inicial e renderiza todas as listas.
      applyFilter();
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
    }
  }

  // Substitui "⚽ ArenaEquilibrada" no topbar pelo nome do grupo
  // (se estiver definido) ou mantém o logo padrão.
  function applyGroupNameToTopbar() {
    const logo = $('.logo');
    if (!logo) return;
    if (state.groupName) {
      logo.textContent = `⚽ ${state.groupName}`;
    } else {
      logo.textContent = '⚽ ArenaEquilibrada';
    }
  }

  // Popula os <select> de ano e mês com base nas peladas disponíveis.
  function renderFilters() {
    const yearSel = $('#filter-year');
    const monthSel = $('#filter-month');
    const filtersBox = $('#filters');
    if (!yearSel || !monthSel) return;

    const years = new Set();
    for (const p of state.peladas) {
      const d = new Date(p.date);
      if (!isNaN(d)) years.add(d.getFullYear());
    }
    const sortedYears = [...years].sort((a, b) => b - a); // mais recente primeiro

    yearSel.innerHTML = '<option value="all">Todos os anos</option>'
      + sortedYears.map((y) => `<option value="${y}">${y}</option>`).join('');

    monthSel.innerHTML = '<option value="all">Todos os meses</option>'
      + MONTH_NAMES.map((m, i) => `<option value="${i}">${m}</option>`).join('');

    yearSel.value = state.filterYear;
    monthSel.value = state.filterMonth;

    yearSel.onchange = () => {
      state.filterYear = yearSel.value;
      applyFilter();
    };
    monthSel.onchange = () => {
      state.filterMonth = monthSel.value;
      applyFilter();
    };

    // Mostra os filtros (escondidos até aqui). Se não houver peladas
    // com data válida, mantém escondidos.
    if (filtersBox) {
      if (sortedYears.length > 0) {
        show(filtersBox);
      } else {
        hide(filtersBox);
      }
    }
  }

  // Filtra state.peladas → state.peladasFiltered e re-renderiza tudo.
  function applyFilter() {
    const yearSel = $('#filter-year');
    const monthSel = $('#filter-month');
    const hasYear = state.filterYear !== 'all';
    const hasMonth = state.filterMonth !== 'all';

    state.peladasFiltered = state.peladas.filter((p) => {
      const d = new Date(p.date);
      if (isNaN(d)) return false;
      if (hasYear && d.getFullYear() !== Number(state.filterYear)) return false;
      if (hasMonth && d.getMonth() !== Number(state.filterMonth)) return false;
      return true;
    });

    // Texto do subtitle reflete o filtro.
    const total = state.peladasFiltered.length;
    const totalAll = state.peladas.length;
    let label;
    if (total === totalAll) {
      label = `${total} pelada${total === 1 ? '' : 's'} finalizada${total === 1 ? '' : 's'}`;
    } else {
      label = `${total} de ${totalAll} pelada${totalAll === 1 ? '' : 's'} no período`;
    }
    $('#subtitle').textContent = label;

    if (yearSel) yearSel.disabled = false;
    if (monthSel) monthSel.disabled = false;

    state.aggregated = computeRankings(state.peladasFiltered);
    renderRankings();
    renderScorers();
    renderAssists();
    renderHistory();
    setupTabs();
  }

  function showError(message) {
    hide($('#loading'));
    show($('#error-box'));
    $('#error-message').textContent = message;
  }

  // ---------- Supabase REST API ----------
  async function fetchPeladas(organizerId) {
    // PostgREST: filtra por organizer_id e ordena por pelada_date desc.
    const url = new URL(`${REST_BASE}/peladas`);
    url.searchParams.set('select', '*');
    url.searchParams.set('organizer_id', `eq.${organizerId}`);
    url.searchParams.set('order', 'pelada_date.desc');
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Supabase retornou ${res.status}. Verifique se a chave está correta e se a RLS permite leitura. (${text.slice(0, 120)})`
      );
    }
    return res.json();
  }

  // ---------- Cálculo de rankings ----------
  function computeRankings(peladas) {
    const stats = new Map();
    const ensure = (id) => {
      if (!stats.has(id)) {
        stats.set(id, {
          goals: 0, assists: 0,
          wins: 0, draws: 0, losses: 0,
          peladaWins: 0, peladaDraws: 0,
        });
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
          const playerIds = [
            ...(t.players || []),
            ...(t.goalkeeper != null ? [t.goalkeeper] : []),
          ];
          for (const pid of playerIds) {
            const s = ensure(pid);
            if (isDraw) s.draws++;
            else if ((isHome && homeWin) || (!isHome && !homeWin)) s.wins++;
            else s.losses++;
          }
        }
        for (const e of game.events || []) {
          // Evento pode ser: (a) só gol, (b) gol + assistência,
          // (c) só assistência (evento separado). Cada um precisa
          // ser contabilizado de forma independente.
          if (e.scorerId && e.scorerId !== 0) {
            ensure(e.scorerId).goals++;
          }
          if (e.assistId) {
            ensure(e.assistId).assists++;
          }
        }
      }

      if (peladaDrawn) {
        for (const pid of playerTeam.keys()) ensure(pid).peladaDraws++;
      } else if (peladaWinner) {
        for (const [pid, tid] of playerTeam.entries()) {
          if (tid === peladaWinner) ensure(pid).peladaWins++;
        }
      }
    }

    const ranking = [];
    for (const [playerId, s] of stats.entries()) {
      const bonus = s.peladaWins * SCORING.peladaVictoryBonus
                  + s.peladaDraws * SCORING.peladaDrawBonus;
      const points =
        s.wins * SCORING.winPoints
        + s.draws * SCORING.drawPoints
        + s.losses * SCORING.lossPoints
        + s.goals * SCORING.goalPoints
        + s.assists * SCORING.assistPoints
        + bonus;
      ranking.push({
        playerId,
        points,
        goals: s.goals,
        assists: s.assists,
        wins: s.wins,
        draws: s.draws,
        losses: s.losses,
      });
    }
    ranking.sort((a, b) => b.points - a.points);

    const topScorers = [...ranking]
      .sort((a, b) => b.goals - a.goals)
      .filter((r) => r.goals > 0)
      .slice(0, 50);

    const topAssisters = [...ranking]
      .sort((a, b) => b.assists - a.assists)
      .filter((r) => r.assists > 0)
      .slice(0, 50);

    return { ranking, topScorers, topAssisters };
  }

  // ---------- Renderização ----------
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

  function playerName(id) {
    return state.players.get(id)?.name || `Jogador #${id}`;
  }

  function rankBadgeClass(pos) {
    if (pos === 1) return 'rank gold';
    if (pos === 2) return 'rank silver';
    if (pos === 3) return 'rank bronze';
    return 'rank';
  }

  // Retorna o colorId do time ao qual o jogador pertence nesta pelada,
  // ou null se não encontrado. Usado para mostrar a cor do time nos
  // eventos do histórico.
  function teamColorIdForPlayer(pelada, playerId) {
    if (!pelada || !Array.isArray(pelada.teams)) return null;
    for (const t of pelada.teams) {
      if (Array.isArray(t.players) && t.players.includes(playerId)) return t.color;
      if (t.goalkeeper === playerId) return t.color;
    }
    return null;
  }

  // Badge circular com a cor do time. Cores claras (BRANCO/AMARELO)
  // ganham classe extra "light" para borda mais visível.
  function colorDotHtml(pelada, playerId) {
    const colorId = teamColorIdForPlayer(pelada, playerId);
    if (!colorId) return '';
    const isLight = colorId === 'BRANCO' || colorId === 'AMARELO';
    const cls = `color-dot color-${colorId}${isLight ? ' light' : ''}`;
    return `<span class="${cls}" title="${colorId}"></span>`;
  }

  function renderRankings() {
    const list = $('#rankings-list');
    if (!state.aggregated || !state.aggregated.ranking.length) {
      list.innerHTML = '<p class="hint">Sem dados no período selecionado.</p>';
      return;
    }
    list.innerHTML = state.aggregated.ranking
      .slice(0, 100)
      .map((r, i) => `
        <div class="list-item">
          <div class="${rankBadgeClass(i + 1)}">${i + 1}</div>
          <div class="list-main">
            <div class="list-name">${escapeHtml(playerName(r.playerId))}</div>
            <div class="list-sub">V:${r.wins} E:${r.draws} D:${r.losses} • ⚽${r.goals} ${SHOE_SVG} ${r.assists}</div>
          </div>
          <div class="list-value">${r.points.toFixed(0)}</div>
        </div>
      `).join('');
  }

  function renderScorers() {
    const list = $('#scorers-list');
    if (!state.aggregated) {
      list.innerHTML = '<p class="hint">Sem dados no período selecionado.</p>';
      return;
    }
    const top = state.aggregated.topScorers;
    if (!top.length) {
      list.innerHTML = '<p class="hint">Nenhum gol registrado no período.</p>';
      return;
    }
    list.innerHTML = top.map((r, i) => `
      <div class="list-item">
        <div class="${rankBadgeClass(i + 1)}">${i + 1}</div>
        <div class="list-main">
          <div class="list-name">${escapeHtml(playerName(r.playerId))}</div>
          <div class="list-sub">Artilharia</div>
        </div>
        <div class="list-value">⚽ ${r.goals}</div>
      </div>
    `).join('');
  }

  function renderAssists() {
    const list = $('#assists-list');
    if (!state.aggregated) {
      list.innerHTML = '<p class="hint">Sem dados no período selecionado.</p>';
      return;
    }
    const top = state.aggregated.topAssisters;
    if (!top.length) {
      list.innerHTML = '<p class="hint">Nenhuma assistência no período.</p>';
      return;
    }
    list.innerHTML = top.map((r, i) => `
      <div class="list-item">
        <div class="${rankBadgeClass(i + 1)}">${i + 1}</div>
        <div class="list-main">
          <div class="list-name">${escapeHtml(playerName(r.playerId))}</div>
          <div class="list-sub">Assistências</div>
        </div>
        <div class="list-value">${SHOE_SVG} ${r.assists}</div>
      </div>
    `).join('');
  }

  function renderHistory() {
    const list = $('#history-list');
    const peladas = state.peladasFiltered;
    if (!peladas.length) {
      const msg = state.peladas.length === 0
        ? 'Sem peladas finalizadas.'
        : 'Nenhuma pelada no período selecionado.';
      list.innerHTML = `<p class="hint">${msg}</p>`;
      return;
    }
    list.innerHTML = peladas.map((p, idx) => {
      const turns = (p.games || []).length;
      const totalGoals = (p.games || []).reduce(
        (acc, g) => acc + g.homeScore + g.awayScore, 0,
      );
      const modeLabel = {
        NORMAL: 'Normal',
        AB: 'Rodízio A/B',
        KING: 'Rei da Quadra',
      }[p.mode] || p.mode;
      const title = p.nickname?.trim()
        ? `${fmtDate(p.date)} • ${escapeHtml(p.nickname)}`
        : fmtDate(p.date);
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
          <div class="pelada-details" id="${detailsId}">
            ${renderTurns(p)}
          </div>
        </div>
      `;
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
    if (!pelada.games || pelada.games.length === 0) {
      return '<p class="hint">Nenhum turno registrado.</p>';
    }
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
          ${renderEvents(pelada, g.events)}
        </div>
      `;
    }).join('');
  }

  // Recebe a pelada inteira para que possa resolver a cor do time
  // de cada jogador mencionado nos eventos.
  function renderEvents(pelada, events) {
    if (!events || events.length === 0) return '';
    const lines = events.map((e) => {
      if (e.ownGoal) {
        return `<div class="list-sub">${colorDotHtml(pelada, e.scorerId)}⚽ Gol contra de ${escapeHtml(playerName(e.scorerId))}</div>`;
      }
      if (e.scorerId) {
        const assist = e.assistId
          ? ` ${colorDotHtml(pelada, e.assistId)}${SHOE_SVG} ${escapeHtml(playerName(e.assistId))}`
          : '';
        return `<div class="list-sub">${colorDotHtml(pelada, e.scorerId)}⚽ ${escapeHtml(playerName(e.scorerId))}${assist}</div>`;
      }
      if (e.assistId) {
        return `<div class="list-sub">${colorDotHtml(pelada, e.assistId)}${SHOE_SVG} ${escapeHtml(playerName(e.assistId))}</div>`;
      }
      return '';
    }).filter(Boolean);
    return lines.join('');
  }

  // ---------- Start ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
