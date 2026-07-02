# OpenCode Bootstrap Starter Kit

This repository is a Bootstrap Starter Kit for creating new AI-assisted software projects.

The Starter Kit and the generated project are intentionally separated.

# Why this project exists

Modern AI coding assistants are incredibly powerful, but long-term software projects still face the same recurring problems:

- AI gradually loses project context.
- Documentation becomes outdated.
- Architecture slowly drifts over time.
- Every new session requires re-explaining the project.
- Development workflows become inconsistent.
- Large projects become increasingly difficult to maintain.

**OpenCode Bootstrap Starter Kit** addresses these challenges by generating an AI-first workspace designed for long-term software development.

Instead of providing only templates or boilerplate files, it creates a structured environment where the AI can consistently understand, evolve, document, review, and maintain the project throughout its entire lifecycle.

The result is a workspace that remains organized, coherent, and maintainable across weeks, months, or even years of development.

# What this kit generates

Running the bootstrap produces much more than a project scaffold. It generates a complete AI-guided workspace designed to support the entire software development lifecycle.

| Generated component | Purpose |
|---------------------|---------|
| Project Constitution | Defines the permanent rules that guide the project. |
| Project Profile | Captures the project vision, requirements and objectives generated from `USER.md`. |
| AI Prompt Library | Provides structured workflows for every development stage. |
| Living Documentation | Keeps architecture and technical documentation synchronized with the codebase. |
| Task Management | Organizes pending work and project evolution. |
| Session Continuity | Allows the AI to resume development without rebuilding project context. |
| Review Workflows | Encourages periodic technical and architectural reviews. |
| Refactoring Workflows | Guides safe evolution of the codebase while preserving consistency. |
| Handoff Documentation | Makes it possible to pause development and continue later with minimal context loss. |

Every generated workspace is adapted to the information provided in `USER.md`, meaning no two projects are necessarily identical, while still following the same development methodology.

# What problems it solves

This framework is specifically designed to eliminate many of the common problems encountered when using AI assistants on medium and large software projects.

- ✅ Reduces context loss between AI sessions.
- ✅ Prevents architectural drift over time.
- ✅ Encourages documentation to evolve alongside the code.
- ✅ Provides repeatable development workflows.
- ✅ Minimizes time spent re-explaining the project.
- ✅ Promotes consistent implementation patterns.
- ✅ Makes long-term maintenance significantly easier.
- ✅ Helps keep requirements, tasks and documentation aligned.
- ✅ Supports projects that continue evolving for months or years.

Rather than treating each AI conversation as an isolated interaction, the generated workspace enables every development session to build upon the previous one through structured documentation and standardized workflows.

# What you end up with

After the bootstrap completes, your project becomes more than a source code repository.

The generated workspace provides:

- A persistent AI development environment.
- A documented project architecture.
- Standardized development workflows.
- Living technical documentation.
- Guided feature implementation.
- Structured review and refactoring processes.
- Session continuity across future AI interactions.
- A project that can continue evolving without repeatedly rebuilding context.

The goal is to allow both developers and AI assistants to collaborate efficiently throughout the entire lifetime of the project, not just during its initial creation.

# Typical AI development workflow

A generated workspace is intended to be used through a simple, repeatable workflow.

### 1. Create the project

```text
Proceed with prompts/BOOTSTRAP_INIT.md
```

Generates the complete project structure from the information defined in `USER.md`.

### 2. Continue development

```text
Proceed with prompts/CONTINUE.md
```

Resumes the project from its current documented state and continues the next development task.

### 3. Implement a new feature

```text
Proceed with prompts/FEATURE.md

Feature:
Implement JWT authentication with refresh tokens.
```

The AI analyzes the existing architecture, implements the feature, updates documentation and integrates it into the project.

### 4. Fix a bug

```text
Proceed with prompts/CONTINUE.md

Bug:
Checkout fails when using PayPal.
```

The AI investigates the issue, applies the fix, validates the result and updates any affected documentation.

### 5. Review the project

```text
Proceed with prompts/REVIEW.md
```

Performs an architectural and technical review, identifying possible improvements while keeping documentation synchronized.

### 6. Refactor safely

```text
Proceed with prompts/REFACTOR.md
```

Guides larger refactoring tasks while preserving project consistency.

### 7. End the session

```text
Proceed with prompts/SUSPEND.md
```

Updates documentation and leaves the workspace ready for the next development session.

### 8. Resume later

```text
Proceed with prompts/RESUME.md
```

Allows development to continue days, weeks or months later without rebuilding project context.

# How to guide the AI

The generated prompts work best when requests describe goals rather than implementation details.

### Good examples

```text
Proceed with prompts/FEATURE.md

Implement inventory reservations.

Keep the current architecture.

Update all affected documentation.

Update pending tasks.

Run available tests before finishing.
```

```text
Proceed with prompts/CONTINUE.md

Bug:

Orders cannot be cancelled after payment confirmation.
```

```text
Proceed with prompts/REVIEW.md

Review the authentication system and suggest architectural improvements.
```

### Less effective requests

```text
Write this file.

Create this function.

Do this quickly.

Skip documentation.

Ignore existing architecture.
```

The framework is designed so that the AI understands the project first, plans the work, performs the implementation, validates the result and finally updates the project documentation.

# Philosophy

This project is based on a simple idea:

The AI should not behave as a code generator that forgets everything after each conversation.

Instead, the generated workspace encourages the AI to act as a long-term software engineering partner capable of:

- Understanding the project before making changes.
- Respecting established architectural decisions.
- Maintaining technical documentation.
- Reviewing previous work.
- Detecting inconsistencies.
- Planning future development.
- Keeping project knowledge persistent across sessions.

The objective is not only to generate code, but to continuously improve and maintain the entire project over time.

# Long-term projects

OpenCode Bootstrap Starter Kit has been designed with long-lived software projects in mind.

Whether the project lasts several weeks or several years, the generated workspace aims to preserve continuity by keeping requirements, architecture, documentation and development workflows synchronized.

Instead of restarting from zero in every AI conversation, each new session builds upon the documented state left by the previous one.

This approach reduces context rebuilding, improves consistency and allows both developers and AI assistants to collaborate more effectively throughout the lifetime of the project.

# Why it's different

| Traditional starter kit | OpenCode Bootstrap Starter Kit |
|--------------------------|--------------------------------|
| Generates files once | Generates a complete AI-guided development workflow |
| Static templates | Workspace adapted from `USER.md` |
| Little or no session continuity | Persistent project continuity |
| Documentation is often forgotten | Documentation is updated throughout development |
| AI starts with limited context | AI resumes from the documented project state |
| Focused on scaffolding | Focused on the complete software development lifecycle |

The objective is not simply to bootstrap a project, but to establish a repeatable methodology that allows AI-assisted development to remain organized, consistent and maintainable over time.

# Frequently asked questions

### Does this only work with OpenCode?

No. The generated workspace is based on documentation and prompts, making it compatible with many AI coding assistants. OpenCode is the primary target, but the methodology can be adapted to other tools.

### Will every generated workspace be identical?

No. Each workspace is generated from the information provided in `USER.md`. The project structure, documentation and guidance adapt to the project's specific objectives while following the same methodology.

### Can I modify the generated prompts?

Yes. The generated prompts are intended to be customized as your project evolves.

### Is this intended for small projects?

It can be used for projects of any size, but its greatest benefits become apparent in medium and large projects where maintaining context, documentation and architectural consistency becomes increasingly important.

### Does the documentation evolve with the project?

Yes. One of the core principles of the framework is that documentation should evolve alongside the implementation, helping future AI sessions and human developers understand the current state of the project.

## Repository Structure

```
/
├── BOOTSTRAP_FRAMEWORK.md
├── BOOTSTRAP_HANDOFF.md
├── USER.md
├── README.md
├── prompts/
│   └── framework/
└── workspace/
```

## Folder Responsibilities

The repository root contains the Bootstrap Starter Kit.

The generated project exists exclusively inside `/workspace`.

The generated project must never depend on any file outside `/workspace`.

The Starter Kit may continue evolving independently from any generated project.

## Creating a New Project

1. Open `USER.md`.

2. Describe the project naturally using your own words.

3. Open OpenCode from the repository root.

4. Execute:

```
Execute BOOTSTRAP_FRAMEWORK.md
```

or

```
Read BOOTSTRAP_FRAMEWORK.md completely and execute its bootstrap process.
```

The Bootstrap Framework will:

- Analyze `USER.md`.
- Ask clarification questions only when they affect the project's architecture.
- Generate `/workspace/PROJECT_PROFILE.md` as the official technical specification.
- Detect the preferred AI development settings from the user's description whenever possible.
- Store those settings inside `PROJECT_PROFILE.md` under a dedicated **AI Development Preferences** section.
- Generate the complete project ecosystem inside `/workspace`.

## Continuing Bootstrap Framework Development

To continue improving the Bootstrap Framework itself:

- Open OpenCode in the repository root.
- Use one of the prompts inside:

```
prompts/framework/
```

The Bootstrap Framework uses `BOOTSTRAP_HANDOFF.md` to preserve its own state between sessions.

## Continuing Project Development

Once the Bootstrap Framework has finished, the generated project is completely independent from the Bootstrap Starter Kit.

From this point forward:

1. Open OpenCode inside `/workspace`.

2. Work only with the generated project.

3. The Bootstrap Starter Kit is no longer required for normal project development.

Every project generated by the Bootstrap Framework contains its own documentation, prompts, workflow and AI guidance.

Future development should always begin by following the generated project documentation.

### Customizing AI Behaviour

The Bootstrap Framework stores the AI development preferences inside `PROJECT_PROFILE.md`.

This section defines how the AI should collaborate during development.

Typical preferences include:

- Conversation language.
- Documentation language.
- Code comment language.
- Commit message language.
- Identifier naming conventions.
- Communication style.
- Reasoning verbosity.
- Output formatting preferences.

These settings may be modified at any time as the project evolves.

Future project prompts should automatically follow the preferences defined in `PROJECT_PROFILE.md`.

### Typical Workflow

```
Clone Starter Kit

↓

Edit USER.md

↓

Execute BOOTSTRAP_FRAMEWORK.md

↓

Bootstrap generates the project inside /workspace

↓

Open OpenCode inside /workspace

↓

Continue normal project development
```

### Example

Imagine you write the following inside `USER.md`:

> I want to create a simple desktop application to manage personal expenses.
> I prefer speaking with the AI in Spanish.
> Generate the application in Catalan.
> Keep all technical documentation in English.
> Use Open Source technologies whenever possible.

The Bootstrap Framework will interpret those requirements and generate a `PROJECT_PROFILE.md` that includes both the project specification and the AI Development Preferences.

From that point onward, the generated prompts should automatically respect those preferences without requiring you to repeat them in every conversation.
