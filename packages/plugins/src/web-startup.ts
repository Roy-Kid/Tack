/**
 * `tack web`'s command-line provider. Parses the web flags Tack forwards and
 * publishes them as the `webStartup` service the runtime's web rows inject.
 */
import { Command } from "commander";
import { parseAppArgs, processIo, type AppContext, type ProcessIo } from "./cmdline.js";

export const name = "tack-web-startup";
export const inject = ["cmdlineArgs", "appExit"];
export const WEB_STARTUP_SERVICE = "webStartup";

export interface WebStartup {
  openBrowser: boolean;
  host?: string;
  port?: number;
  trustedHosts: string[];
}

export function webCommand(): Command {
  return new Command()
    .name("tack web")
    .description("Serve the Tack browser UI.")
    .helpOption("-h, --help", "show this help")
    .option("--host <host>", "bind host")
    .option("--no-open", "do not open the browser UI")
    .option("--port <port>", "listen port; pass 0 to let the OS pick a free one")
    .option("--trusted-host <authority...>", "extra authority the browser-trust fence accepts (host or host:port; repeatable)")
    .addHelpText(
      "after",
      `
Examples:
  tack web                      serve on the composed host and port
  tack web --no-open            serve without opening a browser
  tack web --port 8080          serve on another port
`,
    );
}

export function apply(ctx: AppContext, _config?: unknown, io: ProcessIo = processIo): void {
  const program = webCommand();
  program.action(() => {
    const options = program.opts<{ open: boolean; host?: string; port?: string; trustedHost?: string[] }>();
    if (options.host === "0.0.0.0") {
      program.error("error: --host 0.0.0.0 is not supported: it would expose code execution to the network; use 127.0.0.1");
    }
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
    }
    const startup: WebStartup = {
      openBrowser: options.open,
      ...(options.host !== undefined && { host: options.host }),
      ...(options.port !== undefined && { port: Number(options.port) }),
      trustedHosts: options.trustedHost ?? [],
    };
    ctx.provide(WEB_STARTUP_SERVICE, startup);
  });
  parseAppArgs(ctx, program, io);
}
