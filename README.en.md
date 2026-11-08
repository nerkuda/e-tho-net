[Русский](README.md) | **English**

# ETN — The Endless Thought Network

A free, self-hosted "digital brain": notes, ideas, tasks and files live not in
folders but as a directed graph of linked thoughts that you can browse like a
mind — from the general to the particular and back. Inspired by TheBrain, but it
does not copy it; instead it develops its own methods of working with
information — your own server, your own data, no subscriptions and no clouds.

![CI](https://github.com/nerkuda/e-tho-net/actions/workflows/ci.yml/badge.svg) ![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)

![demo-gif](docs/images/ETN-Вторая%20память.gif)

## Why ETN when Obsidian and TheBrain exist

I have run a knowledge base in Obsidian and TheBrain side by side for years.
The honest breakdown that ETN grew from:

- **Obsidian** — the best note-taker of all that I have tried. But free
  synchronization is a headache. Understanding what a link means takes real
  effort — and you cannot use that understanding in queries. Keeping a
  chronicle per individual note is not easy either.
- **TheBrain** wins you over with the plex, but it does not give Obsidian's
  freedom. Thought and property types cost money — and even then you cannot add
  properties to thoughts. And syncing it without someone else's server and a
  paid subscription is next to impossible.
- **ETN** set out to take the best of both. Thoughts in it can be genuinely
  atomic and carry properties; links between them have meaning. Data lives only
  where the user decides, and there is nothing to synchronize — all work
  happens in real time.
- **Graph memory for agents.** Unlike memory stores built only for agents, ETN
  is a knowledge base for a human, which agents join over MCP. They walk the
  graph of links instead of vector search — and work with the same knowledge as
  you.

A feature-by-feature comparison — in the
[documentation](docs/userdocs/comparison.md).

## Who it fits (and who it does not)

It fits if you:

- keep a knowledge base in files and are tired of a note living in a single
  folder;
- want AI agents to work with your knowledge, not the other way around;
- value open source and control over your data;
- have somewhere to keep an always-on server — a home PC or a VPS: without it,
  there is no knowledge base;
- build your own AI agents and need reliable memory and RAG.

It does not fit if you:

- need a mobile client "right now" (it is only planned);
- need autonomous copies of the knowledge base on every computer;
- are looking for a simple note-taker without graph logic.

## Key features

- 🧠 **A graph instead of folders.** A thought lives in all of its contexts at
  once; the map shows the selected thought in the center together with its
  surroundings.
- 🏷️ **Links with meaning.** Typed link-properties ("depends on", "works at",
  "proves"); types and an ontology are optional, when you need them.
- 📝 **Everything inside a thought.** A Markdown note with transclusions,
  attachments, properties and a chronicle — in one place.
- 🔍 **Search and views.** Across names, texts, links and the chronicle;
  complex conditions are saved as named views.
- 📅 **A diary that thoughts grow from.** Daily notes with entries linked to
  thoughts and thoughts created from entries.
- 📖 **Publications.** A coherent document with a table of contents assembled
  from scattered thoughts; export to Markdown/HTML/PDF.
- 🗂️ **Layers — branches for knowledge.** Rebuild the base in a separate
  layer: merge it if you like it, delete it without a trace if you do not.
- 👥 **Real-time collaboration.** People and agents edit one base at the same
  time — with authorship and locking.
- 🤖 **Memory for AI agents.** A built-in MCP server: agents walk the graph of
  links, append and link thoughts.

And all of it is self-hosted, under MIT, with no subscriptions.

Every capability in detail — in the
[user documentation](docs/userdocs/overview.md).

![demo-gif](docs/images/ETN-Основные%20экраны.gif)


## Quick start

From zero to a first thought network in a few minutes — no terminal and no
knowledge of servers.

### Windows — the simplest path

1. Download the installer `ETN-Setup-<version>.exe` from the
   [project releases](https://github.com/nerkuda/e-tho-net/releases) page (the
   latest version is at the top of the list) and run it.
2. Check the **server** and **client** components — the installer does the rest
   on its own: it installs Node.js and the Windows service and creates the
   first administrator.
3. Save the shown **initial API key**: it is displayed only once and is needed
   to connect to the server.
4. Open the ETN client and connect to the server at `http://127.0.0.1:4321`
   using the saved key.
5. Create the first thought network — and off you go: add thoughts, link them,
   keep a diary, share publications.

### Linux

The client is installed with one command, no sudo:

```bash
curl -fsSL https://github.com/nerkuda/e-tho-net/releases/latest/download/install.sh | bash
```

The server — from the distribution archive or as a Docker image: a couple of
commands from the [installation guide](docs/userdocs/install.md).

### macOS

There is no ready-made build — the client is built from source:
[installation guide](docs/userdocs/install.md).

Installation with an LLM agent, Docker, systemd, HTTPS, updates and backup —
[`docs/userdocs/install.md`](docs/userdocs/install.md): all commands,
environment variables and common errors are there.

## Installation

A quick overview of the options:

| Platform | Server | Client |
|---|---|---|
| Windows | `ETN-Setup-<version>.exe` — service + client in one package | same installer |
| Linux | `etn-server-<version>.tar.gz` (Node.js 22 required) or the Docker image `ghcr.io/nerkuda/e-tho-net/etn-server:v<version>` | `install.sh` in one command |
| macOS | from source | from source |

All builds are on the [project releases](https://github.com/nerkuda/e-tho-net/releases)
page; verify downloads against `SHA256SUMS`.

**Detailed instructions** — every installation route, updates (including the
server service right from the client), environment variables, backups and
recovery, HTTPS access — in
[`docs/userdocs/install.md`](docs/userdocs/install.md).

## Unsigned builds

Ready-made distributions and the ETN installer are not yet **signed** with a
developer certificate due to geopolitical problems. Windows and a self-built
macOS application may show warnings:

- **Windows:** SmartScreen — "Windows protected your PC" ("More info" →
  "Run anyway" is needed); in Windows 11 with Smart App Control enabled, launching
  an unsigned application may be blocked.
- **macOS:** there is no ready-made build in the release — the client is built from source; if
  you pass the built application to others, Gatekeeper may show
  "Apple cannot check it for malicious software"; on macOS 15 and newer the workaround
  is System Settings → Privacy & Security → Open Anyway.
- **Linux:** a signature is usually not required; verify the SHA-256 of the archives against
  `SHA256SUMS` from the release.

If in doubt, review the source code and build the distribution yourself
— instructions in [`docs/userdocs/install.md`](docs/userdocs/install.md).

## Status

Active feature development. Work planning and progress control are kept in the
maintainer's thought network. How this process works is described in
[`docs/development-in-etn.en.md`](docs/development-in-etn.en.md).

## Specifications and ADRs

Since version 0.6 all technical documentation has been kept in the maintainer's
thought network. Since version 0.12 the application generates documentation files in the
[`docs/`](docs/) directory. How development management and documentation generation
are organized on the basis of the thought network is described in
[`docs/development-in-etn.en.md`](docs/development-in-etn.en.md).

## User documentation

Since version 0.12 the application generates user documentation files in the
[`docs/userdocs`](docs/userdocs/) directory. Start with [`overview.md`](docs/userdocs/overview.md)


## Stack

- **Server:** Node.js 22 LTS (`.nvmrc`; better-sqlite3 has a ready prebuilt binary for it — Node 24 requires Python in PATH), TypeScript, Fastify, better-sqlite3, WebSocket.
- **Client:** Electron, TypeScript.
- **Storage:** SQLite — one `_system.db` + `networks/<id>/data.db` per network.
- **MCP:** `@modelcontextprotocol/sdk`.

## Monorepo structure

```
etn/
├── docs/      # specifications, ADRs and user documentation
├── server/    # server application + CLI (etn init)
├── client/    # Electron desktop client
├── shared/    # shared types (DTOs, constants, real-time protocols)
└── package.json
```

## Development

```bash
npm install              # install dependencies of all workspaces
npm run dev:server       # start the server in development mode
npm run dev:client       # start the client
npm run typecheck        # type-check all workspaces
npm test                 # all tests
```

## License

The project is distributed under the [MIT License](LICENSE).

## Built with AI

I single-handedly set the tasks and approve plans and specifications.
All project code, as well as the technical and user documentation, is fully
(100%!) written with the help of several LLMs and the desktop agentic development environment
[ZCode](https://zcode.z.ai). How this work is organized is told
in [`docs/development-in-etn.en.md`](docs/development-in-etn.en.md).


---

## Tech projects

- [ ] Mobile apps
- [ ] Access rights development
- [ ] Scripts for automating thought networks
- [ ] Concept maps
- [ ] Discussions and chats for users and agents
- [ ] User-defined appearance styles
- [ ] List/table/kanban view switcher
- [ ] To-do lists and thought reminders
- [ ] Localization into other languages
- [X] Localization into English
- [X] Server and client installer; updating the server service from the client
- [X] Out-of-type thought views
- [X] Out-of-type thought properties
- [X] Complex view and filter builder
- [X] Icon library
- [X] Markdown editor evolution (editing commands, transclusions)
- [X] Publications — living documents from a thought network (documentation generator)
- [X] Diary and evolution of chronological notes
- [X] Faster server queries
- [X] Unified design system
- [X] ETN MCP interface optimization
- [X] Shared knowledge graph across several thought networks
- [X] Link type filtering on the thought map
- [X] Properties and links: a single list and a single editor
- [X] Unified link model: typed edges as properties
- [X] Dynamic lists for thought types via views
- [X] Unified property handling
- [X] Change layers
- [X] Collaboration: authorship, locking and events
- [X] MCP tool revision
- [X] Development management via a thought network
- [X] Markdown editor with dynamic preview
- [X] Attachment management, icons
- [X] MVP (phases A-Q)
