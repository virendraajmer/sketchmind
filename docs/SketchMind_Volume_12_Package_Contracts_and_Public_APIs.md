
# SketchMind
# Volume 12 – Package Contracts & Public APIs

**Version:** 1.0
**Audience:** AI Coding Agents

---

# Purpose

Define the contracts between all SketchMind packages.

Every package communicates through stable, versioned interfaces.

Packages must never depend on another package's internal implementation.

---

# Design Goals

- Contract-first development
- Loose coupling
- Strong typing
- Versioned interfaces
- Independent implementation
- Easy package replacement

---

# Contract Rules

Every package must expose:

- Public API
- Input models
- Output models
- Events
- Errors
- Configuration
- Version

No internal classes or models may be referenced externally.

---

# Standard Package Contract

Every package defines:

- Purpose
- Responsibilities
- Public Interfaces
- Accepted Models
- Produced Models
- Events
- Error Types
- Dependencies
- Extension Points

---

# Core Package Contracts

## ai-orchestrator

Responsibilities

- Execute pipeline
- Manage state
- Coordinate agents

Inputs

- User Request

Outputs

- Pipeline Events

---

## intent-analyzer

Input

- Natural Language

Output

- Intent Model

Never returns graphics.

---

## visual-planner

Input

- Intent Model

Output

- Visual Plan

---

## diagram-reasoner

Input

- Visual Plan

Output

- Diagram AST

---

## shape-intelligence

Input

- Diagram Request

Output

- Shape Graph
- Primitive Definitions

---

## constraint-engine

Input

- Diagram AST

Output

- Constraint Graph

---

## layout-engine

Input

- Constraint Graph

Output

- Layout Model

---

## stroke-planner

Input

- Layout Model

Output

- Stroke AST

---

## stroke-runtime

Input

- Stroke AST

Output

- Runtime Events

---

## renderer-core

Input

- Stroke Runtime

Output

- Frames

---

## primitive-sdk

Responsibilities

- Register
- Discover
- Validate
- Load primitives

---

# Common Models

Shared models include:

- IntentModel
- VisualPlan
- DiagramAST
- ShapeGraph
- ConstraintGraph
- LayoutModel
- StrokeAST
- RuntimeEvent

These belong only in the shared-types package.

---

# Event Contracts

Packages communicate through typed events.

Examples

- PipelineStarted
- StageCompleted
- ValidationFailed
- StrokeStarted
- StrokeCompleted
- RenderingFinished

---

# Error Contracts

Every package exposes structured errors.

Required fields:

- code
- message
- package
- stage
- recoverable

---

# Configuration

Packages receive configuration via dependency injection.

No package reads global state directly.

---

# Versioning

Public APIs follow semantic versioning.

Breaking changes require a major version.

---

# Extension Points

Packages may expose:

- middleware
- plugins
- validators
- providers
- adapters

Extensions must use public APIs only.

---

# Testing

Every public contract requires:

- unit tests
- contract tests
- compatibility tests

---

# Deliverables for AI Coding Agent

Produce:

1. Public interface definitions
2. Shared model definitions
3. Package dependency graph
4. Event contracts
5. Error contracts
6. Versioning strategy
7. Extension mechanism
8. Contract test plan

Implement packages only against these contracts.

---

# Final Principle

Packages communicate through contracts, never implementations.

A package should be replaceable without changing any other package.
