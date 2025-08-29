// Dominion Deck Simulator
// Assumes Base-set like effects. Please confirm Merchant behavior.

// Card database
const Cards = (() => {
  const byId = {
    curse: { id: 'curse', name: 'Curse', types: ['curse'], vp: -1 },
    estate: { id: 'estate', name: 'Estate', types: ['victory'], vp: 1 },
    duchy: { id: 'duchy', name: 'Duchy', types: ['victory'], vp: 3 },
    province: { id: 'province', name: 'Province', types: ['victory'], vp: 6 },
    copper: { id: 'copper', name: 'Copper', types: ['treasure'], coins: 1 },
    silver: { id: 'silver', name: 'Silver', types: ['treasure'], coins: 2 },
    gold: { id: 'gold', name: 'Gold', types: ['treasure'], coins: 3 },

    village: { id: 'village', name: 'Village', types: ['action'], draw: 1, actions: 2 },
    smithy: { id: 'smithy', name: 'Smithy', types: ['action'], draw: 3, actions: 0 },
    lab: { id: 'lab', name: 'Laboratory', types: ['action'], draw: 2, actions: 1 },
    festival: { id: 'festival', name: 'Festival', types: ['action'], draw: 0, actions: 2, buys: 1, coins: 2 },
    merchant: { id: 'merchant', name: 'Merchant', types: ['action'], draw: 1, actions: 1, merchant: true },
    market: { id: 'market', name: 'Market', types: ['action'], draw: 1, actions: 1, buys: 1, coins: 1 },
    council_room: { id: 'council_room', name: 'Council Room', types: ['action'], draw: 4, actions: 0, buys: 1 },
    peddler: { id: 'peddler', name: 'Peddler', types: ['action'], draw: 1, actions: 1, coins: 1 },
    moat: { id: 'moat', name: 'Moat', types: ['action'], draw: 2, actions: 0 },
  };

  // Name aliases to help parser
  const abbreviationToId = new Map([
    ['e', 'estate'],
    ['d', 'duchy'],
    ['p', 'province'],
    ['c', 'copper'],
    ['s', 'silver'],
    ['g', 'gold'],
    // Friendly name mappings for multi-word action cards
    ['council room', 'council_room'],
    ['councilroom', 'council_room'],
  ]);

  function fromName(cardNameOrAbbreviation) {
    const key = abbreviationToId.get(String(cardNameOrAbbreviation).trim().toLowerCase()) || cardNameOrAbbreviation;
    return byId[key];
  }

  return { byId, fromName };
})();

// RNG helpers (optionally seeded)
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedStr) {
  if (!seedStr) return Math.random;
  // simple string hash
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return mulberry32(h >>> 0);
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Parser: "7 copper, 3 estate, 3 lab, 1 village, 2 smithy"
function parseDeckList(input) {
  const errs = [];
  const counts = new Map();
  if (!input || !input.trim()) return { cards: [], errors: ['Deck list is empty'] };
  const parts = input.split(',');
  for (const raw of parts) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^(\d+)\s+(.+)$/);
    if (!m) {
      errs.push(`Could not parse: "${s}"`);
      continue;
    }
    const n = parseInt(m[1], 10);
    const name = m[2].trim();
    const card = Cards.fromName(name);
    if (!card) {
      errs.push(`Unknown card: "${name}"`);
      continue;
    }
    counts.set(card.id, (counts.get(card.id) || 0) + n);
  }
  const deck = [];
  for (const [id, n] of counts.entries()) {
    for (let i = 0; i < n; i++) deck.push(Cards.byId[id]);
  }
  return { cards: deck, errors: errs };
}

function isAction(c) {
  return c.types && c.types.includes('action');
}
function isTreasure(c) {
  return c.types && c.types.includes('treasure');
}

// One-turn simulator from a fixed deck composition
function simulateTurn(deckCards, rng) {
  // Copy + shuffle draw pile; no discard pile at start
  const draw = deckCards.slice();
  shuffleInPlace(draw, rng);

  const hand = [];
  const inPlay = [];
  const startingHand = 5;
  let deckEmptyEncountered = false;

  const drawOne = () => {
    if (draw.length === 0) {
      deckEmptyEncountered = true;
      return undefined;
    }
    return draw.pop();
  };

  let cardsDrawn = 0;
  for (let i = 0; i < startingHand; i++) {
    const c = drawOne();
    if (c) hand.push(c);
  }

  let actions = 1;
  let buys = 1;
  let coins = 0;
  let merchantCount = 0; // number of Merchants played before Treasures

  function nextActionCard() {
    const actionCards = hand.filter(isAction);
    if (actionCards.length === 0) return undefined;
    // Heuristic priority: prefer action gainers and drawers first; Smithy later
    actionCards.sort((a, b) => {
      const aActions = a.actions || 0;
      const bActions = b.actions || 0;
      if (bActions !== aActions) return bActions - aActions;
      const aDraw = a.draw || 0;
      const bDraw = b.draw || 0;
      if (bDraw !== aDraw) return bDraw - aDraw;
      const aBuys = a.buys || 0;
      const bBuys = b.buys || 0;
      if (bBuys !== aBuys) return bBuys - aBuys;
      const aCoins = a.coins || 0;
      const bCoins = b.coins || 0;
      if (bCoins !== aCoins) return bCoins - aCoins;
      if (a.merchant != b.merchant) return !!b.merchant - !!a.merchant;
      // actual good criteria exhausted; let's do arbitrary tie-winner
      if (a.id > b.id) return -1;
      if (a.id < b.id) return 1;
      return 0;
    });
    return actionCards[0];
  }

  let endReason = '';

  // Action phase
  while (actions > 0) {
    const next = nextActionCard();
    if (!next) {
      // No action cards left to play
      break;
    }
    // Play it
    actions -= 1;
    inPlay.push(next);
    const idx = hand.indexOf(next);
    if (idx >= 0) hand.splice(idx, 1);
    // Resolve effect
    const drawN = next.draw || 0;
    for (let i = 0; i < drawN; i++) {
      const c = drawOne();
      if (!c) break;
      hand.push(c);
      cardsDrawn += 1;
    }
    actions += next.actions || 0;
    buys += next.buys || 0;
    coins += next.coins || 0;
    if (next.merchant) merchantCount += 1;

    // If we still have actions but no action cards, loop will end next iteration
    if (actions === 0) {
      // Loop ends; reason determined after loop with priority rules
      break;
    }
  }

  // Buy/Treasure phase: play treasures, order to benefit Merchant: play a Silver first if present
  // We treat treasure play as automatic and total coins accordingly.
  let firstSilverPlayed = false;
  const treasures = hand.filter(isTreasure);
  // Silver first, then others
  const silver = treasures.filter((c) => c.id === 'silver');
  const others = treasures.filter((c) => c.id !== 'silver');
  if (silver.length) {
    // play one silver first
    coins += 2 + (merchantCount > 0 ? merchantCount : 0);
    firstSilverPlayed = true;
    if (silver.length > 1) coins += (silver.length - 1) * 2; // rest of silvers
  }
  for (const t of others) {
    coins += t.coins || 0;
  }

  // Determine end reason with priorities:
  // 1) whole deck drawn (all cards drawn)
  // 2) no actions (no actions remaining)
  // 3) no draw cards in hand (no action cards with draw>0 in hand while draw pile not empty)
  if (draw.length === 0) {
    endReason = 'whole deck drawn';
  } else if (actions === 0) {
    endReason = 'no actions';
  } else {
    const hasDrawActionInHand = hand.some((c) => isAction(c) && (c.draw || 0) > 0);
    if (!hasDrawActionInHand) endReason = 'no draw cards in hand';
    else endReason = 'no actions'; // fallback, though this case should rarely occur
  }

  return {
    cardsDrawn,
    coins,
    buys,
    endReason,
    deckEmptyEncountered,
  };
}

function histogram(values) {
  const map = new Map();
  for (const v of values) map.set(v, (map.get(v) || 0) + 1);
  // sort by numeric key asc
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
}

function formatHisto(entries, total) {
  if (!entries.length || total === 0) return '(no data)';
  let cumSoFar = 0; // count of values strictly less than current bucket
  const lines = [];
  const header = `val |   =n    |  >=n    |  <=n`;
  lines.push(header);
  for (let i = 0; i < entries.length; i++) {
    const [k, c] = entries[i];
    const pctExact = (c / total) * 100;
    const pctAtMost = ((cumSoFar + c) / total) * 100; // <= k
    const pctAtLeast = 100 - (cumSoFar / total) * 100; // >= k

    const kStr = String(k).padStart(3);
    const exactStr = `${pctExact.toFixed(1)}%`.padStart(7);
    const geStr = `${pctAtLeast.toFixed(1)}%`.padStart(7);
    const leStr = `${pctAtMost.toFixed(1)}%`.padStart(7);

    lines.push(`${kStr} | ${exactStr} | ${geStr} | ${leStr}`);
    cumSoFar += c;
  }
  return lines.join('\n');
}

function countBy(arr) {
  const map = new Map();
  for (const v of arr) map.set(v, (map.get(v) || 0) + 1);
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
}

function runSimulations(deckCards, n, seedStr) {
  const rng = makeRng(seedStr);
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(simulateTurn(deckCards, rng));
  }
  return results;
}

function summarize(results, deckSize) {
  const N = results.length;
  const sum = (f) => results.reduce((acc, r) => acc + f(r), 0);
  const avg = (f) => (N ? sum(f) / N : 0);
  const avgDraw = avg((r) => r.cardsDrawn);
  const avgCoins = avg((r) => r.coins);
  const avgBuys = avg((r) => r.buys);
  const deckEmptyPct = (sum((r) => (r.deckEmptyEncountered ? 1 : 0)) / N) * 100;
  return { N, deckSize, avgDraw, avgCoins, avgBuys, deckEmptyPct };
}

function renderSummary(el, s) {
  el.innerHTML = `
    <div><strong>Deck size:</strong> ${s.deckSize}</div>
    <div><strong>Avg cards drawn:</strong> 5 + ${s.avgDraw.toFixed(2)} = ${(5 + s.avgDraw).toFixed(2)}</div>
    <div><strong>Avg coins:</strong> ${s.avgCoins.toFixed(2)}</div>
    <div><strong>Avg buys:</strong> ${s.avgBuys.toFixed(2)}</div>
    <div><strong>Deck hit empty while drawing:</strong> ${s.deckEmptyPct.toFixed(1)}%</div>
  `;
}

function renderEndReasons(el, reasons, total) {
  const reasonWidth = reasons.length ? Math.max(...reasons.map(([r]) => r.length)) : 0;
  const lines = reasons
    .map(([reason, count]) => {
      const pct = ((count / total) * 100).toFixed(1).padStart(5);
      return `${reason.padEnd(reasonWidth)} | ${String(count).padStart(6)} (${pct}%)`;
    })
    .join('\n');
  el.textContent = lines || '(no data)';
}

// Wire up UI
window.addEventListener('DOMContentLoaded', () => {
  const deckInput = document.getElementById('deckInput');
  const copyDeckBtn = document.getElementById('copyDeckBtn');
  const simCount = document.getElementById('simCount');
  const simUp = document.getElementById('simUp');
  const simDown = document.getElementById('simDown');
  const cardControls = document.getElementById('cardControls');
  const zeroAllBtn = document.getElementById('zeroAllBtn');
  const seed = document.getElementById('seed');
  const runBtn = document.getElementById('runBtn');
  const statusEl = document.getElementById('status');
  const histoDrawEl = document.getElementById('histoDraw');
  const histoCoinsEl = document.getElementById('histoCoins');
  const histoBuysEl = document.getElementById('histoBuys');
  const endReasonsEl = document.getElementById('endReasons');
  const summaryEl = document.getElementById('summary');

  // Default example deck
  if (!deckInput.value) {
    deckInput.value = '7 copper, 3 estate, 3 lab, 1 village, 2 smithy';
  }

  // Card quantity controls
  const supportedOrder = [
    'estate',
    'duchy',
    'province',
    'copper',
    'silver',
    'gold',
    'festival',
    'village',
    'moat',
    'smithy',
    'council_room',
    'lab',
    'merchant',
    'peddler',
    'market',
  ];
  const qty = new Map(supportedOrder.map((id) => [id, 0]));

  function buildCardControls() {
    if (!cardControls) return;
    cardControls.innerHTML = '';
    for (const id of supportedOrder) {
      const card = Cards.byId[id];
      const row = document.createElement('div');
      row.className = 'card-row';

      const nameEl = document.createElement('div');
      nameEl.className = 'card-name';
      nameEl.textContent = card.name;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'qty-input';
      input.readOnly = false;
      input.value = String(qty.get(id) || 0);
      input.setAttribute('aria-label', `${card.name} quantity`);
      // Keep qty map in sync with manual edits without overriding typing UX
      input.addEventListener('input', () => {
        const v = parseInt(String(input.value).trim(), 10);
        const nv = Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
        qty.set(id, nv);
        rebuildDeckFromQty();
      });
      input.addEventListener('blur', () => {
        // Normalize display to a clean integer after editing
        refreshQtyInputs();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.target.blur();
        }
      });

      const btns = document.createElement('div');
      btns.className = 'qty-buttons';
      const mkBtn = (label, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = `${title} ${card.name}`;
        return b;
      };
      const plus = mkBtn('+', 'Increase');
      const minus = mkBtn('−', 'Decrease');
      const zero = mkBtn('0', 'Clear');

      plus.addEventListener('click', () => adjustQty(id, 1));
      minus.addEventListener('click', () => adjustQty(id, -1));
      zero.addEventListener('click', () => setQty(id, 0));

      btns.appendChild(plus);
      btns.appendChild(minus);
      btns.appendChild(zero);

      row.appendChild(nameEl);
      row.appendChild(input);
      row.appendChild(btns);
      cardControls.appendChild(row);
    }
  }

  function refreshQtyInputs() {
    if (!cardControls) return;
    const inputs = cardControls.querySelectorAll('.card-row .qty-input');
    let i = 0;
    for (const id of supportedOrder) {
      const input = inputs[i++];
      if (input) input.value = String(qty.get(id) || 0);
    }
  }

  function rebuildDeckFromQty() {
    const parts = [];
    for (const id of supportedOrder) {
      const n = qty.get(id) || 0;
      if (n > 0) parts.push(`${n} ${id}`);
    }
    deckInput.value = parts.join(', ');
  }

  function setQty(id, v) {
    const nv = Math.max(0, Math.floor(v));
    qty.set(id, nv);
    refreshQtyInputs();
    rebuildDeckFromQty();
  }

  function adjustQty(id, delta) {
    const cur = qty.get(id) || 0;
    setQty(id, cur + delta);
  }

  function syncQtyFromDeck() {
    // reset to zero
    for (const id of supportedOrder) qty.set(id, 0);
    const parsed = parseDeckList(deckInput.value);
    const counts = new Map();
    for (const c of parsed.cards) counts.set(c.id, (counts.get(c.id) || 0) + 1);
    for (const id of supportedOrder) {
      if (counts.has(id)) qty.set(id, counts.get(id));
    }
    refreshQtyInputs();
  }

  buildCardControls();
  syncQtyFromDeck();

  // Zero-all button
  zeroAllBtn?.addEventListener('click', () => {
    for (const id of supportedOrder) qty.set(id, 0);
    refreshQtyInputs();
    rebuildDeckFromQty();
  });

  // Copy deck list to clipboard
  copyDeckBtn?.addEventListener('click', async () => {
    const text = deckInput.value || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback using a temporary textarea
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      const prev = copyDeckBtn.textContent;
      copyDeckBtn.textContent = 'Copied!';
      setTimeout(() => (copyDeckBtn.textContent = prev), 1000);
    } catch (err) {
      alert('Could not copy to clipboard. Please copy manually.');
    }
  });

  deckInput.addEventListener('blur', () => {
    syncQtyFromDeck();
  });

  runBtn.addEventListener('click', () => {
    statusEl.textContent = 'Parsing deck...';
    const { cards, errors } = parseDeckList(deckInput.value);
    if (errors.length) {
      statusEl.textContent = 'Errors in deck list.';
      alert('Deck errors:\n' + errors.join('\n'));
      return;
    }
    const n = parseSimCount();
    statusEl.textContent = `Running ${n.toLocaleString()} simulations...`;
    // Disable the run button and defer heavy work so the UI can paint
    runBtn.disabled = true;
    setTimeout(() => {
      try {
        // Run
        const results = runSimulations(cards, n, seed.value.trim());
        const summary = summarize(results, cards.length);

        // Histograms
        const drawH = histogram(results.map((r) => r.cardsDrawn));
        const coinH = histogram(results.map((r) => r.coins));
        const buyH = histogram(results.map((r) => r.buys));
        const reasons = countBy(results.map((r) => r.endReason));

        histoDrawEl.textContent = formatHisto(drawH, results.length);
        histoCoinsEl.textContent = formatHisto(coinH, results.length);
        histoBuysEl.textContent = formatHisto(buyH, results.length);
        renderEndReasons(endReasonsEl, reasons, results.length);
        renderSummary(summaryEl, summary);

        statusEl.textContent = 'Done.';
      } finally {
        runBtn.disabled = false;
      }
    }, 0);
  });

  const clampSim = (n) => {
    const min = parseInt(simCount.min || '1', 10) || 1;
    const max = parseInt(simCount.max || '10000000', 10) || 10000000;
    const v = Math.round(Number.isFinite(n) ? n : 0);
    return Math.min(max, Math.max(min, v));
  };
  const trimMantissa = (s) =>
    s
      .replace(/\.0+$/, '')
      .replace(/(\.\d*?)0+$/, '$1')
      .replace(/\.$/, '');
  const formatSci = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '';
    const exp = Math.floor(Math.log10(n));
    const mant = n / Math.pow(10, exp);
    const mantStr = Math.abs(mant - 1) < 1e-12 ? '1' : trimMantissa(mant.toPrecision(3));
    return `${mantStr}e${exp}`;
  };
  const parseSimCount = () => {
    const v = Number(String(simCount.value).trim());
    const n = clampSim(v);
    return n;
  };

  // Step functions for chain: 1, 3, 10, 30, 100, 300, ...
  const nextChain = (n) => {
    if (!Number.isFinite(n) || n <= 0) return 1;
    const e = Math.floor(Math.log10(n));
    const base = Math.pow(10, e);
    const m = n / base; // 1 <= m < 10 typically
    if (m < 3) return 3 * base;
    if (m < 10) return 10 * base;
    return 1 * base * 10; // fallback
  };
  const prevChain = (n) => {
    if (!Number.isFinite(n) || n <= 1) return 1;
    const e = Math.floor(Math.log10(n));
    const base = Math.pow(10, e);
    const m = n / base;
    if (m > 3) return 3 * base;
    if (m > 1) return 1 * base;
    return e > 0 ? 3 * Math.pow(10, e - 1) : 1;
  };

  // Update button labels/titles to ×3 and ÷3 and wire stepping chain
  if (simUp) {
    simUp.textContent = '×3';
    simUp.title = 'Increase simulations (1→3→10→30→…)';
    simUp.addEventListener('click', () => {
      const cur = parseSimCount();
      const next = clampSim(nextChain(cur));
      simCount.value = formatSci(next);
    });
  }
  if (simDown) {
    simDown.textContent = '÷3';
    simDown.title = 'Decrease simulations (…→30→10→3→1)';
    simDown.addEventListener('click', () => {
      const cur = parseSimCount();
      const next = clampSim(prevChain(cur));
      simCount.value = formatSci(next);
    });
  }

  simCount.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const cur = parseSimCount();
      const next = clampSim(cur * 10);
      simCount.value = formatSci(next);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = parseSimCount();
      const next = clampSim(cur / 10);
      simCount.value = formatSci(next);
    }
  });
  simCount.addEventListener('blur', () => {
    const n = parseSimCount();
    if (n) simCount.value = formatSci(n);
  });
});
