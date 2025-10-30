/* server.js */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Static files
app.use(express.static(path.join(__dirname, 'public')));
// --- Serve the latest CSV log file to host
app.get('/latest-log', (req, res) => {
  const dir = path.join(__dirname, 'logs');
  if (!fs.existsSync(dir)) return res.status(404).send('No logs folder yet.');

  const files = fs.readdirSync(dir)
    .filter(f => f.startsWith('actions-') && f.endsWith('.csv'))
    .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtime }))
    .sort((a, b) => b.time - a.time);

  if (!files.length) return res.status(404).send('No log files yet.');

  const latest = files[0].name;
  const filePath = path.join(dir, latest);
  res.download(filePath, latest);  // prompts browser to download
});


// --- Simple in-memory game state (single table)
const TABLE_MAX = 6;
const STARTING_STACK = 2000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

const STATE = {
  handId: 0,
  stage: 'lobby', // lobby | preflop | flop | turn | river | showdown
  community: [],
  deck: [],
  players: [], // {id, name, socketId, stack, inHand, folded, bet, cards:[], seat}
  dealerBtn: -1,
  currentPlayerIdx: -1,
  pot: 0,
  minRaiseTo: BIG_BLIND,
  tableOpen: true,
  actionLogFile: null, // CSV file path
  hasStarted: false
  roundFirstIdx: -1,
  hasBetOrRaise: false,
  lastRaiserIdx: -1,

};

// --- Utility: create/append CSV log
function initLogFile() {
  const dir = path.join(__dirname, 'logs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const filename = `actions-${new Date().toISOString().replace(/[:.]/g,'-')}.csv`;
  const filepath = path.join(dir, filename);
  const header = [
    'timestamp','handId','stage','event','playerId','playerName','action','amount',
    'pot','stacksSnapshot'
  ].join(',') + '\n';
  fs.writeFileSync(filepath, header);
  STATE.actionLogFile = filepath;
}

function logEvent({event, player, action='', amount=0}) {
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

function safeCsv(s){ return `"${String(s).replace(/"/g,'""')}"`; }

// --- Cards/deck helpers
const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','T','J','Q','K','A'];

function freshDeck(){
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(`${r}${s}`);
  return d;
}
function shuffle(a){
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

// --- Table helpers
function broadcastState() {
  // Host gets full info
  io.to('host').emit('state:update', sanitizeForHost());
  // Each player gets only their own hole cards
  STATE.players.forEach((p, idx) => {
    const payload = sanitizeForPlayer(idx);
    if (p.socketId) io.to(p.socketId).emit('state:update', payload);
  });
}

function sanitizeForHost(){
  return {
    handId: STATE.handId,
    stage: STATE.stage,
    community: STATE.community,
    pot: STATE.pot,
    dealerBtn: STATE.dealerBtn,
    currentPlayerIdx: STATE.currentPlayerIdx,
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

function sanitizeForPlayer(idx){
  const me = STATE.players[idx];
  return {
    handId: STATE.handId,
    stage: STATE.stage,
    community: STATE.stage==='lobby' ? [] : STATE.community,
    pot: STATE.pot,
    dealerBtn: STATE.dealerBtn,
    currentPlayerIdx: STATE.currentPlayerIdx,
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
    others: STATE.players.map((p,i)=>({
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      inHand: p.inHand && !p.folded,
      bet: p.bet,
      isMe: i===idx
    }))
  };
}

function seatOpen(i){ return !STATE.players[i]; }
function firstOpenSeat(){
  for (let i=0;i<TABLE_MAX;i++){
    if (!STATE.players.find(p=>p.seat===i)) return i;
  }
  return -1;
}

function playerIndexBySocket(socketId){
  return STATE.players.findIndex(p => p.socketId === socketId);
}
function playerIndexById(id){
  return STATE.players.findIndex(p => p.id === id);
}

function nextActivePlayer(fromIdx){
  const n = STATE.players.length;
  for (let k=1;k<=n;k++){
    const i = (fromIdx + k) % n;
    const p = STATE.players[i];
    if (p && p.inHand && !p.folded && p.stack > 0) return i;
  }
  return -1;
}
function allBetsEqualOrAllIn(){
  const active = STATE.players.filter(p=>p.inHand && !p.folded);
  if (active.length <= 1) return true;
  const bets = active.map(p=>p.bet);
  const max = Math.max(...bets);
  const min = Math.min(...bets);
  // if someone can still act and bets equal, betting round can end
  return max === min;
}

function resetBets(){
  STATE.players.forEach(p => { if (p.inHand && !p.folded) p.bet = 0; });
}

function collectBetsToPot(){
  const total = STATE.players.reduce((s,p)=> s + (p.bet||0), 0);
  STATE.pot += total;
  STATE.players.forEach(p => p.bet = 0);
}

function stacksSnapshotEvent(eventLabel){
  // Log stacks at start of betting rounds
  logEvent({ event: eventLabel, player: null });
}

// --- Game flow
function startHand(){
  if (STATE.players.length < 2) return;
  STATE.hasStarted = true;
  STATE.stage = 'preflop';
  STATE.handId += 1;
  STATE.community = [];
  STATE.pot = 0;
  STATE.minRaiseTo = BIG_BLIND;

  STATE.deck = shuffle(freshDeck());

  // Reset players
  STATE.players.forEach(p=>{
    p.inHand = p.stack > 0;
    p.folded = false;
    p.bet = 0;
    p.cards = [];
  });

  // Move dealer
  STATE.dealerBtn = (STATE.dealerBtn + 1) % STATE.players.length;

  // Deal two cards each
  for (let r=0;r<2;r++){
    for (let i=0;i<STATE.players.length;i++){
      const card = STATE.deck.pop();
      STATE.players[i].cards.push(card);
    }
  }

  // Blinds
  const sbIdx = (STATE.dealerBtn + 1) % STATE.players.length;
  const bbIdx = (STATE.dealerBtn + 2) % STATE.players.length;

  postBlind(sbIdx, SMALL_BLIND);
  postBlind(bbIdx, BIG_BLIND);

  // First to act preflop (UTG)
  STATE.currentPlayerIdx = (STATE.dealerBtn + 3) % STATE.players.length;
  STATE.roundFirstIdx = STATE.currentPlayerIdx; // UTG preflop
  STATE.hasBetOrRaise = false;
  STATE.lastRaiserIdx = -1;


  stacksSnapshotEvent('round_start_preflop');
  broadcastState();
}

function postBlind(idx, amount){
  const p = STATE.players[idx];
  const blindAmt = Math.min(amount, p.stack);
  p.stack -= blindAmt;
  p.bet = blindAmt;
  logEvent({ event: 'post_blind', player: p, action: 'blind', amount: blindAmt });
}

function dealCommunity(n){
  // burn one
  STATE.deck.pop();
  for (let i=0;i<n;i++) STATE.community.push(STATE.deck.pop());
}

function advanceStage(){
  // If only one non-folded player, go to showdown immediately
  const alive = STATE.players.filter(p => p.inHand && !p.folded);
  if (alive.length <= 1) {
    STATE.stage = 'showdown';
    finishHand();
    return;
  }

  collectBetsToPot();

  if (STATE.stage === 'preflop') {
    STATE.stage = 'flop';
    dealCommunity(3);
    resetBets();
    STATE.minRaiseTo = BIG_BLIND;

    STATE.roundFirstIdx = nextActivePlayer(STATE.dealerBtn); // left of dealer
    STATE.currentPlayerIdx = STATE.roundFirstIdx;
    STATE.hasBetOrRaise = false;
    STATE.lastRaiserIdx = -1;

    stacksSnapshotEvent('round_start_flop');
  } else if (STATE.stage === 'flop') {
    STATE.stage = 'turn';
    dealCommunity(1);
    resetBets();

    STATE.roundFirstIdx = nextActivePlayer(STATE.dealerBtn);
    STATE.currentPlayerIdx = STATE.roundFirstIdx;
    STATE.hasBetOrRaise = false;
    STATE.lastRaiserIdx = -1;

    stacksSnapshotEvent('round_start_turn');
  } else if (STATE.stage === 'turn') {
    STATE.stage = 'river';
    dealCommunity(1);
    resetBets();

    STATE.roundFirstIdx = nextActivePlayer(STATE.dealerBtn);
    STATE.currentPlayerIdx = STATE.roundFirstIdx;
    STATE.hasBetOrRaise = false;
    STATE.lastRaiserIdx = -1;

    stacksSnapshotEvent('round_start_river');
  } else if (STATE.stage === 'river') {
    STATE.stage = 'showdown';
    finishHand();
    return;
  }

  broadcastState();
}

function finishHand(){
  collectBetsToPot();

  // SUPER-SIMPLE showdown resolver (placeholder):
  // If more than one player is alive, split pot equally among alive players.
  // (You can plug in a proper hand evaluator later.)
  const alive = STATE.players.filter(p => p.inHand && !p.folded);
  if (alive.length === 1) {
    alive[0].stack += STATE.pot;
    logEvent({ event: 'win_pot', player: alive[0], action: 'win', amount: STATE.pot });
  } else if (alive.length > 1) {
    const share = Math.floor(STATE.pot / alive.length);
    alive.forEach(p => {
      p.stack += share;
      logEvent({ event: 'split_pot', player: p, action: 'win_split', amount: share });
    });
  }
  STATE.pot = 0;

  // Remove players with zero stack from inHand (they can rebuy later if you extend)
  STATE.players.forEach(p => {
    if (p.stack <= 0) p.inHand = false;
  });

  // Short delay then start next hand automatically if host wants continuous play
  setTimeout(startHand, 2000);
  broadcastState();
}

// --- Player action handlers
function handleAction(socket, {action, amount}) {
  const idx = playerIndexBySocket(socket.id);
  if (idx === -1) return;
  if (idx !== STATE.currentPlayerIdx) return; // Not your turn

  const p = STATE.players[idx];
  if (!p.inHand || p.folded) return;

  const toCall = Math.max(...STATE.players.map(pl => pl.bet)) - p.bet;

  if (action === 'fold') {
    p.folded = true;
    logEvent({ event: 'player_action', player: p, action: 'fold', amount: 0 });
    turnRotateOrAdvance();
  } else if (action === 'check') {
    if (toCall === 0) {
      logEvent({ event: 'player_action', player: p, action: 'check', amount: 0 });
      turnRotateOrAdvance();
    }
  } else if (action === 'call') {
    const callAmt = Math.min(toCall, p.stack);
    p.stack -= callAmt;
    p.bet += callAmt;
    logEvent({ event: 'player_action', player: p, action: 'call', amount: callAmt });
    turnRotateOrAdvance();
  } else if (action === 'bet' || action === 'raise') {
    const minRaise = Math.max(STATE.minRaiseTo, BIG_BLIND);
    const betAmt = Math.max(minRaise, Number(amount||0));
    if (betAmt <= 0) return;
    const needed = toCall + betAmt;
    const pay = Math.min(needed, p.stack);

    p.stack -= pay;
    p.bet += pay;

    STATE.minRaiseTo = betAmt;
    STATE.hasBetOrRaise = true;
    STATE.lastRaiserIdx = idx;

    logEvent({ event: 'player_action', player: p, action: (toCall>0?'raise':'bet'), amount: pay });

    STATE.currentPlayerIdx = nextActivePlayer(idx);
    broadcastState();
  }

  }
}

function turnRotateOrAdvance(){
  // If only one left, done.
  const alive = STATE.players.filter(pp => pp.inHand && !pp.folded);
  if (alive.length <= 1) {
    STATE.stage = 'showdown';
    finishHand();
    return;
  }

  // Move to next player
  const nextIdx = nextActivePlayer(STATE.currentPlayerIdx);
  STATE.currentPlayerIdx = nextIdx;

  // End-of-round conditions:
  // 1) No one bet/raised this street -> advance when we return to the first actor
  if (!STATE.hasBetOrRaise) {
    if (STATE.currentPlayerIdx === STATE.roundFirstIdx) {
      advanceStage();
      return;
    }
  } else {
    // 2) There was a bet/raise -> advance when action returns to the last raiser
    if (STATE.currentPlayerIdx === STATE.lastRaiserIdx) {
      advanceStage();
      return;
    }
  }

  broadcastState();
}


// --- Socket.IO
io.on('connection', (socket) => {
  // Host joins special room
  socket.on('host:join', () => {
    socket.join('host');
    if (!STATE.actionLogFile) initLogFile();
    socket.emit('host:welcome', { ok: true });
    broadcastState();
  });

  // Player joins table
  socket.on('player:join', ({ name }) => {
    if (!STATE.tableOpen || STATE.players.length >= TABLE_MAX || STATE.hasStarted) {
      socket.emit('player:reject', { reason: 'Table full or game started' });
      return;
    }
    const seat = firstOpenSeat();
    if (seat === -1) {
      socket.emit('player:reject', { reason: 'No seats' });
      return;
    }
    const player = {
      id: uuidv4(),
      name: String(name || `Player${STATE.players.length+1}`).slice(0,18),
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

  socket.on('player:action', payload => handleAction(socket, payload));

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
      // Keep their seat but mark them out of hand
      p.inHand = false;
      p.folded = true;
      p.socketId = null;
      broadcastState();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Poker table server listening on http://0.0.0.0:${PORT}`);
  console.log(`Host UI:   http://<server-ip>:${PORT}/host.html`);
  console.log(`Players:   http://<server-ip>:${PORT}/player.html`);
});
