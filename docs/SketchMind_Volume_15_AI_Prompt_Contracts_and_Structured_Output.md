
# SketchMind
# Volume 15 – AI Prompt Contracts & Structured Output Specification

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

Define standardized prompt contracts and structured outputs for every AI agent.

All AI components must communicate using validated structured models.

---

# Design Goals

- Provider independent
- Deterministic outputs
- JSON-first
- Versioned prompts
- Strong validation
- Easy testing

---

# AI Workflow

User Request

↓

Intent Analyzer

↓

Visual Planner

↓

Shape Intelligence

↓

Diagram Reasoner

↓

Visual Intent Language

↓

Diagram AST

---

# Prompt Contract

Every AI prompt contains:

- Prompt Version
- Agent Role
- Responsibilities
- Input Schema
- Output Schema
- Constraints
- Validation Rules
- Error Rules
- Examples

---

# Standard Prompt Template

Every prompt must define:

- System Instructions
- Agent Objective
- Allowed Inputs
- Expected Output
- Forbidden Output
- Completion Rules

---

# Agent Contracts

## Intent Analyzer

Input

- Natural language

Output

- Intent Model

Must never output graphics.

---

## Visual Planner

Input

- Intent Model

Output

- Visual Plan

Must only decide what should appear.

---

## Shape Intelligence

Input

- Visual Plan

Output

- Shape Graph

Must reason about structure only.

---

## Diagram Reasoner

Input

- Shape Graph

Output

- Diagram AST

Must not produce coordinates.

---

# Structured Output Rules

Every response must:

- Match schema
- Use stable identifiers
- Include version
- Include confidence
- Include validation status

Never return free-form paragraphs.

---

# Validation

Validate:

- Required fields
- Schema version
- Object references
- Duplicate identifiers
- Unknown object types

Reject invalid responses.

---

# Retry Strategy

Retry only when:

- Schema invalid
- Missing fields
- Empty response
- Provider timeout

Do not retry deterministic stages.

---

# Prompt Versioning

Each prompt includes:

- id
- version
- compatible schema
- supported models

Support side-by-side prompt evolution.

---

# Multi-Provider Support

Support:

- OpenAI
- Anthropic
- Gemini
- Local Models

Provider adapters convert provider responses into common models.

---

# Guardrails

AI must never produce:

- Coordinates
- SVG
- Canvas code
- Konva commands
- Rendering logic

AI reasons only.

---

# Few-shot Examples

Each prompt package should include:

- Minimum examples
- Complex examples
- Invalid examples
- Recovery examples

Examples are versioned with prompts.

---

# Deliverables for AI Coding Agent

Design:

1. Prompt repository
2. Prompt loader
3. Prompt version manager
4. Structured output schemas
5. Validation framework
6. Retry manager
7. Provider adapters
8. Prompt test suite

Implementation should isolate prompts from application code.

---

# Final Principle

Prompts are executable contracts.

Every AI response must be predictable, validated and consumable by deterministic software.
