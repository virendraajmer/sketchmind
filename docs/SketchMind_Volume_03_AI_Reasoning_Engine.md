
# SketchMind
# Volume 03 – AI Reasoning Engine

**Version:** 1.0  
**Audience:** AI Coding Agents

---

# Purpose

Define how AI reasoning works inside SketchMind.

This document specifies the responsibilities of every AI agent, the reasoning pipeline, the contracts between agents, and the expected outputs.

The AI should reason about **concepts**, never graphics.

---

# Design Goals

- Separate reasoning from rendering.
- Produce deterministic outputs.
- Support any technical domain.
- Allow multiple LLM providers.
- Keep prompts modular.
- Produce structured data only.

---

# AI Pipeline

```text
User Request
      │
      ▼
Intent Analyzer
      │
      ▼
Visual Planning Agent
      │
      ▼
Diagram Reasoning Agent
      │
      ▼
Diagram AST
      │
      ▼
Geometry Pipeline
```

---

# Agent Responsibilities

## Intent Analyzer

Responsibilities

- Understand user intent
- Detect subject
- Detect diagram type
- Determine complexity
- Identify teaching objective

Output

- Intent
- Domain
- Diagram Category

---

## Visual Planning Agent

Responsibilities

- Decide what should appear
- Select objects
- Select labels
- Select highlights
- Select animations
- Decide level of detail

Example

Input:

Draw a pulley system.

Output

Objects

- Ceiling
- Fixed Pulley
- Movable Pulley
- Rope
- Load
- Force Arrow

No geometry.

---

## Diagram Reasoning Agent

Responsibilities

- Understand object relationships
- Build semantic model
- Build hierarchy
- Build anchors
- Build metadata

Output

Diagram AST

Never outputs coordinates.

---

# Diagram AST Contract

Must contain

- Diagram Type
- Subject
- Objects
- Relationships
- Labels
- Anchors
- Metadata
- Style Hints

Must NOT contain

- SVG
- Canvas commands
- Coordinates
- Rendering instructions

---

# Prompting Strategy

Separate prompts into reusable modules.

System Prompt

Defines AI personality and architecture.

Planner Prompt

Defines visual planning rules.

Reasoning Prompt

Defines semantic modeling rules.

Domain Prompt

Contains domain-specific knowledge.

Runtime Prompt

Contains current user request.

---

# Multi-LLM Support

The architecture must support:

- OpenAI
- Anthropic
- Gemini
- Local Models

No provider-specific logic should leak into the application.

---

# AI Output Rules

Always produce:

- Structured JSON
- Stable identifiers
- Semantic names
- Relationships
- No geometry

Never produce:

- SVG
- HTML
- Canvas code
- Konva code
- Drawing commands

---

# Error Handling

If knowledge is incomplete:

- Produce partial diagram
- Mark unknown components
- Continue reasoning

Never fabricate technical relationships.

---

# Extensibility

Support additional reasoning modules:

- Physics
- Chemistry
- Biology
- Mathematics
- Engineering
- Electronics
- Architecture

Each module should extend reasoning without modifying the core engine.

---

# Expected Workflow

Input

"Draw a hydraulic press."

AI should:

1. Identify domain.
2. Identify diagram type.
3. Discover components.
4. Discover relationships.
5. Produce Diagram AST.

Geometry generation begins only after reasoning completes.

---

# Deliverables for AI Coding Agent

Design:

1. AI Agent interfaces
2. Prompt management
3. Provider abstraction
4. Structured output validation
5. Retry strategy
6. AI orchestration
7. Domain plugin mechanism

Do not implement rendering logic in AI components.

---

# Final Principle

The AI's responsibility ends at the Diagram AST.

Everything after that is deterministic software.
