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
  sidePotsPreview: [] // for host UI
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
  console.log("🪶 Log file created at:", filepath);
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
 * Preview (non-mutating): Build bands using ALL contributors (folded included),
 * but show eligibility count using only non-folded players.
 */
function buildSidePotsPreview() {
  const everyone = STATE.players.filter(p => p.committed > 0); // contributors
  if (!everyone.length) return [];
  const levels = Array.from(new Set(everyone.map(p => p.committed))).sort((a,b)=>a-b);

  const pots = [];
  let prev = 0;
  for (const lvl of levels) {
    const band = Math.max(0, lvl - prev);
    if (band === 0) { prev = lvl; continue; }
    const contributorsCount = STATE.players.filter(p => p.committed >= lvl).length; // folded count too
    if (contributorsCount === 0) { prev = lvl; continue; }

    const eligibleCount = STATE.players.filter(p => p.inHand && !p.folded && p.committed >= lvl).length;
    // Only show bands that will be contested (>=2 eligible)
    if (eligibleCount >= 2) {
      pots.push({ amount: band * contributorsCount, eligibleCount });
    }
    prev = lvl;
  }
  return pots;
}

/**
 * Showdown (mutating): Build banded pots using ALL contributors for amounts,
 * eligibility sets using only non-folded players. Refund unmatched overages
 * when exactly one contributor reached a band.
 *
 * Returns { pots: [{amount, eligibleIds}], refundsById, totalRefund }.
 */
function buildSidePotsWithRefunds() {
  const everyone = STATE.players.filter(p => p.committed > 0); // contributors
  const pots = [];
  const refundsById = new Map();
  let totalRefund = 0;

  if (!everyone.length) return { pots, refundsById, totalRefund };

  const levels = Array.from(new Set(everyone.map(p => p.committed))).sort((a,b)=>a-b);

  let prev = 0;
  for (const lvl of levels) {
    const band = Math.max(0, lvl - prev);
    if (band === 0) { prev = lvl; continue; }

    const contributors = STATE.players.filter(p => p.committed >= lvl); // includes folded
    const contributorsCount = contributors.length;

    if (contributorsCount === 1) {
      // True unmatched overage: refund this band to the sole contributor
      const sole = contributors[0];
      const r = (refundsById.get(sole.id) || 0) + band;
      refundsById.set(sole.id, r);
      totalRefund += band;
    } else {
      // This band forms a pot of band * contributorsCount
      const eligible = STATE.players.filter(p => p.inHand && !p.folded && p.committed >= lvl);
      if (eligible.length >= 1) {
        pots.push({
          amount: band * contributorsCount,
          eligibleIds: new Set(eligible.map(p => p.id))
        });
      } else {
        // No one left eligible (edge case): treat as refund split back to


