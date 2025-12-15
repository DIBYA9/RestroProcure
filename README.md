# RestroProcure

A policy-bound AI procurement planning system for restaurants, built using Google Gemini (via Vertex AI) with explicit agentic workflows, structured tool-calling, and refusal-safe decision logic.

---

## Overview

RestroProcure converts informal human instructions and raw inventory data into a deterministic, auditable procurement plan. Instead of behaving like a generic chatbot, the system enforces strict operational policies, applies calendar-aware demand multipliers, and produces structured outputs through mandatory function calls.

The goal is to demonstrate how Generative AI can be used as a bounded decision agent rather than an open-ended conversational model.

---

## Key Capabilities

* Policy-driven procurement planning
* Calendar-aware demand adjustment (weekday vs weekend vs high-impact events)
* Explicit refusal handling for unsafe planning horizons
* Deterministic, structured output using Gemini function calling
* Free-tier optimized execution with caching
* Fully explainable, item-level reasoning

---

## User Interface

The application is built as a single-page React interface with clear separation between inputs, agent execution, and outputs.

### Planning Control Panel

* Adjustable planning horizon (1–30 days)
* Visual warning for horizons exceeding safe limits
* Natural language instruction input (supports Hinglish)

### Inventory Input

* Paste or upload CSV-based inventory data
* Minimal required schema:

```
Item,Current Stock,Unit,Avg Daily Usage,Market Price (INR)
```

### Agent Runtime Console

* Live, step-by-step execution logs
* Visibility into calendar checks, policy selection, cache hits, and tool execution

### Procurement Output

* Total estimated procurement cost
* Item-wise recommendations
* Applied policy per item
* Risk classification and reasoning

### Refusal State

* Explicit refusal when planning conditions are unsafe
* Human-readable explanation instead of hallucinated forecasts

---

## System Architecture

```
User Input (Inventory + Instruction)
        ↓
Calendar Context Injection
        ↓
Policy-Bound Gemini Agent
        ↓
Mandatory Function Call
        ↓
Structured Plan or Refusal
        ↓
Firestore Cache (SHA-256 Keyed)
```

---

## Gemini API Usage

### Model

* gemini-2.5-flash-preview

Selected for strong reasoning performance and cost efficiency during development and hackathon usage.

### Prompt Engineering Strategy

The system prompt enforces:

* Explicit operational policies
* Hard numeric demand multipliers
* Mandatory refusal conditions
* Tool-only output (no free-form text)

Gemini is not allowed to respond conversationally. All outputs must be generated through a defined function call.

### Function Calling

The agent must call the following tool to complete execution:

```
submit_procurement_plan(...)
```

The schema enforces:

* SUCCESS or REFUSED status
* Item-level policies and risk tags
* Cost calculations
* Human-readable reasoning

If the function is not called, execution is treated as a failure.

---

## Policy Guardrails

| Policy ID          | Description                                   |
| ------------------ | --------------------------------------------- |
| STANDARD_OP        | 1.1× buffer for regular weekdays              |
| WEEKEND_RUSH       | 1.3×–1.5× buffer for Fri–Sun                  |
| HIGH_IMPACT_EVENT  | 1.8×–2.5× buffer for festivals                |
| LOW_STOCK_CRITICAL | Mandatory risk flag for dangerously low stock |
| REFUSAL_PROTOCOL   | Automatic refusal beyond 14-day horizon       |

These guardrails ensure predictable and safe decision-making.

---

## Free-Tier Optimization

* Single Gemini API call per execution
* Input validation before API invocation
* SHA-256 keyed Firestore caching
* Identical inputs return cached results without additional cost

---

## Tech Stack

* Frontend: React
* Icons: Lucide React
* AI: Google Gemini via Vertex AI
* Authentication: Firebase Anonymous Auth
* Storage & Cache: Firestore

---

## Local Setup

Clone the repository and install dependencies:

```
git clone https://github.com/your-username/restroprocure
cd restroprocure
npm install
npm run dev
```

---

## API Key Disclaimer

This project requires a Google Gemini API key.

Do not commit API keys to version control.

Provide the key securely using environment variables or runtime injection, for example:

```
VITE_GEMINI_API_KEY=your_api_key_here
```

The repository does not contain any hard-coded secrets.

---

## Example Usage

Instruction:

```
Kal weekend hai, thoda extra rakhna
```

Result:

* Weekend policy automatically applied
* Higher buffer for high-usage and perishable items
* Transparent, item-level reasoning

---

## Future Extensions

* Live festival and cultural calendar APIs
* POS and sales data integration
* Automated supplier ordering
* Multi-outlet inventory support
* Voice-based inputs

---

## License

This project is provided for development and demonstration purposes. All intellectual property remains with the author.

---

## Design Philosophy

RestroProcure demonstrates how large language models can be used as constrained decision agents rather than unrestricted chat systems. The emphasis is on safety, explainability, and deterministic behavior suitable for real operational workflows.
