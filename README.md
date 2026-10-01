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
tack doctor --tools      # tools registered in a profile

tack model                               # default model of each profile
tack model list [--provider <id>]        # providers and their models
tack model use <provider>/<model>        # switch the default (every profile)
tack provider add anthropic --api-key-env ANTHROPIC_API_KEY
tack provider add gw --api openai-completions --base-url https://gw/v1 --model m
printf %s "$KEY" | tack auth set ANTHROPIC_API_KEY
tack run --model openai/gpt-5 "task"     # another model for one run

tack plugin add <package|tarball|path>   # install into the default profile
tack plugin list | enable | disable | remove
tack plugin add <package> --profile web  # plugins for browser sessions
```

Tack flags (`--profile`, `--patch`, `--model` for `run`, `--chrome` and `--check` for `web`) come first; the first unrecognised token
starts the app's own arguments, which are forwarded verbatim
(`tack run --help`, `tack web --port 0 --no-open`).

## Plugins

A Tack plugin is an npm package that declares a bundle layer and, optionally,
the Tack versions it supports:

```json
{
  "keywords": ["tack-plugin"],
  "tack": { "compat": ">=0.2.0 <1.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`examples/plugin-echo` is a complete one-tool plugin. Tack bundles its own
package manager for plugin installs; nothing else needs to be on `PATH`.

## Web chrome

`tack web` can be re-skinned as another product without code changes: its
name, logo, favicon, splash, welcome notice, and colors come from one JSON
file plus the product's own Tailwind 4 theme.

```sh
tack web --chrome chrome.json --check   # validate; print settings and compiled theme
tack web --chrome chrome.json           # serve with them
```

Without `--chrome`, `$TACK_HOME/web-chrome.json` is used when present. Paths
are relative to the file. Every key is optional, and an unknown key is an error.

| Key | Default | Meaning |
| --- | --- | --- |
| `product.name`, `product.shortName` | `Tack` | Title, sidebar, manifest |
| `product.titleSeparator` | `" — "` | Between the session name and the product in the tab title |
| `brand.logo`, `brand.logoDark` | Tack mark | Sidebar and hero mark (SVG, PNG, WebP, …) |
| `brand.favicon`, `brand.faviconDark` | the logo | Tab icons |
| `theme.css` | none | Tailwind 4 theme file (`@theme`, `:root`, `.dark`) |
| `theme.customCss` | none | Any CSS, appended verbatim |
| `theme.appearance` | `system` | Default `light`, `dark`, or `system`. A choice the user saves in settings wins. |
| `splash.wordmark`, `splash.hint` | name, `Loading…` | Boot screen text |
| `welcome.enabled`, `.title`, `.body` | off | First-run notice, shown once per text |
| `version.show` | `true` | Version row in settings |
| `onboarding.credentialPrompt` | `true` | Ask for an API key on first run |

The theme is read the way Tailwind 4 and shadcn/ui write it. `--color-background`,
`foreground`, `card`, `popover`, `primary`, `muted`, `accent`, `border`,
`input`, `ring`, `destructive`, `success`, `warning`, `sidebar`, `--font-sans`/`mono`/`heading`,
`--radius`, and `--shadow-sm`/`md`/`lg` are mapped onto the runtime's tokens.
Values stay as written (`oklch()`, `var()`). `examples/web-chrome` is a complete
integration.

## Runtime updates

The runtime is pinned to one exact version. A scheduled workflow
(`.github/workflows/runtime-update.yml`) watches for new releases, re-pins,
runs the full suite, and opens a pull request that reports the result. Run it
by hand from the Actions tab, optionally with an exact version, or locally
(Node 22.18 or newer runs the TypeScript script directly):

```sh
node scripts/runtime-update.ts check            # current vs newest `next` release
node scripts/runtime-update.ts apply <version>  # then: npm install
node scripts/runtime-closure.ts diff            # every runtime package reviewed?
```

Every runtime package Tack installs is reviewed in `packages/tack/runtime-closure.json`
(source group, class, and decision: use, compose, wrap, disable, or forbidden).
A new upstream package fails verification until it is classified.

## Environment

| Variable | Meaning |
| --- | --- |
| `TACK_HOME` | Tack home; profiles, sessions, and settings live here. Default `~/.tack`. |
| `DEEPSEEK_API_KEY` | Key for the default provider (DeepSeek). Other providers use their own names, e.g. `ANTHROPIC_API_KEY`; `tack auth set` stores them in `$TACK_HOME`. |
| `DEEPSEEK_BASE_URL` | Optional provider base URL. |

A `.env` file in the working directory or in `$TACK_HOME` is also read.
