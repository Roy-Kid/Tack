# Tack

Tack is a general-purpose agent harness. Its current runtime is
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), pinned to an
exact version and used only through Tack's own CLI.

## Install

```sh
npm install
npm run build
npm link -w tack        # or: node packages/tack/lib/bin.js ...
```

Requires Node 22.12 or newer.

## Usage

```sh
tack                     # help
tack run "task"          # answer one task and exit (`-` reads stdin)
tack web                 # serve the browser UI
tack version             # Tack, runtime, and patch versions
tack doctor              # runtime, home, and profile state
tack doctor --dump-config
```

Tack flags (`--profile`, `--patch`) come first; the first unrecognised token
starts the app's own arguments, which are forwarded verbatim
(`tack run --help`, `tack web --port 0 --no-open`).

## Environment

| Variable | Meaning |
| --- | --- |
| `TACK_HOME` | Tack home; profiles, sessions, and settings live here. Default `~/.tack`. |
| `DEEPSEEK_API_KEY` | Model provider key. |
| `DEEPSEEK_BASE_URL` | Optional provider base URL. |
| `DSH_TELEMETRY_DISABLED` | Any non-empty value disables runtime telemetry. |

A `.env` file in the working directory or in `$TACK_HOME` is also read.
