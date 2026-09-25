// Reference Tack plugin: registers one tool, `tack_echo`, with no runtime imports.
// Install:  tack plugin add ./examples/plugin-echo   (or a packed tarball)

export const name = "tack-echo";
export const inject = ["tools"];

const textObject = {
  type: "object",
  properties: { text: { type: "string", description: "Text to return." } },
  required: ["text"],
  additionalProperties: false,
};

export function apply(ctx) {
  ctx.tools.register({
    name: "tack_echo",
    description: "Return the given text unchanged.",
    parameters: textObject,
    output: {
      schema: textObject,
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args) {
      const text = args !== null && typeof args === "object" && typeof args.text === "string" ? args.text : "";
      return { text };
    },
  });
}
