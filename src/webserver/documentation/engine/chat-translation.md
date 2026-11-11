---
title: Chat Translation
description: How chat lines are translated offline into each listener's language by the Frostfire Forge Language Service.
order: 85
---

A player who reads another language than the speaker gets each chat line in their own language. Translation runs offline on the game server's CPU with Frostfire Interactive's own translation model: no outside service, no API key and no settings or environment variables.

## How it works

The [Frostfire Forge Language Service](https://github.com/Frostfire-Interactive/Frostfire-Forge-Language-Service) is a git submodule at `src/language-service`. `src/systems/language.ts` imports it and calls it inside the engine's process, so there is no HTTP request. The service runs the model in a Python child process (`translator/serve.py`) and talks to it over stdin and stdout.

- The model starts loading when the server boots, so the first chat line does not wait for it.
- Each player's language comes from the client when it logs in, and is `en` when the client sends none.
- A line is translated once for each language its listeners read, all languages at the same time. Listeners who read the same language share one translation, and each listener gets the line as soon as their language is done.
- A listener who reads the speaker's language gets the line as typed.
- Item links are swapped for placeholders before translation and put back after, so they are never translated. A translation that lost a link is dropped and that listener gets the line as typed.
- In [Cluster Mode](#/engine/cluster), listeners on another node get the line as typed, because only their node knows their language.

## Languages

| Code | Language |
|------|----------|
| `en` | English |
| `es` | Spanish |
| `fr` | French |
| `pt` | Portuguese |
| `zh` or `cn` | Chinese |
| `hi` | Hindi |
| `ar` | Arabic |

A line from or to any other language is sent as typed, and so is a line longer than 500 characters, the same limit chat already has.

## Speed and memory

Measured in the engine's Docker image, CPU only:

| What | Value |
|------|-------|
| Model load | About 0.35 seconds |
| One line, model loaded | About 20 ms |
| One line into six languages | About as long as one: each language runs as its own batch, six at once, two CPU threads each |
| Translator memory | About 170 MB |

Requests for the same line that arrive within a few milliseconds of each other are merged into one.

## When the translator is missing or stops

The server never waits on translation to deliver chat. When Python or the translator's environment is missing, the server still starts and every line is sent as typed. A request that gets no answer within 10 seconds is sent as typed too. If the translator process stops, the next line starts it again, at most once every 5 seconds.

## Setup

The Docker images install Python and the translator's environment themselves, so there is nothing to do.

To run from source, the service's model files are stored with [Git LFS](https://git-lfs.com). Install Git LFS once, clone with the submodule, then create the translator's Python environment (Python 3) inside the submodule:

```bash title="Get the language service"
git lfs install
git clone --recurse-submodules https://github.com/Frostfire-Interactive/Frostfire-Forge.git
# In a checkout made without --recurse-submodules:
git submodule update --init
```

:::tabs
```powershell title="Windows"
cd src/language-service
python -m venv .venv
.venv/Scripts/python -m pip install -r translator/requirements.txt
```
```bash title="Linux and macOS"
cd src/language-service
python3 -m venv .venv
.venv/bin/python -m pip install -r translator/requirements.txt
```
:::

:::warning Clones made without Git LFS
Without Git LFS the model files are small text pointers instead of the model, and every line is sent as typed. Run `git lfs install`, then `git lfs pull` inside `src/language-service`.
:::

## Updating the model

New models ship as updates to the Language Service. Move the submodule to the newest version, then restart the server, which loads the model at boot:

```bash title="In Frostfire-Forge"
git submodule update --remote src/language-service
```
