# Contributing guidelines

This document outlines guides to get started on developing the starter kit.

## Contributing to the docs

Contributions to the docs are also welcome! We've documented the steps to do so [here](./docs/in-depth/contributing.md).

## The Five Golden Rules

The simple steps of contributing to any GitHub project are as follows:

1. [Fork the repository](https://github.com/screepers/screeps-typescript-starter/fork)
2. Create your feature branch: `git checkout -b my-new-feature`
3. Commit your changes: `git commit -am 'Add some feature'`
4. Push to the branch: `git push -u origin my-new-feature`
5. Create a [Pull Request](https://github.com/screepers/screeps-typescript-starter/pulls)!

To keep your fork of in sync with this repository, [follow this guide](https://help.github.com/articles/syncing-a-fork/).

## Submitting a pull request

We accept almost all pull requests, as long as the following criterias are met:

* Your code must pass all of the linter checks (`npm run lint`)
* When adding a new feature, make sure it doesn't increase the complexity of the tooling. We want this starter kit to be approachable to folks who have little to no knowledge of TypeScript, or even JavaScript.
* When making changes that are potentially breaking, careful discussion must be done with the community at large. Generally we do this either on the [#typescript](https://screeps.slack.com/messages/typecript/) channel on the Screeps Slack, or on the corresponding pull request discussion thread.

# Contributing Guidelines

## Code Style & Conventions

### Object Storage
We prefer object literal syntax over Map for storing key-value data. This choice is particularly important for Screeps due to memory serialization requirements.

#### ✅ Preferred Pattern
```typescript
private items: { [key: string]: Item } = {};
// Adding items
this.items[key] = value;
// Removing items
delete this.items[key];
// Accessing items
const item = this.items[key];
```

#### ❌ Avoid
```typescript
private items: Map<string, Item> = new Map();
// Adding items
this.items.set(key, value);
// Removing items
this.items.delete(key);
// Accessing items
const item = this.items.get(key);
```

#### Rationale
**Why Object Literals?**
- Better serialization support for Screeps memory
- More familiar JavaScript syntax
- Direct property access is more performant
- Cleaner debugging output
- Natural JSON.stringify/parse support

**When to use Map instead:**
- Non-string keys are required
- Key insertion order must be preserved
- Frequent size checks or iterations needed
- Built-in methods like .has(), .clear() are heavily used

## Pull Request Process
1. Ensure code follows established conventions
2. Update documentation as needed
3. Add tests for new functionality
4. Verify all tests pass
5. Request review from maintainers

## Questions?
Open an issue for any questions about these guidelines.
