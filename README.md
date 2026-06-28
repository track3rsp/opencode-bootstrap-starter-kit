# OpenCode Bootstrap Starter Kit

This repository is a Bootstrap Starter Kit for creating new AI-assisted software projects.

The Starter Kit and the generated project are intentionally separated.

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
- Generate `/workspace/PROJECT_PROFILE.md`.
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

Once the project has been generated:

- Open OpenCode inside `/workspace`.

From that point forward, the generated project is completely independent from the Bootstrap Starter Kit.

Project development should never require reading or modifying the Starter Kit.
