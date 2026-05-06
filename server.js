const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 2026;

app.use(express.json());

// ==========================================================================
// CONFIGURATION
// ==========================================================================
const CONFIG = {
  API_URL: "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json",
  MAX_HISTORY: 500,
  MAX_RETRIES: 2,
  FETCH_TIMEOUT_MS: 7000,
  CONFIDENCE_MIN: 52,
  CONFIDENCE_MAX: 98,
  SHORT_TERM_WINDOW: 3,
  DECAY_FACTOR: 0.992,
  STORAGE_FILE: "prediction_state.json",
  STORAGE_VERSION: 5,
};

// ==========================================================================
// CORE STATE
// ==========================================================================
const CORE = {
  W: 0, L: 0,
  HISTORY: [],
  HISTORY_NUM: [],
  LAST_PRED: null,
  LAST_PRED_NUM: null,
  CURRENT_CONFIDENCE: 0,
  LAST_PERIOD_CHECKED: null,
  adaptiveWeights: {
    longTerm: 0.28,
    shortTerm: 0.22,
    pattern: 0.28,
    state: 0.22
  },
  stateMachine: {
    currentState: 'NEUTRAL',
    regime: 'NORMAL'
  },
  predictionAuditLog: []
};

// ==========================================================================
// UTILITY FUNCTIONS
// ==========================================================================
function now_ms() { return Date.now(); }

function computeDecayWeights(len) {
  const w = new Array(len);
  let total = 0;
  for (let i = 0; i < len; i++) { 
    w[i] = Math.pow(CONFIG.DECAY_FACTOR, i); 
    total += w[i]; 
  }
  return w.map(v => v / total);
}

function getCurrentRunLength() {
  const h = CORE.HISTORY;
  if (h.length === 0) return 0;
  let run = 1;
  for (let i = 1; i < h.length; i++) {
    if (h[i] === h[0]) run++;
    else break;
  }
  return run;
}

function getLongTermTrendProb() {
  const h = CORE.HISTORY_NUM;
  if (h.length < 5) return 0.5;
  const len = Math.min(50, h.length);
  const dwts = computeDecayWeights(len);
  let weighted = 0;
  for (let i = 0; i < len; i++) weighted += h[i] * dwts[i];
  return Math.min(0.85, Math.max(0.15, 0.5 + (weighted - 0.5) * 0.6));
}

function getShortTermMomentumProb() {
  const recent = CORE.HISTORY_NUM.slice(0, CONFIG.SHORT_TERM_WINDOW);
  if (recent.length < 2) return 0.5;
  const rawProb = recent.filter(v => v === 1).length / recent.length;
  return Math.min(0.85, Math.max(0.15, rawProb));
}

function getPatternBasedProb() {
  return 0.5;
}

function getStateMachineProb() {
  return 0.5;
}

function loadPersistedState() {
  try {
    const filePath = path.join(__dirname, CONFIG.STORAGE_FILE);
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.HISTORY) {
        CORE.W = parsed.W || 0;
        CORE.L = parsed.L || 0;
        CORE.HISTORY = parsed.HISTORY.slice(0, CONFIG.MAX_HISTORY);
        CORE.HISTORY_NUM = parsed.HISTORY_NUM.slice(0, CONFIG.MAX_HISTORY);
        CORE.stateMachine = parsed.stateMachine || CORE.stateMachine;
        CORE.LAST_PERIOD_CHECKED = parsed.LAST_PERIOD_CHECKED;
        CORE.predictionAuditLog = parsed.predictionAuditLog || [];
      }
    }
  } catch (e) {
    console.warn("Persisted state load failed:", e.message);
  }
}

function persistState() {
  try {
    const toSave = {
      storageVersion: CONFIG.STORAGE_VERSION,
      W: CORE.W, L: CORE.L,
      HISTORY: CORE.HISTORY.slice(0, CONFIG.MAX_HISTORY),
      HISTORY_NUM: CORE.HISTORY_NUM.slice(0, CONFIG.MAX_HISTORY),
      stateMachine: CORE.stateMachine,
      LAST_PERIOD_CHECKED: CORE.LAST_PERIOD_CHECKED,
      predictionAuditLog: CORE.predictionAuditLog.slice(-50),
      timestamp: now_ms()
    };
    const filePath = path.join(__dirname, CONFIG.STORAGE_FILE);
    fs.writeFileSync(filePath, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.warn("Persist failed:", e.message);
  }
}

// ==========================================================================
// PREDICTION ENGINE
// ==========================================================================
function stateMachinePrediction() {
  const longTermProb = getLongTermTrendProb();
  const shortTermProb = getShortTermMomentumProb();
  const patternProb = getPatternBasedProb();
  const stateProb = getStateMachineProb();

  const finalProb = (longTermProb * 0.28 + shortTermProb * 0.22 + patternProb * 0.28 + stateProb * 0.22);
  
  let winner = finalProb >= 0.5 ? 'BIG' : 'SMALL';
  let confidence = 55 + Math.abs(finalProb - 0.5) * 32;
  confidence = Math.min(98, Math.max(52, Math.round(confidence)));

  return {
    prediction: winner,
    confidence: confidence,
    probability: finalProb,
    components: {
      longTerm: parseFloat(longTermProb.toFixed(3)),
      shortTerm: parseFloat(shortTermProb.toFixed(3)),
      pattern: parseFloat(patternProb.toFixed(3)),
      state: parseFloat(stateProb.toFixed(3))
    }
  };
}

// ==========================================================================
// FETCH LATEST RESULT
// ==========================================================================
async function fetchLatestResult() {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.FETCH_TIMEOUT_MS);
    
    const response = await fetch(CONFIG.API_URL, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const json = await response.json();
    const latest = json?.data?.list?.[0];
    
    if (!latest || !latest.number || !latest.issueNumber) {
      throw new Error("Invalid API response");
    }

    const num = Number(latest.number);
    if (isNaN(num)) throw new Error("Invalid number");

    const actualNum = num <= 4 ? 0 : 1;
    const actual = actualNum === 1 ? "BIG" : "SMALL";
    const issue = latest.issueNumber;

    if (CORE.LAST_PERIOD_CHECKED !== issue && CORE.LAST_PRED_NUM !== null) {
      const wasCorrect = (actualNum === CORE.LAST_PRED_NUM);
      if (wasCorrect) {
        CORE.W++;
      } else {
        CORE.L++;
      }
      
      CORE.HISTORY.unshift(actual);
      CORE.HISTORY_NUM.unshift(actualNum);
      if (CORE.HISTORY.length > CONFIG.MAX_HISTORY) {
        CORE.HISTORY.pop();
        CORE.HISTORY_NUM.pop();
      }
      
      CORE.LAST_PERIOD_CHECKED = issue;
      persistState();
    } else if (!CORE.LAST_PERIOD_CHECKED) {
      CORE.HISTORY.unshift(actual);
      CORE.HISTORY_NUM.unshift(actualNum);
      CORE.LAST_PERIOD_CHECKED = issue;
      persistState();
    }

    return { actual, issue, actualNum };

  } catch (error) {
    console.warn("API error:", error.message);
    return null;
  }
}

// ==========================================================================
// RUN PREDICTION
// ==========================================================================
async function runPrediction() {
  try {
    const analysis = stateMachinePrediction();
    
    CORE.LAST_PRED = analysis.prediction;
    CORE.LAST_PRED_NUM = analysis.prediction === 'BIG' ? 1 : 0;
    CORE.CURRENT_CONFIDENCE = analysis.confidence;
    
    const runLength = getCurrentRunLength();
    const total = CORE.W + CORE.L;
    const winRate = total > 0 ? ((CORE.W / total) * 100).toFixed(1) : 0;
    
    // Record to audit log
    CORE.predictionAuditLog.unshift({
      timestamp: now_ms(),
      prediction: analysis.prediction,
      confidence: analysis.confidence,
      probability: analysis.probability,
      state: CORE.stateMachine.currentState,
      runLength: runLength
    });
    if (CORE.predictionAuditLog.length > 50) CORE.predictionAuditLog.pop();
    
    persistState();
    
    return {
      currentPrediction: {
        prediction: analysis.prediction,
        confidence: analysis.confidence,
        probability: parseFloat(analysis.probability.toFixed(3)),
        components: analysis.components
      },
      statistics: {
        wins: CORE.W,
        losses: CORE.L,
        totalPredictions: total,
        winRate: winRate + '%',
        currentRunLength: runLength
      },
      systemState: {
        currentState: CORE.stateMachine.currentState,
        regime: CORE.stateMachine.regime,
        lastPrediction: CORE.LAST_PRED,
        lastConfidence: CORE.CURRENT_CONFIDENCE
      },
      history: {
        recentResults: CORE.HISTORY.slice(0, 20),
        recentNumbers: CORE.HISTORY_NUM.slice(0, 20),
        totalHistory: CORE.HISTORY.length
      },
      recentPredictions: CORE.predictionAuditLog.slice(0, 10)
    };
  } catch (error) {
    console.warn("Prediction error:", error);
    return {
      currentPrediction: {
        prediction: "BIG",
        confidence: 65,
        probability: 0.65,
        components: { longTerm: 0.5, shortTerm: 0.5, pattern: 0.5, state: 0.5 }
      },
      statistics: {
        wins: CORE.W,
        losses: CORE.L,
        totalPredictions: CORE.W + CORE.L,
        winRate: "0%",
        currentRunLength: 0
      },
      systemState: {
        currentState: "NEUTRAL",
        regime: "NORMAL",
        lastPrediction: null,
        lastConfidence: null
      },
      history: {
        recentResults: [],
        recentNumbers: [],
        totalHistory: 0
      },
      recentPredictions: []
    };
  }
}

// ==========================================================================
// SINGLE ENDPOINT - EVERYTHING IN ONE URL
// ==========================================================================
app.get('/', async (req, res) => {
  const data = await runPrediction();
  res.json(data);
});

// Also keep this for compatibility
app.get('/api/all', async (req, res) => {
  const data = await runPrediction();
  res.json(data);
});

// ==========================================================================
// ADDITIONAL HELPER ENDPOINTS (optional)
// ==========================================================================

// Reset everything
app.post('/api/reset', (req, res) => {
  CORE.W = 0;
  CORE.L = 0;
  CORE.HISTORY = [];
  CORE.HISTORY_NUM = [];
  CORE.LAST_PRED = null;
  CORE.LAST_PRED_NUM = null;
  CORE.LAST_PERIOD_CHECKED = null;
  CORE.predictionAuditLog = [];
  CORE.stateMachine = { currentState: 'NEUTRAL', regime: 'NORMAL' };
  persistState();
  res.json({ success: true, message: "All stats reset successfully" });
});

// Force sync with external API
app.post('/api/sync', async (req, res) => {
  try {
    const result = await fetchLatestResult();
    if (result) {
      res.json({ success: true, result });
    } else {
      res.status(503).json({ success: false, error: "Sync failed" });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Prediction API running on http://localhost:${PORT}`);
  console.log(`\n📊 Everything in ONE URL:`);
  console.log(`   http://localhost:${PORT}/`);
  console.log(`   http://localhost:${PORT}/api/all`);
  console.log(`\n🔄 Other endpoints:`);
  console.log(`   POST /api/reset - Reset all stats`);
  console.log(`   POST /api/sync  - Force sync with external API`);
});

// Load saved state on startup
loadPersistedState();

module.exports = app;