/goal Build **Crumble**, a production-quality, client/server AI agent platform comparable to Hermes Agent and Grokbot, powered by **pi-durable**.

The goal is a polished, reliable, extensible platform for creating, configuring, managing, and interacting with persistent AI agents.

## Project structure

The project consists of two independent Git repositories:

- `bot/` — Server: `git@github.com:crumble-project/bot.git`
- `desktop/` — macOS client: `git@github.com:crumble-project/desktop.git`

The server is responsible for agent execution, persistence, scheduling, integrations, and orchestration.

The desktop client is a native SwiftUI app and targets macOS exclusively. It was first built with mygo (https://mygo.egoist.dev/), then moved to SwiftUI for native controls. It should feel like a first-class native macOS application, embracing Liquid Glass and modern macOS design conventions.

Both repositories must remain independently maintainable.

## Product vision

Create a complete personal AI agent platform offering feature parity with Hermes Agent and Grokbot's bot management capabilities.

Users should be able to create multiple independent agents, each with its own identity, configuration, capabilities, and ongoing responsibilities.

The platform should support:

- **Agent management:** Create, edit, duplicate, configure, organize, enable, disable, and delete agents.
- **Agent identities:** Names, avatars, descriptions, personalities, system instructions, profiles, and behavioral preferences.
- **Conversations:** Persistent conversations, streaming responses, conversation history, and management of multiple sessions.
- **Tasks and automation:** One-time tasks, recurring schedules, autonomous tasks, background execution, and execution history.
- **Tools and integrations:** Extensible tools, MCP servers, skills, and integrations configurable for individual agents.
- **Memory and context:** Persistent agent memory, configurable context, and continuity across conversations and executions.
- **Model configuration:** Flexible providers, models, credentials, inference parameters, and per-agent overrides.
- **Agent autonomy:** Long-running tasks, resumable execution, recovery from interruptions, and proactive behavior.
- **Permissions and isolation:** Explicit capabilities, appropriate access boundaries, approval workflows, and secure handling of credentials.
- **Observability:** Agent status, active executions, logs, errors, task history, and useful execution diagnostics.
- **Multi-agent workflows:** Multiple independently configured agents operating concurrently, with appropriate coordination where useful.
- **Settings:** Comprehensive global settings and per-agent configuration.

Treat Hermes Agent and Grokbot as product references, not as architectural prescriptions. Research their relevant capabilities independently and identify missing functionality needed to deliver meaningful feature parity.

Feature parity means functioning end-to-end capabilities, not merely equivalent UI screens.

## Desktop experience

The macOS application is a flagship part of the product, not an administrative afterthought.

Aim for the quality and coherence of an exceptionally polished native Mac application.

Prioritize:

- Native Liquid Glass aesthetics, materials, and interactions.
- Excellent typography, spacing, hierarchy, and visual consistency.
- Thoughtful navigation and information architecture.
- Beautiful agent profiles, conversation views, and management interfaces.
- Smooth animations and meaningful transitions.
- Excellent keyboard support, shortcuts, and accessibility.
- Responsive streaming and immediate interaction feedback.
- Clear loading, empty, error, offline, and recovery states.
- Proper macOS window behavior and platform conventions.
- A cohesive design system throughout the application.

Avoid generic web-dashboard aesthetics, inconsistent components, unnecessary visual complexity, and interfaces that expose implementation details to users.

Every interaction should feel deliberate and refined.

## Engineering principles

**Favor maintainability, correctness, simplicity, and established solutions over unnecessary custom engineering.**

- Follow clean-code principles and clear separation of responsibilities.
- Research established packages and frameworks before implementing functionality yourself.
- Prefer mature, actively maintained dependencies over custom implementations whenever practical.
- Avoid reinventing authentication, scheduling, persistence, validation, communication protocols, and other solved problems.
- Avoid speculative abstractions, unnecessary layers, and premature optimization.
- Keep components and modules cohesive, appropriately scoped, and independently testable.
- Design explicit, consistent contracts between server and client.
- Treat error handling, cancellation, retries, and recovery as first-class concerns.
- Design for security, extensibility, and operational reliability from the beginning.
- Maintain strong automated test coverage for important behavior.
- Keep both repositories well organized and documented.

Use **pi-durable as the foundation for agent execution and durability**. Understand and leverage its existing capabilities instead of recreating them.

Make technical decisions independently after inspecting the actual project, its dependencies, and the relevant ecosystems.

## Execution expectations

Take ownership of the project from research through implementation.

1. Inspect both repositories and understand their existing state.
2. Research pi-durable, mygo, Hermes Agent, and Grokbot sufficiently to establish a realistic implementation direction.
3. Define the target product capabilities, architecture, and coherent user experience.
4. Break the work into manageable, independently verifiable milestones.
5. Implement complete vertical slices across server and desktop rather than disconnected scaffolding.
6. Continuously build, run, test, review, and refine the result.
7. Iterate on usability, visual quality, reliability, and architectural consistency.
8. Document important decisions and remaining limitations.

Do not stop after planning, creating architecture documents, or producing initial scaffolding. The objective is a functioning product.

Avoid unnecessary confirmation requests. Resolve ordinary engineering decisions autonomously, using sound judgment.

## Definition of done

The goal is complete when:

- The server provides reliable, persistent, independently managed AI agents powered by pi-durable.
- The macOS client provides a cohesive, highly polished experience for the platform's core functionality.
- Agent creation, configuration, conversations, memory, tools, tasks, and background execution work end to end.
- Multiple agents can operate independently without unintended state or permission leakage.
- The application handles realistic failures, restarts, cancellations, and reconnections gracefully.
- Hermes/Grokbot-equivalent bot management capabilities are implemented and verified.
- Both projects build successfully and have meaningful automated tests.
- No critical workflows are placeholders, mocks, or cosmetic-only implementations.
- The codebases remain clean, maintainable, and suitable for continued development.

**Optimize for the quality of the finished product, not the amount of code written or the number of features superficially implemented.**

Treat this as a real software product intended for daily use, not a prototype, demo, or proof of concept.