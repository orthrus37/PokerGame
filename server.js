/* server.js — Orthrus Poker Table (Texas Hold'em) */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Hand } = require('pokersolver');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

/* ----------------------------- Static + Root ----------------------------- */
app.get('/', (req, res) => {
  res.send(`
    <h2>Poker Table is running</h2>
    <p><a href="/host.html">Host UI</a> | <a href="/player.html">Player UI</a></p>
  `);
});
app.use(express.static(path.join(__dirname, 'public')));

/* --------------------------------- Consts -------------------------------- */
const TABLE_MAX = 6;
const STARTING_STACK = 2000;
const SMALL_BLIND = 25;
const BIG_BLIND = 50;

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

/* --------------------------------- State --------------------------------- */
const STATE = {
  handId: 0,
  stage: 'lobby', // lobby | preflop | flop | turn | river | showdown
  community: [],
  deck: [],
  // players: {id,name,socketId,seat,stack,inHand,folded,bet,cards,allIn,committed}
  players: [],
  dealerBtn: -1,
  currentPlayerIdx: -1,
  pot: 0,
  minRaiseTo: BIG_BLIND,
  tableOpen: true,
  actionLogFile: null,
  hasStarted: false,

  // per-street flow control
  roundFirstIdx: -1,
  hasBetOrRaise: false,
  lastRaiserIdx: -1,

  nextHandTimer: null,
  sidePotsPreview: []
};

/* ------------------------------- Utilities -------------------------------- */
function freshDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(`${r}${s}`);
  return d;
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function firstOpenSeat() {
  const taken = new Set(STATE.players.map(p => p.seat));
  for (let i = 0; i < TABLE_MAX; i++) if (!taken.has(i)) return i;
  return -1;
}
function playerIndexBySocket(sid) {
  return STATE.players.findIndex(p => p.socketId === sid);
}
function nextActivePlayer(fromIdx) {
  const n = STATE.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (fromIdx + k) % n;
    const p = STATE.players[i];
    if (p && p.inHand && !p.folded) return i;
  }
  return -1;
}
function resetBets() {
  STATE.players.forEach(p => { if (p.inHand && !p.folded) p.bet = 0; });
}
function collectBetsToPot() {
  STATE.pot += STATE.players.reduce((s, p) => s + (p.bet || 0), 0);
  STATE.players.forEach(p => { p.bet = 0; });
}
function safeCsv(s) { return `"${String(s).replace(/"/g, '""')}"`; }

function removePlayerById(playerId) {
  const idx = STATE.players.findIndex(p => p.id === playerId);
  if (idx !== -1) {
    const p = STATE.players[idx];
    logEvent({ event: 'player_removed', player: p });
    STATE.players.splice(idx, 1);
    broadcastState();
  }
}

/* -------------------------------- Logging --------------------------------- */
function initLogFile() {
  const dir = path.join(__dirname, 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const filename = `actions-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  const filepath = path.join(dir, filename);
  const header = [
    'timestamp','handId','stage','event','playerId','playerName',
    'action','amount','pot','playerStack','playerHand','stacksSnapshot'
  ].join(',') + '\n';
  fs.writeFileSync(filepath, header);
  STATE.actionLogFile = filepath;
  console.log('🪶 Log file created at:', filepath);
}
function logEvent({ event, player, action = '', amount = 0 }) {
  if (!STATE.actionLogFile) initLogFile();
  const stacksSnapshot = STATE.players.map(p => `${p.name}:${p.stack}`).join('|');
  const playerHand = player && player.cards && player.cards.length ? player.cards.join(' ') : '';
  const playerStack = player ? player.stack : '';
  const line = [
    new Date().toISOString(),
    STATE.handId,
    STATE.stage,
    event,
    player ? player.id : '',
    player ? safeCsv(player.name) : '',
    action,
    amount,
    STATE.pot,
    playerStack,
    safeCsv(playerHand),
    safeCsv(stacksSnapshot)
  ].join(',') + '\n';
  fs.appendFileSync(STATE.actionLogFile, line);
}
function stacksSnapshotEvent(label) { logEvent({ event: label, player: null }); }

/* ---------------------- Side pots: preview & showdown --------------------- */
/**
 * Preview (non-mutating): build bands using ALL contributors (folded included) for amount;
 * show eligibility count using only non-folded players.
 */
function buildSidePotsPreview() {
  const contributors = STATE.players.filter(p => p.committed > 0);
  if (!contributors.length) return [];
  const levels = Array.from(new Set(contributors.map(p => p.committed))).sort((a,b)=>a-b);

  const pots = [];
  let prev = 0;
  for (const lvl of levels) {
    const band = Math.max(0, lvl - prev);
    if (band === 0) { prev = lvl; continue; }
    const contributorsCount = STATE.players.filter(p => p.committed >= lvl).length; // includes folded
    const eligibleCount = STATE.players.filter(p => p.inHand && !p.folded && p.committed >= lvl).length;
    if (eligibleCount >= 2) pots.push({ amount: band * contributorsCount, eligibleCount });
    prev = lvl;
  }
  return pots;
}

/**
 * Showdown (mutating): banded pots use ALL contributors for amount;
 * eligible set uses only non-folded players with committed >= level.
 * Refund unmatched overages when exactly one contributor reaches a band.
 */
function buildSidePotsWithRefunds() {
  const contributors = STATE.players.filter(p => p.committed > 0);
  const pots = [];
  const refundsById = new Map();
  let totalRefund = 0;

  if (!contributors.length) return { pots, refundsById, totalRefund };

  const levels = Array.from(new Set(contributors.map(p => p.committed))).sort((a,b)=>a-b);
  let prev = 0;

  for (const lvl of levels) {
    const band = Math.max(0, lvl - prev);
    if (band === 0) { prev = lvl; continue; }

    const contribs = STATE.players.filter(p => p.committed >= lvl); // includes folded
    const cCount = contribs.length;

    if (cCount === 1) {
      // unmatched overage -> refund this band to the sole contributor
      const sole = contribs[0];
      refundsById.set(sole.id, (refundsById.get(sole.id) || 0) + band);
      totalRefund += band;
    } else {
      const eligible = STATE.players.filter(p => p.inHand && !p.folded && p.committed >= lvl);
      if (eligible.length >= 1) {
        pots.push({ amount: band * cCount, eligibleIds: new Set(eligible.map(p => p.id)) });
      } else {
        // edge case: no one eligible; refund equally to contributors
        const each = band; // since amount = band * cCount; splitting equally => band each
        contribs.forEach(c => {
          refundsById.set(c.id, (refundsById.get(c.id) || 0) + each);
        });
        totalRefund += band * cCount;
      }
    }
    prev = lvl;
  }

  return { pots, refundsById, totalRefund };
}

function evaluateHandsAndPick(contenders) {
  return contenders.map(p => {
    const allCards = [...STATE.community, ...p.cards];
    const hand = Hand.solve(allCards);
    return { player: p, hand };
  });
}

function awardPot(pot, results) {
  const elig = results.filter(r => pot.eligibleIds.has(r.player.id));
  if (elig.length === 0) return pot.amount; // nothing awarded; carry (shouldn't happen in practice)
  const winners = Hand.winners(elig.map(r => r.hand));
  const winnerPlayers = elig.filter(r => winners.includes(r.hand));

  const share = Math.floor(pot.amount / winnerPlayers.length);
  let remainder = pot.amount - share * winnerPlayers.length;

  winnerPlayers.forEach(w => {
    w.player.stack += share;
    logEvent({ event: 'win_pot', player: w.player, action: `win_${w.hand.name}`, amount: share });
  });

  if (remainder > 0) {
    const ordered = winnerPlayers.slice().sort((a,b) => a.player.seat - b.player.seat);
    for (let i = 0; i < remainder; i++) {
      ordered[i % ordered.length].player.stack += 1;
    }
  }
  return 0;
}

function updateSidePotsPreview() {
  STATE.sidePotsPreview = buildSidePotsPreview();
}

/* --------------------------- Broadcast state ------------------------------ */
function sanitizeForHost() {
  return {
    handId: STATE.handId,
    stage: STATE.stage,
    community: STATE.community,
    pot: STATE.pot,
    dealerBtn: STATE.dealerBtn,
    currentPlayerIdx: STATE.currentPlayerIdx,
    currentPlayerId: STATE.players[STATE.currentPlayerIdx]?.id || null,
    minRaiseTo: STATE.minRaiseTo,
    sidePots: STATE.sidePotsPreview,
    players: STATE.players.map(p => ({
      id: p.id, name: p.name, seat: p.seat, stack: p.stack,
      inHand: p.inHand, folded: p.folded, bet: p.bet, allIn: !!p.allIn,
      committed: p.committed, cards: p.cards
    }))
  };
}
function sanitizeForPlayer(idx) {
  const me = STATE.players[idx];
  return {
    handId: STATE.handId,
    stage: STATE.stage,
    community: STATE.stage === 'lobby' ? [] : STATE.community,
    pot: STATE.pot,
    dealerBtn: STATE.dealerBtn,
    currentPlayerIdx: STATE.currentPlayerIdx,
    currentPlayerId: STATE.players[STATE.currentPlayerIdx]?.id || null,
    minRaiseTo: STATE.minRaiseTo,
    me: { id: me.id, name: me.name, seat: me.seat, stack: me.stack,
          inHand: me.inHand, folded: me.folded, bet: me.bet, cards: me.cards },
    others: STATE.players.map((p, i) => ({
      id: p.id, name: p.name, seat: p.seat, stack: p.stack,
      inHand: p.inHand && !p.folded, bet: p.bet, isMe: i === idx
    }))
  };
}
function broadcastState() {
  io.to('host').emit('state:update', sanitizeForHost());
  STATE.players.forEach((p, idx) => {
    if (p.socketId) io.to(p.socketId).emit('state:update', sanitizeForPlayer(idx));
  });
}

/* ------------------------------ Hand flow --------------------------------- */
function postBlind(idx, amt) {
  const p = STATE.players[idx];
  const blind = Math.min(amt, p.stack);
  p.stack -= blind;
  p.bet = blind;
  p.committed = (p.committed || 0) + blind;
  logEvent({ event: 'post_blind', player: p, action: 'blind', amount: blind });
}
function dealCommunity(n) {
  // burn
  STATE.deck.pop();
  for (let i = 0; i < n; i++) STATE.community.push(STATE.deck.pop());
}

function startHand() {
  STATE.players.forEach(p => {
    p.inHand = p.stack > 0;
    p.folded = false;
    p.allIn = false;
    p.bet = 0;
    p.committed = 0;
    p.cards = [];
  });

  if (STATE.players.length < 2) return;

  STATE.hasStarted = true;
  STATE.stage = 'preflop';
  STATE.handId += 1;
  STATE.community = [];
  STATE.pot = 0;
  STATE.minRaiseTo = BIG_BLIND;
  STATE.deck = shuffle(freshDeck());

  STATE.dealerBtn = (STATE.dealerBtn + 1 + STATE.players.length) % STATE.players.length;

  // deal 2 cards each
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < STATE.players.length; i++) {
      STATE.players[i].cards.push(STATE.deck.pop());
    }
  }

  // blinds
  const sbIdx = (STATE.dealerBtn + 1) % STATE.players.length;
  const bbIdx = (STATE.dealerBtn + 2) % STATE.players.length;
  postBlind(sbIdx, SMALL_BLIND);
  postBlind(bbIdx, BIG_BLIND);

  // first to act preflop: left of BB
  STATE.currentPlayerIdx = (STATE.dealerBtn + 3) % STATE.players.length;
  STATE.roundFirstIdx = STATE.currentPlayerIdx;
  STATE.hasBetOrRaise = false;
  STATE.lastRaiserIdx = -1;

  updateSidePotsPreview();
  stacksSnapshotEvent('round_start_preflop');
  broadcastState();
}

function advanceStage() {
  const alive = STATE.players.filter(p => p.inHand && !p.folded);
  if (alive.length <= 1) {
    STATE.stage = 'showdown';
    finishHand();
    return;
  }

  collectBetsToPot();

  const next = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' };
  STATE.stage = next[STATE.stage] || 'showdown';
  if (STATE.stage === 'showdown') {
    finishHand();
    return;
  }

  if (STATE.stage === 'flop') dealCommunity(3);
  if (STATE.stage === 'turn' || STATE.stage === 'river') dealCommunity(1);

  resetBets();
  STATE.minRaiseTo = BIG_BLIND;

  // postflop first to act: left of dealer
  STATE.roundFirstIdx = nextActivePlayer(STATE.dealerBtn);
  STATE.currentPlayerIdx = STATE.roundFirstIdx;
  STATE.hasBetOrRaise = false;
  STATE.lastRaiserIdx = -1;

  updateSidePotsPreview();
  stacksSnapshotEvent(`round_start_${STATE.stage}`);
  broadcastState();
}

function finishHand() {
  collectBetsToPot();

  const alive = STATE.players.filter(p => p.inHand && !p.folded);

  if (alive.length === 1) {
    alive[0].stack += STATE.pot;
    logEvent({ event: 'win_pot', player: alive[0], action: 'win', amount: STATE.pot });
    STATE.pot = 0;
  } else if (alive.length > 1) {
    const { pots, refundsById, totalRefund } = buildSidePotsWithRefunds();

    // Apply refunds first
    if (totalRefund > 0) {
      refundsById.forEach((amt, pid) => {
        const pl = STATE.players.find(pp => pp.id === pid);
        if (pl) {
          pl.stack += amt;
          logEvent({ event: 'refund_unmatched', player: pl, action: 'refund', amount: amt });
        }
      });
      STATE.pot = Math.max(0, STATE.pot - totalRefund);
    }

    const results = evaluateHandsAndPick(alive);
    for (const pot of pots) {
      awardPot(pot, results);
    }

    STATE.pot = 0; // distributed
  }

  // Auto-remove busted
  const busted = STATE.players.filter(p => p.stack <= 0);
  if (busted.length > 0) {
    busted.forEach(p => logEvent({ event: 'player_busted', player: p }));
    STATE.players = STATE.players.filter(p => p.stack > 0);
  }

  STATE.sidePotsPreview = [];

  if (STATE.players.length >= 2) {
    if (STATE.nextHandTimer) clearTimeout(STATE.nextHandTimer);
    STATE.nextHandTimer = setTimeout(startHand, 8000);
  }

  broadcastState();
}

/* ------------------------------ Actions ----------------------------------- */
function handleAction(socket, { action, amount }) {
  const idx = playerIndexBySocket(socket.id);
  if (idx === -1) return;
  if (idx !== STATE.currentPlayerIdx) return;

  const p = STATE.players[idx];
  if (!p.inHand || p.folded) return;

  const toCall = Math.max(...STATE.players.map(pl => pl.bet)) - p.bet;

  if (action === 'fold') {
    p.folded = true;
    logEvent({ event: 'player_action', player: p, action: 'fold', amount: 0 });
    updateSidePotsPreview();
    turnRotateOrAdvance();
    return;
  }

  if (action === 'check') {
    if (toCall === 0) {
      logEvent({ event: 'player_action', player: p, action: 'check', amount: 0 });
      updateSidePotsPreview();
      turnRotateOrAdvance();
    }
    return;
  }

  if (action === 'call') {
    const callAmt = Math.min(toCall, p.stack);
    p.stack -= callAmt;
    p.bet += callAmt;
    p.committed += callAmt;
    if (p.stack === 0) p.allIn = true;

    logEvent({ event: 'player_action', player: p, action: p.allIn ? 'allin_call' : 'call', amount: callAmt });
    updateSidePotsPreview();
    turnRotateOrAdvance();
    return;
  }

  if (action === 'bet' || action === 'raise') {
    const minRaise = Math.max(STATE.minRaiseTo, BIG_BLIND);
    const raiseTo = Math.max(minRaise, Number(amount || 0)); // interpret as "raise to"
    const toPay = toCall + raiseTo;
    const pay = Math.min(toPay, p.stack); // capped at stack

    p.stack -= pay;
    p.bet += pay;
    p.committed += pay;
    if (p.stack === 0) p.allIn = true;

    STATE.minRaiseTo = raiseTo;
    STATE.hasBetOrRaise = true;
    STATE.lastRaiserIdx = idx;

    logEvent({
      event: 'player_action',
      player: p,
      action: p.allIn ? 'allin_raise' : (toCall > 0 ? 'raise' : 'bet'),
      amount: pay
    });

    updateSidePotsPreview();
    STATE.currentPlayerIdx = nextActivePlayer(idx);
    broadcastState();
    return;
  }
}

/* --------------------- Turn rotation & stage advance ---------------------- */
function turnRotateOrAdvance() {
  const alive = STATE.players.filter(pp => pp.inHand && !pp.folded);
  if (alive.length <= 1) {
    STATE.stage = 'showdown';
    finishHand();
    return;
  }

  const activeBets = STATE.players
    .filter(p => p.inHand && !p.folded && !p.allIn)
    .map(p => p.bet);

  const maxBet = Math.max(...STATE.players.map(p => p.bet));
  const allEqual = activeBets.length === 0 || activeBets.every(b => b === maxBet);

  if (STATE.hasBetOrRaise && allEqual) {
    advanceStage();
    return;
  }

  let nextIdx = nextActivePlayer(STATE.currentPlayerIdx);
  let safetyCount = 0;

  while (
    safetyCount < STATE.players.length &&
    (!STATE.players[nextIdx].inHand ||
      STATE.players[nextIdx].folded ||
      STATE.players[nextIdx].allIn)
  ) {
    nextIdx = nextActivePlayer(nextIdx);
    safetyCount++;
  }

  STATE.currentPlayerIdx = nextIdx;

  if (!STATE.hasBetOrRaise && STATE.currentPlayerIdx === STATE.roundFirstIdx) {
    advanceStage();
    return;
  }

  broadcastState();
}

/* ------------------------------ Hard reset -------------------------------- */
function hardReset() {
  if (STATE.nextHandTimer) { clearTimeout(STATE.nextHandTimer); STATE.nextHandTimer = null; }
  logEvent({ event: 'hard_reset', player: null });

  STATE.handId = 0;
  STATE.stage = 'lobby';
  STATE.community = [];
  STATE.deck = [];
  STATE.players = [];
  STATE.dealerBtn = -1;
  STATE.currentPlayerIdx = -1;
  STATE.pot = 0;
  STATE.minRaiseTo = BIG_BLIND;
  STATE.tableOpen = true;
  STATE.hasStarted = false;
  STATE.roundFirstIdx = -1;
  STATE.hasBetOrRaise = false;
  STATE.lastRaiserIdx = -1;
  STATE.sidePotsPreview = [];

  broadcastState();
}

/* ------------------------------ Socket.IO --------------------------------- */
io.on('connection', (socket) => {
  socket.on('host:join', () => {
    socket.join('host');
    if (!STATE.actionLogFile) initLogFile();
    socket.emit('host:welcome', { ok: true });
    broadcastState();
  });

  socket.on('player:join', ({ name }) => {
    if (!STATE.tableOpen || STATE.players.length >= TABLE_MAX || STATE.hasStarted) {
      socket.emit('player:reject', { reason: 'Table full or game started' });
      return;
    }
    const seat = firstOpenSeat();
    if (seat === -1) {
      socket.emit('player:reject', { reason: 'No seats available' });
      return;
    }

    const player = {
      id: uuidv4(),
      name: String(name || `Player${STATE.players.length + 1}`).slice(0, 18),
      socketId: socket.id,
      seat,
      stack: STARTING_STACK,
      inHand: true,
      folded: false,
      bet: 0,
      cards: [],
      allIn: false,
      committed: 0
    };

    STATE.players.push(player);
    logEvent({ event: 'player_join', player });
    updateSidePotsPreview();
    broadcastState();
    socket.emit('player:accepted', { id: player.id });
  });

  socket.on('player:action', (payload) => handleAction(socket, payload));

  socket.on('host:start', () => {
    if (STATE.players.length >= 2 && !STATE.hasStarted) {
      STATE.tableOpen = false;
      startHand();
    }
  });

  socket.on('host:nextHandNow', () => {
    if (STATE.stage !== 'lobby') {
      STATE.stage = 'showdown';
      finishHand();
    }
  });

  socket.on('host:endGame', () => {
    hardReset();
  });

  socket.on('host:removePlayer', (playerId) => {
    // allow removal any time between hands or if host wants
    removePlayerById(playerId);
  });

  socket.on('disconnect', () => {
    const idx = playerIndexBySocket(socket.id);
    if (idx !== -1) {
      const p = STATE.players[idx];
      logEvent({ event: 'player_disconnect', player: p });
      p.inHand = false;
      p.folded = true;
      p.socketId = null;
      updateSidePotsPreview();
      broadcastState();
    }
  });
});

/* --------------------------- CSV download route --------------------------- */
app.get('/latest-log', (req, res) => {
  const dir = path.join(__dirname, 'logs');
  if (!fs.existsSync(dir)) return res.status(404).send('No logs folder yet.');
  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('actions-') && f.endsWith('.csv'))
    .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.time - a.time);
  if (!files.length) return res.status(404).send('No log files yet.');
  const latest = files[0].name;
  res.download(path.join(dir, latest), latest);
});

/* --------------------------------- Listen --------------------------------- */
server.listen(PORT, () => {
  console.log(`Poker table server listening on http://0.0.0.0:${PORT}`);
  console.log(`Host UI:   http://<server-ip>:${PORT}/host.html`);
  console.log(`Players:   http://<server-ip>:${PORT}/player.html`);
});
