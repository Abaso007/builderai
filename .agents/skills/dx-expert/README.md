# dx-expert

A skill for AI coding agents that enforces developer experience principles in **React Native Expo** projects.

## Install

```bash
npx skills add agustinoberg/dx-expert-skill
```

## What It Does

This skill teaches AI agents to write clean, maintainable React Native code by enforcing:

- **Single Responsibility Principle** — State logic in hooks, rendering in components
- **Hook Architecture** — One hook per file, small & focused, single object arguments
- **Compound Component Pattern** — `Component.Root` / `Component.Header` / `Component.Content` composition over boolean props and prop drilling
- **useEffect Avoidance** — Prefer derived state, event handlers, and computed values
- **Memoization Strategy** — No useCallback (React Compiler), useMemo only for computed constants
- **UX Polish** — Keyboard handling, loading/error/empty states, safe areas, touch targets
- **Expo Router First** — File-based routing, layouts, modals, params before manual alternatives
- **Library Suggestions** — Proactively suggests better libraries when code is obviously reinventing the wheel

## When It Activates

The skill applies automatically when:

- Creating or modifying more than one component
- Writing logic that spans multiple concerns
- Reviewing code that mixes state logic with rendering
- Refactoring existing code for clarity

## Core Philosophy

**Composition is all you need.** Instead of monolithic components with growing lists of boolean props (`isEditing`, `isThread`, `isForwarding`), build distinct component trees that compose shared internals. The provider defines the interface, each consumer decides the implementation.

```tsx
// Not this
<Composer isEditing={true} hideClientPicker={true} showCancelButton={true} />

// This
<EditComposer />  // Renders only what editing needs, no booleans
```

## Compatibility

Works with any AI coding agent that supports the [Agent Skills](https://skills.sh) specification:

- Claude Code
- Cursor
- Windsurf
- Cline
- GitHub Copilot
- And 30+ more

## License

MIT
