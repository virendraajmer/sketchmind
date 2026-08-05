# configs/

Centralized configuration: LLM provider selection, renderer selection, feature
flags, agent budgets, logging, cache, and plugin registry.

Configuration is **injected** into packages via dependency injection. No package
reads global state or `process.env` directly — that is what makes packages
independently testable and replaceable (Volume 11 §Configuration, Volume 12).

The one deliberate exception is `packages/llm-provider-azure-openai`, which reads
the `AZURE_OPENAI_*` variables documented in `.env.example`. Confining provider
credentials to the adapter is what keeps them out of every other package.
