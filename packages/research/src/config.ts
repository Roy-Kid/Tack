/**
 * The `tack-research` row's config, validated once at apply time.
 */
import { z } from "zod";

const ResearchConfig = z
  .object({
    molab: z
      .object({
        /** Base URL of `molab serve`, rooted at the node this research is bound to. */
        url: z.url().default("http://localhost:8000"),
        /** Environment variable holding a molab bearer token, when the server runs with `--auth`. */
        tokenEnv: z.string().min(1).default("MOLAB_TOKEN"),
      })
      .prefault({}),
    /** How often waits are checked, in seconds. */
    pollSeconds: z.number().int().min(5).max(3600).default(30),
    /** Author recorded on every molab write. */
    createdBy: z.string().min(1).default("tack"),
    workers: z
      .object({
        /** Keep a worker session's file tools and shell arguments inside the served root (plus the temp directories and `allowedPaths`). */
        confine: z.boolean().default(true),
        /** Absolute path prefixes a confined worker may also use. */
        allowedPaths: z.array(z.string().min(1)).default([]),
      })
      .prefault({}),
    /**
     * The human gates: a person answers the uncertain parameters before the
     * plan, approves the plan before any worker is dispatched, approves the
     * workflow's dry run before anything executes, and approves the results
     * before a conclusion. Each is on unless switched off here.
     */
    gates: z
      .object({
        parameters: z.boolean().default(true),
        plan: z.boolean().default(true),
        dryRun: z.boolean().default(true),
        results: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type ResearchConfig = z.infer<typeof ResearchConfig>;
export type GatesConfig = ResearchConfig["gates"];

/** Validate a row config; the error names every bad field. */
export function parseConfig(raw: unknown): ResearchConfig {
  const parsed = ResearchConfig.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`tack-research: invalid config: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
