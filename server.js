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
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

/* --------------------------------- State --------------------------------- */
const STATE = {
  handId: 0,
  stage: 'lobby', // lobby | preflop | flop | turn | river | showdown
  community: [],
  deck: [],
  players: [], // {id,name,socketId,seat,stack,inHand,folded,bet,cards:[]}
  dealerBtn: -1,
  currentPlayerIdx: -1,
  pot: 0,
  minRaiseTo: BIG_BLIND,
  tableOpen: true,
  actionLogFile: null,
  hasStarted: false,

  // per-street flow control
  roundFirstIdx: -1,     // who acts first on this street
  hasBetOrRaise: false,  // has there been any bet/raise this street?
  lastRaiserIdx: -1      // index of last raiser
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

/* -------------------------------- Logging --------------------------------- */
function initLogFile() {
  const dir = path.join(__dirname, 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const filename = `actions-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
  const filepath = path.join(dir, filename);
  const header = [
    'timestamp','handId','stage','event','playerId','playerName','action','amount','pot','stacksSnapshot'
  ].join(',') + '\n';
  fs.writeFileSync(filepath, header);
  STATE.actionLogFile = filepath;
  console.log('🪶 Log file created at:', filepath);
}
function logEvent({ event, player, action = '', amount = 0 }) {
  if (!STATE.actionLogFile) initLogFile();
  const stacksSnapshot = STATE.players.map(p => `${p.name}:${p.stack}`).join('|');
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
    safeCsv(stacksSnapshot)
  ].join(',') + '\n';
  fs.appendFileSync(STATE.actionLogFile, line);
}
function stacksSnapshotEvent(label) {
  logEvent({ event: label, player: null });
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
    players: STATE.players.map(p => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      inHand: p.inHand,
      folded: p.folded,
      bet: p.bet,
      cards: p.cards
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
    me: {
      id: me.id,
      name: me.name,
      seat: me.seat,
      stack: me.stack,
      inHand: me.inHand,
      folded: me.folded,
      bet: me.bet,
      cards: me.cards
    },
    others: STATE.players.map((p, i) => ({
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      inHand: p.inHand && !p.folded,
      bet: p.bet,
      isMe: i === idx
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
  logEvent({ event: 'post_blind', player: p, action: 'blind', amount: blind });
}
function dealCommunity(n) {
  // burn one
  STATE.deck.pop();
  for (let i = 0; i < n; i++) STATE.community.push(STATE.deck.pop());
}

function startHand() {
  if (STATE.players.length < 2) return;

  STATE.hasStarted = true;
  STATE.stage = 'preflop';
  STATE.handId += 1;
  STATE.community = [];
  STATE.pot = 0;
  STATE.minRaiseTo = BIG_BLIND;
  STATE.deck = shuffle(freshDeck());

  STATE.players.forEach(p => {
    p.inHand = p.stack > 0;
    p.folded = false;
    p.bet = 0;
    p.cards = [];
  });

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

  stacksSnapshotEvent(`round_start_${STATE.stage}`);
  broadcastState();
}

function finishHand() {
  collectBetsToPot();
  const alive = STATE.players.filter(p => p.inHand && !p.folded);

  if (alive.length === 1) {
    alive[0].stack += STATE.pot;
    logEvent({ event: 'win_pot', player: alive[0], action: 'win', amount: STATE.pot });
  } else if (alive.length > 1) {
    // Evaluate each player's best 7-card hand with pokersolver
    const results = alive.map(p => {
      const allCards = [...STATE.community, ...p.cards];
      const hand = Hand.solve(allCards);
      return { player: p, hand };
    });

    const winners = Hand.winners(results.map(r => r.hand));
    const winnerPlayers = results.filter(r => winners.includes(r.hand));

    const share = Math.floor(STATE.pot / winnerPlayers.length);
    winnerPlayers.forEach(w => {
      w.player.stack += share;
      logEvent({
        event: 'win_pot',
        player: w.player,
        action: `win_${w.hand.name}`,
        amount: share
      });
    });
  }

  STATE.pot = 0;
  // auto-start next hand after short pause
  setTimeout(startHand, 1200);
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
    turnRotateOrAdvance();
    return;
  }

  if (action === 'check') {
    if (toCall === 0) {
      logEvent({ event: 'player_action', player: p, action: 'check', amount: 0 });
      turnRotateOrAdvance();
    }
    return;
  }

  if (action === 'call') {
    const callAmt = Math.min(Math.max(0, toCall), p.stack);
    p.stack -= callAmt;
    p.bet += callAmt;
    logEvent({ event: 'player_action', player: p, action: 'call', amount: callAmt });
    turnRotateOrAdvance();
    return;
  }

  if (action === 'bet' || action === 'raise') {
    const minRaise = Math.max(STATE.minRaiseTo, BIG_BLIND);
    const betAmt = Math.max(minRaise, Number(amount || 0));
    if (betAmt <= 0) return;

    const needed = toCall + betAmt;
    const pay = Math.min(needed, p.stack);

    p.stack -= pay;
    p.bet += pay;

    STATE.minRaiseTo = betAmt;
    STATE.hasBetOrRaise = true;
    STATE.lastRaiserIdx = idx;

    logEvent({
      event: 'player_action',
      player: p,
      action: toCall > 0 ? 'raise' : 'bet',
      amount: pay
    });

    // next to act after this player
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

  // Check if everyone has matched the highest bet (or everyone is all-in/folded)
  const activeBets = STATE.players
    .filter(p => p.inHand && !p.folded)
    .map(p => p.bet);
  const allEqual = activeBets.length > 0 && activeBets.every(b => b === activeBets[0]);

  // If there was a bet/raise and now all active bets are equal -> advance
  if (STATE.hasBetOrRaise && allEqual) {
    advanceStage();
    return;
  }

  // Otherwise move to next player
  const nextIdx = nextActivePlayer(STATE.currentPlayerIdx);
  STATE.currentPlayerIdx = nextIdx;

  // If no one bet/raised this street and we wrapped to first actor -> advance
  if (!STATE.hasBetOrRaise && STATE.currentPlayerIdx === STATE.roundFirstIdx) {
    advanceStage();
    return;
  }

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
      cards: []
    };

    STATE.players.push(player);
    logEvent({ event: 'player_join', player });
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

  socket.on('disconnect', () => {
    const idx = playerIndexBySocket(socket.id);
    if (idx !== -1) {
      const p = STATE.players[idx];
      logEvent({ event: 'player_disconnect', player: p });
      p.inHand = false;
      p.folded = true;
      p.socketId = null;
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

