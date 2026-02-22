================================================================================
UNIFIED PLAN: SNIPER-AWARE TRADING PIPELINE + SMART EXIT STRATEGY
================================================================================

STATUS: PLAN ONLY - NOT YET IMPLEMENTED
DATE: 2026-02-22

================================================================================
TABLE OF CONTENTS
================================================================================

  1. ANALYSIS OF THE TWO SOURCE PLANS
  2. CONFLICTS AND DESIGN DECISIONS
  3. UNIFIED ARCHITECTURE
  4. FILE-BY-FILE CHANGES
  5. IMPLEMENTATION ORDER
  6. ROLLOUT STRATEGY
  7. OPEN QUESTIONS


================================================================================
1. ANALYSIS OF THE TWO SOURCE PLANS
================================================================================

Plan A ("Sniper Bot Exit Gate"):
  - New pipeline gate at Stage 4 replacing momentum gate
  - Unified polling loop with slot-based sniper classification
  - logOnly mode for safe data collection before going live
  - Does NOT modify position monitor or exit strategy
  - Clean, focused scope: one new file, five modified files

Plan B ("Sniper-Aware Second-Wave Trading Strategy"):
  - Same pipeline gate concept but with 3 sequential time windows
    (observation, sell detection, recovery confirmation)
  - Trailing stop loss on position monitor
  - Real-time sell pressure monitoring during position hold
  - Passes earlyBuyerWallets to position monitor for weighted sell detection
  - Changes default STOP_LOSS, TAKE_PROFIT, MAX_HOLD_DURATION

Both plans converge on the same core idea: identify sniper bots by their
early buying, wait for them to dump, confirm organic demand survives, then
buy. The difference is in execution details and scope.


================================================================================
2. CONFLICTS AND DESIGN DECISIONS
================================================================================

CONFLICT 1: Gate Structure - Unified Polling vs. 3 Sequential Windows
----------------------------------------------------------------------
  Plan A: Single polling loop that classifies wallets by slot delta on
          every poll. Simple, flat, one state machine.
  Plan B: Three sequential phases (observation -> sell detection -> recovery)
          with separate timers and configs for each phase.

  DECISION: Use Plan A's unified polling approach.
  REASON: Plan B's 3-phase approach is structurally more complex for no
  real benefit. With slot-based classification, you don't need to wait for
  an "observation window" to finish before detecting sells - both happen
  naturally on every poll. A single polling loop with running state achieves
  the same result with half the config surface area and simpler control flow.
  Plan A's approach also maps cleanly onto the existing momentum gate
  structure (same polling pattern, same RPC calls).

CONFLICT 2: File Naming
------------------------
  Plan A: pipeline/sniper-gate.ts
  Plan B: pipeline/sniper-cycle-tracker.ts

  DECISION: Use "sniper-gate.ts" (Plan A).
  REASON: Consistent with existing naming (cheap-gates.ts, deep-filters.ts,
  momentum-gate.ts). It's a gate - it passes or rejects. "Cycle tracker"
  implies ongoing tracking, which is not what a pipeline gate does.

CONFLICT 3: Config Naming
--------------------------
  Plan A: SNIPER_GATE_* env vars (8 vars)
  Plan B: SNIPER_* env vars (9 vars) with separate per-phase timing

  DECISION: Use Plan A's SNIPER_GATE_* prefix (8 vars).
  REASON: Fewer, cleaner config surface. The unified polling loop doesn't
  need per-phase timing. SNIPER_GATE_ prefix clearly scopes these to the
  pipeline gate, leaving SNIPER_ free for potential future use.

CONFLICT 4: Position Monitor - Sell Pressure Monitoring
--------------------------------------------------------
  Plan A: Does not touch position monitor.
  Plan B: Adds real-time sell pressure monitoring during position hold,
          using getSignaturesForAddress + getParsedTransactions on every
          Nth check cycle.

  DECISION: DEFER sell pressure monitoring to a future iteration.
  REASON: The current position monitor is beautifully efficient - it uses
  a single batched getMultipleAccountsInfo() call for ALL positions. Adding
  getSignaturesForAddress + getParsedTransactions per position per Nth cycle
  breaks this efficiency model. For 5 concurrent positions checked every 3rd
  cycle at 500ms intervals, that's ~10 extra RPC calls every 1.5 seconds.
  This is a meaningful cost increase that should be measured against actual
  benefit AFTER the sniper gate is live and generating data. If the sniper
  gate is working well (filtering out bot-heavy tokens), the sell pressure
  during holding should already be reduced organically.

  NOTE: We WILL pass sniperWallets[] to the position as metadata (low cost,
  no RPC impact), so this data is available if we add sell pressure monitoring
  later.

CONFLICT 5: Trailing Stop Loss
--------------------------------
  Plan A: Does not modify exit strategy.
  Plan B: Adds trailing stop loss with activation threshold.

  DECISION: INCLUDE trailing stop loss (Plan B Phase 2).
  REASON: This is a genuine improvement independent of the sniper gate. The
  current fixed TP/SL has a known problem: winning trades hit a ceiling (40%)
  while losers ride down to -20%. A trailing stop lets winners run while
  locking in gains. This is independent of the pipeline gate and can be
  developed and tested in parallel. It uses ZERO additional RPC calls - just
  math on already-fetched bonding curve data.

CONFLICT 6: Default Config Changes
------------------------------------
  Plan A: No default changes.
  Plan B: STOP_LOSS 20->10, TAKE_PROFIT 40->0, MAX_HOLD 20s->60s

  DECISION: DO NOT change existing defaults. Add new defaults for new features.
  REASON: The new strategy is unproven. Changing defaults forces everyone onto
  an untested config. Instead:
  - Keep STOP_LOSS=20, TAKE_PROFIT=40, MAX_HOLD=20 as defaults
  - Add TRAILING_STOP_* as new optional configs (disabled by default)
  - Users can tune all values through .env once they have data
  - The rollout strategy (logOnly mode) gives time to determine optimal values

CONFLICT 7: earlyBuyerWallets Data Flow to Position Monitor
-------------------------------------------------------------
  Plan A: Outputs sniperWallets[] in gate data but doesn't pass to monitor.
  Plan B: Passes earlyBuyerWallets[] to position for weighted sell pressure.

  DECISION: Pass sniperWallets[] through to PumpFunPosition as optional
  metadata, but don't act on it yet.
  REASON: Cheap to pass (just an array of strings on the position object),
  no RPC cost, and enables the sell pressure feature later without having to
  re-wire the data flow. The position monitor can ignore it for now.


================================================================================
3. UNIFIED ARCHITECTURE
================================================================================

NEW PIPELINE:
  Detect -> Cheap Gates -> Deep Filters -> Sniper Gate -> Buy -> Smart Monitor

  Stage 4 is now configurable:
    - If SNIPER_GATE_ENABLED=true  -> Sniper Gate runs (replaces momentum)
    - If SNIPER_GATE_ENABLED=false -> Momentum Gate runs (existing behavior)
    - Both enabled? Sniper gate takes priority, warning logged.

POSITION MONITOR ENHANCEMENTS:
    - Trailing stop loss (activation threshold + trail distance)
    - High water mark tracking per position
    - New trigger type: 'trailing_stop'
    - Optional sniperWallets metadata on positions (for future use)


================================================================================
4. FILE-BY-FILE CHANGES
================================================================================

────────────────────────────────────────────────────────────────────────────────
FILE 1 (MODIFY): pipeline/types.ts
────────────────────────────────────────────────────────────────────────────────

ADD after MomentumGateData interface (~line 166):

  export interface SniperGateData {
    sniperWalletCount: number;       // How many bot wallets identified
    sniperExitCount: number;         // How many bots exited (sold)
    sniperExitPercent: number;       // % of bots that exited
    organicBuyerCount: number;       // Unique wallets from later slots
    totalBuys: number;               // Total buy transactions seen
    totalSells: number;              // Total sell transactions seen
    uniqueBuyWalletCount: number;    // Unique buyer wallets total
    checksPerformed: number;         // How many polls before decision
    totalWaitMs: number;             // Total time spent in gate
    checkStartedAt: number;          // Timestamp
    sniperWallets: string[];         // Identified bot wallet addresses
    organicWallets: string[];        // Organic wallet addresses
  }

ADD to PipelineContext (~line 188):

    sniperGate?: SniperGateData;

ADD to RejectionReasons (~line 257):

    // Sniper Gate
    SNIPER_GATE_TIMEOUT: 'Sniper gate timeout - bots did not exit in time',
    SNIPER_GATE_LOW_ORGANIC: 'Insufficient organic buyers after bot exit',
    SNIPER_GATE_RPC_FAILED: 'Failed to fetch transactions for sniper gate',


────────────────────────────────────────────────────────────────────────────────
FILE 2 (NEW): pipeline/sniper-gate.ts  (~250-300 lines)
────────────────────────────────────────────────────────────────────────────────

Mirrors momentum-gate.ts structure exactly.

EXPORTS:
  - SniperGateConfig (interface)
  - SniperGateStage (class implements PipelineStage)

CONFIG INTERFACE:
  {
    enabled: boolean               // Master toggle (default: false)
    initialDelayMs: number         // Wait for tx indexing (default: 500)
    recheckIntervalMs: number      // Polling interval (default: 1000)
    maxChecks: number              // Max polls before timeout (default: 15)
    sniperSlotThreshold: number    // Slots 0-N = "sniper" (default: 3)
    minBotExitPercent: number      // % bots that must exit (default: 50)
    minOrganicBuyers: number       // Min organic wallets (default: 3)
    logOnly: boolean               // Log metrics but always pass (default: false)
  }

INTERNAL STATE (per-execution, reset each call):
  - creationSlot: number           // From detection.slot
  - sniperWallets: Map<string, 'bought' | 'exited'>
  - organicWallets: Set<string>
  - allBuyWallets: Set<string>
  - totalBuys: number
  - totalSells: number

CORE LOGIC - fetchAndAnalyzeTransactions():
  Same RPC calls as momentum gate:
    1. getSignaturesForAddress(bondingCurve, { limit: 100 }, 'confirmed')
    2. getParsedTransactions(signatures, { commitment: 'confirmed',
       maxSupportedTransactionVersion: 0 })

  Reuse existing discriminator parsing from momentum gate:
    - Same BUY_DISCRIMINATOR and SELL_DISCRIMINATOR constants
    - Same instruction parsing logic (outer + inner instructions)
    - Same pump.fun program ID check

  NEW analysis per transaction:
    For each BUY:
      - Get wallet: tx.transaction.message.accountKeys[0].pubkey (fee payer)
      - Get slot from signatures response
      - slotDelta = tx.slot - detection.slot
      - if slotDelta <= config.sniperSlotThreshold:
          sniperWallets.set(wallet, 'bought')     // Flag as sniper
      - else:
          organicWallets.add(wallet)               // Flag as organic
      - allBuyWallets.add(wallet)
      - totalBuys++

    For each SELL:
      - Get wallet (fee payer, same approach)
      - if sniperWallets.has(wallet):
          sniperWallets.set(wallet, 'exited')      // Bot has exited
      - totalSells++

POLLING LOOP (execute method):
  1. If disabled -> pass through (same pattern as momentum gate)
  2. Wait initialDelayMs
  3. Loop up to maxChecks:
     a. fetchAndAnalyzeTransactions()
     b. Calculate metrics:
        - botCount = sniperWallets.size
        - botExitCount = count where value === 'exited'
        - botExitPercent = botExitCount / botCount * 100 (0 if no bots)
        - organicCount = organicWallets.size
     c. Log current state (always, for data analysis)
     d. Check pass conditions:
        - botCount === 0 AND organicCount >= minOrganicBuyers: PASS
          (No bots found, organic demand exists)
        - botCount > 0 AND botExitPercent >= minBotExitPercent
          AND organicCount >= minOrganicBuyers: PASS
          (Bots exiting, organic demand survived)
        - logOnly === true: PASS (always, log what would have happened)
     e. Not passed? Wait recheckIntervalMs, continue
     f. maxChecks reached? REJECT with appropriate reason:
        - If botExitPercent < minBotExitPercent:
            RejectionReasons.SNIPER_GATE_TIMEOUT
        - If organicCount < minOrganicBuyers:
            RejectionReasons.SNIPER_GATE_LOW_ORGANIC
  4. RPC error at any point -> REJECT immediately (same as momentum gate)


────────────────────────────────────────────────────────────────────────────────
FILE 3 (MODIFY): risk/pumpfun-position-monitor.ts
────────────────────────────────────────────────────────────────────────────────

ADD to PumpFunPosition interface (~line 31):
    sniperWallets?: string[];           // Bot wallets from sniper gate (for future use)
    highWaterMarkPercent?: number;      // Highest PnL % seen (for trailing stop)

ADD to PumpFunTriggerEvent type union (~line 49):
    type: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_exit'
          | 'manual' | 'graduated';

ADD to PumpFunMonitorConfig (~line 60):
    trailingStopEnabled: boolean;           // default: false
    trailingStopActivationPercent: number;  // default: 15
    trailingStopDistancePercent: number;    // default: 10
    hardTakeProfitPercent: number;          // default: 0 (0 = disabled)

MODIFY evaluatePosition() (~line 219):
  After current value calculation and P&L calculation (after line 284),
  ADD trailing stop logic BEFORE the existing TP/SL checks:

    // ═══════════ TRAILING STOP LOGIC ═══════════
    if (this.config.trailingStopEnabled) {
      // Initialize high water mark if not set
      if (position.highWaterMarkPercent === undefined) {
        position.highWaterMarkPercent = 0;
      }

      // Update high water mark
      if (pnlPercent > position.highWaterMarkPercent) {
        position.highWaterMarkPercent = pnlPercent;
      }

      // Check if trailing stop is activated (above activation threshold)
      if (position.highWaterMarkPercent >= this.config.trailingStopActivationPercent) {
        const trailLevel = position.highWaterMarkPercent
                           - this.config.trailingStopDistancePercent;

        if (pnlPercent <= trailLevel) {
          // Trailing stop triggered
          await this.executeSell(position, currentValueSol, pnlPercent,
            'trailing_stop',
            `Trail stop: PnL ${pnlPercent.toFixed(2)}% dropped below `
            + `trail ${trailLevel.toFixed(2)}% `
            + `(high: ${position.highWaterMarkPercent.toFixed(2)}%)`);
          return;
        }
      }

      // Hard take profit ceiling (optional, overrides trailing)
      if (this.config.hardTakeProfitPercent > 0
          && pnlPercent >= this.config.hardTakeProfitPercent) {
        await this.executeSell(position, currentValueSol, pnlPercent,
          'take_profit',
          `Hard TP hit: ${pnlPercent.toFixed(2)}%`);
        return;
      }
    }

  The EXISTING TP/SL logic remains unchanged and serves as:
    - Primary exit when trailing stop is DISABLED
    - Fallback stop loss when trailing stop IS enabled
      (trailing stop only affects upside; the existing SL still protects
       against drops before the activation threshold is reached)

  MODIFY existing TP check to skip when trailing stop is enabled:
    // Check take profit (only when trailing stop is disabled)
    if (!this.config.trailingStopEnabled && pnlPercent >= this.config.takeProfit) {
      ...existing TP logic...
    }

    // Check stop loss (always active - protects before trailing activates)
    if (pnlPercent <= -this.config.stopLoss) {
      ...existing SL logic (unchanged)...
    }


────────────────────────────────────────────────────────────────────────────────
FILE 4 (MODIFY): helpers/config-validator.ts
────────────────────────────────────────────────────────────────────────────────

ADD to ValidatedConfig interface (after momentum gate fields):

    // Sniper Gate
    sniperGateEnabled: boolean;
    sniperGateInitialDelayMs: number;
    sniperGateRecheckIntervalMs: number;
    sniperGateMaxChecks: number;
    sniperGateSniperSlotThreshold: number;
    sniperGateMinBotExitPercent: number;
    sniperGateMinOrganicBuyers: number;
    sniperGateLogOnly: boolean;

    // Trailing Stop
    trailingStopEnabled: boolean;
    trailingStopActivationPercent: number;
    trailingStopDistancePercent: number;
    hardTakeProfitPercent: number;

ADD validation block (after momentum gate section):

    // === SNIPER GATE (Pipeline Stage 4 - Alternative to Momentum Gate) ===
    const sniperGateEnabled = requireBoolean('SNIPER_GATE_ENABLED', false);

    const sniperGateInitialDelaySeconds = requireNumber(
      'SNIPER_GATE_INITIAL_DELAY_SECONDS', 0.5);
    if (sniperGateInitialDelaySeconds < 0) {
      errors.push({ variable: 'SNIPER_GATE_INITIAL_DELAY_SECONDS',
                     message: 'cannot be negative' });
    }
    const sniperGateInitialDelayMs = Math.round(
      sniperGateInitialDelaySeconds * 1000);

    const sniperGateRecheckIntervalSeconds = requireNumber(
      'SNIPER_GATE_RECHECK_INTERVAL_SECONDS', 1);
    if (sniperGateRecheckIntervalSeconds < 0.1) {
      errors.push({ variable: 'SNIPER_GATE_RECHECK_INTERVAL_SECONDS',
                     message: 'must be >= 0.1' });
    }
    const sniperGateRecheckIntervalMs = Math.round(
      sniperGateRecheckIntervalSeconds * 1000);

    const sniperGateMaxChecks = requireNumber('SNIPER_GATE_MAX_CHECKS', 15);
    if (sniperGateMaxChecks < 1) {
      errors.push({ variable: 'SNIPER_GATE_MAX_CHECKS',
                     message: 'must be >= 1' });
    }

    const sniperGateSniperSlotThreshold = requireNumber(
      'SNIPER_GATE_SNIPER_SLOT_THRESHOLD', 3);
    if (sniperGateSniperSlotThreshold < 0) {
      errors.push({ variable: 'SNIPER_GATE_SNIPER_SLOT_THRESHOLD',
                     message: 'cannot be negative' });
    }

    const sniperGateMinBotExitPercent = requireNumber(
      'SNIPER_GATE_MIN_BOT_EXIT_PERCENT', 50);
    if (sniperGateMinBotExitPercent < 0 || sniperGateMinBotExitPercent > 100) {
      errors.push({ variable: 'SNIPER_GATE_MIN_BOT_EXIT_PERCENT',
                     message: 'must be 0-100' });
    }

    const sniperGateMinOrganicBuyers = requireNumber(
      'SNIPER_GATE_MIN_ORGANIC_BUYERS', 3);
    if (sniperGateMinOrganicBuyers < 1) {
      errors.push({ variable: 'SNIPER_GATE_MIN_ORGANIC_BUYERS',
                     message: 'must be >= 1' });
    }

    const sniperGateLogOnly = requireBoolean('SNIPER_GATE_LOG_ONLY', false);

    // === TRAILING STOP LOSS ===
    const trailingStopEnabled = requireBoolean('TRAILING_STOP_ENABLED', false);

    const trailingStopActivationPercent = requireNumber(
      'TRAILING_STOP_ACTIVATION_PERCENT', 15);
    if (trailingStopActivationPercent < 0) {
      errors.push({ variable: 'TRAILING_STOP_ACTIVATION_PERCENT',
                     message: 'cannot be negative' });
    }

    const trailingStopDistancePercent = requireNumber(
      'TRAILING_STOP_DISTANCE_PERCENT', 10);
    if (trailingStopDistancePercent < 0) {
      errors.push({ variable: 'TRAILING_STOP_DISTANCE_PERCENT',
                     message: 'cannot be negative' });
    }

    const hardTakeProfitPercent = requireNumber(
      'HARD_TAKE_PROFIT_PERCENT', 0);
    if (hardTakeProfitPercent < 0) {
      errors.push({ variable: 'HARD_TAKE_PROFIT_PERCENT',
                     message: 'cannot be negative' });
    }

ADD all new fields to the config return object.

ADD conflict warning:
    if (sniperGateEnabled && momentumGateEnabled) {
      logger.warn(
        'Both SNIPER_GATE and MOMENTUM_GATE are enabled. '
        + 'Sniper gate takes priority at Stage 4.');
    }

ADD trailing stop warning:
    if (trailingStopEnabled && takeProfit > 0) {
      logger.warn(
        'Both TRAILING_STOP and TAKE_PROFIT are configured. '
        + 'When trailing stop is enabled, fixed take profit is ignored. '
        + 'Use HARD_TAKE_PROFIT_PERCENT for a ceiling with trailing stop.');
    }


────────────────────────────────────────────────────────────────────────────────
FILE 5 (MODIFY): helpers/constants.ts
────────────────────────────────────────────────────────────────────────────────

ADD after momentum gate exports:

    // ═══════════════════════════════════════════════════════════════════
    // SNIPER GATE
    // ═══════════════════════════════════════════════════════════════════
    export const SNIPER_GATE_ENABLED = config.sniperGateEnabled;
    export const SNIPER_GATE_INITIAL_DELAY_MS = config.sniperGateInitialDelayMs;
    export const SNIPER_GATE_RECHECK_INTERVAL_MS = config.sniperGateRecheckIntervalMs;
    export const SNIPER_GATE_MAX_CHECKS = config.sniperGateMaxChecks;
    export const SNIPER_GATE_SNIPER_SLOT_THRESHOLD = config.sniperGateSniperSlotThreshold;
    export const SNIPER_GATE_MIN_BOT_EXIT_PERCENT = config.sniperGateMinBotExitPercent;
    export const SNIPER_GATE_MIN_ORGANIC_BUYERS = config.sniperGateMinOrganicBuyers;
    export const SNIPER_GATE_LOG_ONLY = config.sniperGateLogOnly;

    // ═══════════════════════════════════════════════════════════════════
    // TRAILING STOP
    // ═══════════════════════════════════════════════════════════════════
    export const TRAILING_STOP_ENABLED = config.trailingStopEnabled;
    export const TRAILING_STOP_ACTIVATION_PERCENT = config.trailingStopActivationPercent;
    export const TRAILING_STOP_DISTANCE_PERCENT = config.trailingStopDistancePercent;
    export const HARD_TAKE_PROFIT_PERCENT = config.hardTakeProfitPercent;


────────────────────────────────────────────────────────────────────────────────
FILE 6 (MODIFY): pipeline/pipeline.ts
────────────────────────────────────────────────────────────────────────────────

ADD imports:
    import { SniperGateStage, SniperGateConfig } from './sniper-gate';
    import { SniperGateData } from './types';

ADD to PipelineConfig interface:
    sniperGate: Partial<SniperGateConfig>;

ADD to DEFAULT_PIPELINE_CONFIG:
    sniperGate: {},

ADD to class:
    private sniperGateStage: SniperGateStage;

ADD to constructor:
    this.sniperGateStage = new SniperGateStage(
      connection, this.config.sniperGate);

MODIFY process() - STAGE 4 section:
    Replace current Stage 4 block with:

    // ═══════════════════════════════════════════════════════════════════
    // STAGE 4: Sniper Gate OR Momentum Gate
    // ═══════════════════════════════════════════════════════════════════
    if (this.config.sniperGate.enabled) {
      const sniperResult = await this.sniperGateStage.execute(context);
      stageResults.push(sniperResult);

      if (!sniperResult.pass) {
        context.rejection = {
          stage: sniperResult.stage,
          reason: sniperResult.reason,
          timestamp: Date.now(),
        };
        return this.buildResult(
          false, context, stageResults, pipelineStart, sniperResult);
      }

      context.sniperGate = sniperResult.data as SniperGateData;
    } else {
      const momentumResult = await this.momentumGateStage.execute(context);
      stageResults.push(momentumResult);

      if (!momentumResult.pass) {
        context.rejection = {
          stage: momentumResult.stage,
          reason: momentumResult.reason,
          timestamp: Date.now(),
        };
        return this.buildResult(
          false, context, stageResults, pipelineStart, momentumResult);
      }

      context.momentumGate = momentumResult.data as MomentumGateData;
    }


────────────────────────────────────────────────────────────────────────────────
FILE 7 (MODIFY): index.ts
────────────────────────────────────────────────────────────────────────────────

MODIFY pipeline config to include sniper gate:
    sniperGate: {
      enabled: config.sniperGateEnabled,
      initialDelayMs: config.sniperGateInitialDelayMs,
      recheckIntervalMs: config.sniperGateRecheckIntervalMs,
      maxChecks: config.sniperGateMaxChecks,
      sniperSlotThreshold: config.sniperGateSniperSlotThreshold,
      minBotExitPercent: config.sniperGateMinBotExitPercent,
      minOrganicBuyers: config.sniperGateMinOrganicBuyers,
      logOnly: config.sniperGateLogOnly,
    },

MODIFY position monitor config to include trailing stop:
    trailingStopEnabled: config.trailingStopEnabled,
    trailingStopActivationPercent: config.trailingStopActivationPercent,
    trailingStopDistancePercent: config.trailingStopDistancePercent,
    hardTakeProfitPercent: config.hardTakeProfitPercent,

MODIFY the post-buy position creation to pass sniperWallets:
    When creating PumpFunPosition after successful pipeline + buy:
    - If pipelineResult.context.sniperGate exists:
        position.sniperWallets = pipelineResult.context.sniperGate.sniperWallets;


────────────────────────────────────────────────────────────────────────────────
FILE 8 (MODIFY): .env.example
────────────────────────────────────────────────────────────────────────────────

ADD after momentum gate section:

    # ═══════════════════════════════════════════════════════════════════════════
    # SNIPER GATE (Pipeline Stage 4 - Alternative to Momentum Gate)
    # ═══════════════════════════════════════════════════════════════════════════
    # Identifies sniper bot wallets from early-slot buys, monitors for their
    # exits (sells), then evaluates remaining organic demand. Buys only after
    # bots have cleared out and real buyers remain.
    #
    # When enabled, this REPLACES the momentum gate at Stage 4.
    # If both are enabled, sniper gate takes priority.
    #
    # RECOMMENDED: Start with LOG_ONLY=true to collect data before gating.

    # Enable/disable the sniper gate
    SNIPER_GATE_ENABLED=false

    # Initial delay before first check (seconds)
    # Default: 0.5
    SNIPER_GATE_INITIAL_DELAY_SECONDS=0.5

    # Wait time between recheck polls (seconds)
    # Default: 1
    SNIPER_GATE_RECHECK_INTERVAL_SECONDS=1

    # Maximum number of checks before rejecting
    # Total max window = INITIAL_DELAY + (MAX_CHECKS * RECHECK_INTERVAL)
    # Default: 15 (~15.5s window with defaults)
    SNIPER_GATE_MAX_CHECKS=15

    # Slot threshold for classifying a wallet as a sniper bot
    # Buys in slots 0 to N after creation are flagged as bots
    # Solana slots ~400ms each, threshold=3 means ~0-1.6 seconds
    # Default: 3
    SNIPER_GATE_SNIPER_SLOT_THRESHOLD=3

    # Minimum % of bot wallets that must have sold before we buy
    # Higher = more conservative (wait for more bots to dump)
    # Default: 50
    SNIPER_GATE_MIN_BOT_EXIT_PERCENT=50

    # Minimum unique wallets from LATER slots (organic buyers)
    # Default: 3
    SNIPER_GATE_MIN_ORGANIC_BUYERS=3

    # Log-only mode: compute all metrics but always pass the gate
    # Use this to collect data before setting real thresholds
    # Default: false
    SNIPER_GATE_LOG_ONLY=false

    # ═══════════════════════════════════════════════════════════════════════════
    # TRAILING STOP LOSS
    # ═══════════════════════════════════════════════════════════════════════════
    # Replaces fixed take-profit with a trailing stop that locks in gains as
    # price increases. When enabled, the fixed TAKE_PROFIT is ignored (use
    # HARD_TAKE_PROFIT_PERCENT for a ceiling).
    #
    # How it works:
    #   1. Track highest PnL % reached ("high water mark")
    #   2. Trailing stop activates once PnL >= ACTIVATION_PERCENT
    #   3. If PnL drops DISTANCE_PERCENT below the high water mark -> sell
    #
    # Example with defaults (activation=15, distance=10):
    #   Entry -> +5% (not active yet)
    #   -> +20% (activates, trail at +10%)
    #   -> +45% (high water, trail at +35%)
    #   -> +36% (above trail, hold)
    #   -> +34% (below trail of +35%, SELL -> locked in ~34%)
    #
    # The existing STOP_LOSS still protects against drops before activation.

    # Enable trailing stop loss (disables fixed TAKE_PROFIT when active)
    # Default: false
    TRAILING_STOP_ENABLED=false

    # PnL % at which trailing stop activates
    # Below this level, only the fixed STOP_LOSS protects
    # Default: 15
    TRAILING_STOP_ACTIVATION_PERCENT=15

    # How far below the high water mark before selling (percentage points)
    # Default: 10
    TRAILING_STOP_DISTANCE_PERCENT=10

    # Hard take profit ceiling (0 = disabled)
    # If set, sells immediately at this level even with trailing stop
    # Default: 0
    HARD_TAKE_PROFIT_PERCENT=0


────────────────────────────────────────────────────────────────────────────────
FILE 9 (NOT MODIFIED): pipeline/momentum-gate.ts
────────────────────────────────────────────────────────────────────────────────

NOT modified, NOT deleted. Remains as fallback when sniper gate is disabled.
Can always flip back by setting SNIPER_GATE_ENABLED=false.


================================================================================
5. IMPLEMENTATION ORDER
================================================================================

The implementation has two independent tracks that can be developed in
parallel, plus a final wiring step.

TRACK A: SNIPER GATE (Pipeline)
  A1. pipeline/types.ts
      - Add SniperGateData interface
      - Add sniperGate? to PipelineContext
      - Add rejection reasons
      (Quick, no logic, unlocks type-checking)

  A2. pipeline/sniper-gate.ts (NEW FILE)
      - Full gate implementation (~250-300 lines)
      - Models after momentum-gate.ts structure
      (This is the largest single piece of work)

  A3. pipeline/pipeline.ts
      - Import sniper gate
      - Add config interface fields
      - Wire into process() with if/else branching

TRACK B: TRAILING STOP (Position Monitor)
  B1. risk/pumpfun-position-monitor.ts
      - Add fields to PumpFunPosition
      - Add 'trailing_stop' trigger type
      - Add config fields to PumpFunMonitorConfig
      - Add trailing stop logic to evaluatePosition()
      - Modify existing TP check to skip when trailing active

TRACK C: CONFIG + WIRING (After A and B)
  C1. helpers/config-validator.ts
      - Add all new ValidatedConfig fields
      - Add all env var parsing + validation
      - Add conflict warnings

  C2. helpers/constants.ts
      - Export new config values

  C3. index.ts
      - Pass sniper gate config to pipeline
      - Pass trailing stop config to position monitor
      - Pass sniperWallets to position after buy

  C4. .env.example
      - Add documentation for all new env vars


================================================================================
6. ROLLOUT STRATEGY
================================================================================

PHASE 1: DEPLOY WITH EVERYTHING DISABLED (Day 1)
  .env changes:
    SNIPER_GATE_ENABLED=false
    TRAILING_STOP_ENABLED=false

  What happens:
    - Bot runs exactly as before (momentum gate + fixed TP/SL)
    - Confirms new code doesn't break existing behavior
    - Zero risk deployment

PHASE 2: SNIPER GATE LOG-ONLY MODE (Days 2-4)
  .env changes:
    SNIPER_GATE_ENABLED=true
    SNIPER_GATE_LOG_ONLY=true
    MOMENTUM_GATE_ENABLED=true    # Still doing actual gating

  What happens:
    - Sniper gate runs first, logs all metrics, always passes
    - Momentum gate still does the actual gating
    - You collect data: for each token, how many sniper wallets, how many
      exited, how many organic buyers, correlation with trade outcome
    - After a few days, analyze: what thresholds would have filtered losers
      while keeping winners?

PHASE 3: ENABLE TRAILING STOP (Can overlap with Phase 2)
  .env changes:
    TRAILING_STOP_ENABLED=true
    TRAILING_STOP_ACTIVATION_PERCENT=15
    TRAILING_STOP_DISTANCE_PERCENT=10

  What happens:
    - Trailing stop handles upside (lets winners run)
    - Existing fixed STOP_LOSS still protects downside
    - Can tune activation and distance based on observed behavior

PHASE 4: SNIPER GATE LIVE (After data from Phase 2)
  .env changes:
    SNIPER_GATE_ENABLED=true
    SNIPER_GATE_LOG_ONLY=false
    SNIPER_GATE_MIN_BOT_EXIT_PERCENT=<tuned from data>
    SNIPER_GATE_MIN_ORGANIC_BUYERS=<tuned from data>

  What happens:
    - Sniper gate actively gates trades
    - Momentum gate automatically bypassed (sniper gate takes priority)
    - Higher quality entries -> better win rate -> trailing stop captures gains


================================================================================
7. OPEN QUESTIONS
================================================================================

Q1: SLOT THRESHOLD ACCURACY
    The plan assumes detection.slot is the token creation slot. Is this
    reliable? If our listener detects the token several slots after creation,
    the slot delta calculation will be off. We should verify that detection.slot
    corresponds to the actual token creation slot (from the transaction that
    created the bonding curve), not the slot when our listener processed it.

    IMPACT: If detection.slot is late, we'd classify organic buyers as
    snipers (their slotDelta would appear smaller than it actually is).

    MITIGATION: The creation transaction's slot is in the detection signature.
    When we fetch transactions, we can use the creation slot from the first
    transaction for the bonding curve as ground truth, rather than
    detection.slot.

Q2: OBSERVATION WINDOW vs. ENTRY PRICE
    The sniper gate takes up to ~15.5 seconds (default config) to observe.
    During this time, the token price WILL move. If bots dump and organic
    buyers recover, the price could be significantly higher than at detection.
    This is the fundamental tradeoff: safer entry (fewer bots) vs. higher
    entry price.

    The logOnly phase (Phase 2 of rollout) will quantify this tradeoff with
    real data before committing.

Q3: WHAT IF NO SNIPERS DETECTED?
    Current plan: If botCount === 0 AND organicCount >= minOrganicBuyers,
    PASS immediately. This means tokens with no early bot activity pass
    quickly, which is good - they're the cleanest tokens.

    But: is "no bots detected" actually good, or does it mean the token has
    so little interest that even bots don't care? The minOrganicBuyers
    threshold provides SOME protection here, but worth watching in data.

Q4: SELL PRESSURE MONITORING (DEFERRED)
    Plan B proposed monitoring sell pressure during position holding. This
    was deferred due to RPC cost concerns. After the sniper gate is live and
    generating data, revisit whether sell pressure monitoring adds enough
    value to justify the extra RPC calls. The sniperWallets metadata on the
    position is already in place to enable this later.

Q5: DEFAULT VALUE CHANGES
    Plan B proposed STOP_LOSS 20->10, TAKE_PROFIT 40->0, MAX_HOLD 20s->60s.
    These changes were deferred to avoid forcing untested config on all
    deployments. After Phase 3-4 of rollout, when we have data on the
    trailing stop + sniper gate combination, we should revisit whether the
    defaults should shift. Consider:
    - Is -10% SL too tight when entering later in the token lifecycle?
    - Is 60s MAX_HOLD necessary or does the trailing stop handle exits well?
    - What TRAILING_STOP_ACTIVATION_PERCENT works best with the sniper gate?


================================================================================
SUMMARY OF CHANGES
================================================================================

  NEW:    pipeline/sniper-gate.ts          (~250-300 lines)
  MODIFY: pipeline/types.ts               (~20 lines added)
  MODIFY: pipeline/pipeline.ts            (~30 lines changed)
  MODIFY: risk/pumpfun-position-monitor.ts (~50 lines added)
  MODIFY: helpers/config-validator.ts      (~60 lines added)
  MODIFY: helpers/constants.ts             (~15 lines added)
  MODIFY: index.ts                         (~20 lines changed)
  MODIFY: .env.example                     (~70 lines added)

  Total estimated: ~500-550 lines of new/changed code
  New dependencies: NONE (uses only existing @solana/web3.js)
  Breaking changes: NONE (all new features disabled by default)
  Backward compatible: YES (existing behavior unchanged until opted in)
