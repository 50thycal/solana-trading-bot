# Solana Sniper Trading Bot — North Star Document

## Purpose

This document defines the **intended final behavior and scope** of the Solana Sniper Trading Bot. It serves as a **single source of truth** that Claude should always reference when planning, modifying, or auditing the system. Any implementation decisions should align with the intent described here.

The goal is **clarity over cleverness**: a deterministic, observable, and auditable bot that detects new token launches, evaluates them via filters, executes trades when conditions are met, tracks positions, and exits positions according to defined logic.

---

## High-Level Objective

Build an **automated Solana trading bot** that:

1. Detects **newly launched tokens** as early as possible.
2. Gathers on-chain and protocol-level metadata for those tokens.
3. Runs tokens through a **filtering and risk evaluation pipeline**.
4. Automatically executes buy orders when criteria are met.
5. Tracks open positions and applies sell logic.
6. Logs all activity to a **dashboard for transparency and debugging**.

---

## Core Philosophy

* **Event-driven first**: WebSockets over polling wherever possible.
* **Source-agnostic ingestion**: Multiple discovery sources, unified internally.
* **Deterministic decision-making**: Every buy/sell must be explainable via logged rules.
* **Safety > speed** (but still fast): Avoid obvious rugs, exploits, and malformed pools.
* **Observability**: If something happens, it should be visible in logs and dashboards.

---

## System Lifecycle (End-to-End)

### 1. Token Discovery

The bot continuously listens for **new token or liquidity pool creation events** on Solana using:

* **WebSockets** (primary)
* **APIs / RPC calls** (secondary / enrichment)

#### Discovery Sources (Initial Scope)

* Pump.fun
* Meteora
* Raydium

> These sources may expose new tokens via pool creation, bonding curves, or liquidity initialization events.

All discovery events are normalized into a **single internal token event format**.

---

### 2. Token Data Enrichment

Once a new token is detected, the bot gathers metadata such as:

* Mint address
* Pool address(es)
* DEX / protocol type
* Initial liquidity
* Token supply / decimals
* Creator / authority info (if available)
* Timestamp of discovery

This step does **not** make trade decisions. It strictly gathers facts.

---

### 3. Filtering & Risk Evaluation

Each discovered token is passed through a **multi-stage filter pipeline**.

The filtering system determines:

* Whether the token is **eligible to buy**
* Or should be **ignored permanently**

Examples of filter categories (non-exhaustive):

* Duplicate / already-seen token checks
* Blacklist checks (mint, deployer, program)
* Liquidity thresholds
* Pool type validation
* Supply / mint authority sanity checks
* Basic rug-risk heuristics

Each filter stage:

* Must return **pass / fail / soft-fail**
* Must log its decision

Only tokens that **fully pass** proceed to execution.

---

### 4. Trade Execution (Buy)

When a token passes all filters:

* A buy transaction is constructed and submitted
* Trade size is determined by pre-defined risk rules
* Slippage and fee constraints are enforced

After execution:

* The token is registered in the **Position Tracker**
* The buy is logged with full metadata

No token may be bought without being registered in the tracker.

---

### 5. Position Tracking

The Position Tracker is the **source of truth for active trades**.

For each open position, it tracks:

* Entry price
* Entry time
* Amount held
* Pool(s) used
* Current status (open, closing, closed)

The tracker continuously evaluates **sell conditions**.

---

### 6. Sell Logic & Exit

Sell logic determines when and how to exit a position.

Triggers may include:

* Profit targets
* Stop-loss thresholds
* Time-based exits
* Liquidity deterioration
* Manual override (if supported)

Once a sell is executed:

* Position is marked as closed
* No further actions are taken on that token
* Final PnL is recorded

This concludes the lifecycle of that token.

---

## Dashboard & Logging

The bot must expose a **dashboard or structured logs** that show:

* Discovered tokens (including filtered-out ones)
* Filter decisions and reasons
* Buy and sell executions
* Active positions
* Errors and warnings

The dashboard is **not optional**. It is required for:

* Debugging
* Strategy iteration
* Post-mortem analysis

---

## Non-Goals (Explicitly Out of Scope)

* Predicting price direction beyond rule-based heuristics
* Social sentiment scraping (for now)
* Fully autonomous strategy mutation
* Manual discretionary trading

---

## Success Criteria

The project is successful when:

* New token launches are reliably detected from multiple sources
* Every buy and sell is explainable via logs
* No silent failures occur
* The system can run unattended for extended periods

---

## Guiding Principle for Claude

When in doubt:

> **Favor clarity, safety, and observability over speed or complexity.**

Any architectural or implementation decision should be justified by how well it supports the lifecycle defined above.
