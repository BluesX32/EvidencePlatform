# EvidencePlatform — Project Guide for Claude

## Project Vision

EvidencePlatform is open-source research infrastructure for scalable, reproducible evidence synthesis. It aggregates, evaluates, and synthesizes academic evidence so researchers and policymakers can move from evidence to action with confidence.

The system is built to become a reusable, community-maintained tool for the evidence synthesis community — not a one-off thesis artifact, but durable infrastructure that outlasts the research that created it.

---

## What This System Does

- Ingests and deduplicates literature from multiple sources
- Supports structured extraction of evidence elements (populations, interventions, outcomes, study designs)
- Synthesizes evidence across studies with transparent provenance
- Assists researchers through LLM-powered workflows while keeping humans in control
- Produces auditable, reproducible outputs that can be traced back to source material

---

## Stack

| Layer       | Technology                              |
|-------------|------------------------------------------|
| Backend     | Python, FastAPI                          |
| Frontend    | TypeScript, React                        |
| Database    | PostgreSQL                               |
| AI/LLM      | Optional — extraction, deduplication, workflow automation |

---

## Core Principles

These govern every decision, from API design to naming a variable.

### 1. Reproducibility Above All
Every extraction, synthesis, and decision the system produces must be traceable. If a result cannot be reproduced from documented inputs, it should not be surfaced to users. Pipelines are deterministic by default; non-deterministic steps (LLM calls) are logged with inputs, model version, and outputs.

### 2. Research Rigor Mirrors Software Quality
The same standards that govern good science govern good code here: documented, testable, reviewable. If you wouldn't publish a result without justifying your methods, don't merge code without justifying your design.

### 3. Simplicity Over Cleverness
Prefer clear, readable code over elegant abstractions. A new developer (or a future version of you) should be able to understand any module without context. When there's a simple solution and a clever one, ship the simple one.

### 4. User Trust Is Earned Through Transparency
Sources, confidence levels, and provenance are always visible. The system never hides how it reached a conclusion. If an AI component contributes to an output, that contribution is labeled and auditable.

### 5. AI Assists, Never Decides
LLM components support researchers — they do not replace scientific judgment. Every AI-assisted step has a human review point. Measurement validity and governance matter more than model novelty.

### 6. Auditability and Modularity
The system is designed so any component can be inspected, replaced, or disabled independently. Audit trails are a first-class feature, not an afterthought.

---

## Development Philosophy

### MVP First
We are building to ship a working system. Avoid premature abstraction. Every sprint should produce something runnable and demonstrable. Do not design for hypothetical future requirements — build for what is needed now and leave clear extension points.

### No Speculative Engineering
Do not add features, configuration options, or abstractions beyond what the current milestone requires. If something is not needed today, do not build it today.

### Code That Explains Itself
Comments are for *why*, not *what*. Name things precisely. If a function requires a long comment to explain what it does, the function probably needs to be restructured.

### Tests Where It Counts
Prioritize tests for extraction logic, synthesis pipelines, and any code that processes or transforms evidence. UI tests and infrastructure tests are secondary during MVP. A bug in evidence processing is a scientific error, not just a software bug.

### Data Integrity Is Non-Negotiable
Never mutate raw imported data. All transformations produce new records with provenance. Schema migrations are deliberate and documented.

---

## Long-Term Goals

1. **Community adoption** — The platform is designed to be forked, extended, and contributed to by the evidence synthesis research community.
2. **Interoperability** — Outputs conform to open standards (PICO, PRISMA, RIS/BibTeX) so they integrate with existing research workflows.
3. **AI transparency** — As LLM capabilities grow, the platform's governance model ensures those capabilities are added with clear audit mechanisms, not bolted on.
4. **Reproducible science** — A researcher running this platform in five years should be able to re-run any synthesis and get the same result, or understand exactly why it changed.

---

## What to Avoid

- Over-engineering the data model before the extraction workflow is stable
- LLM integration that bypasses human review
- Any dependency that sacrifices auditability for convenience
- Breaking changes to the evidence schema without a documented migration path
- Features that serve model novelty rather than evidence-to-action translation
