/** @type {import('next').NextConfig} */
export default {
  // Workspace packages ship TypeScript-compiled ESM that Next must run through
  // its own pipeline. Provider adapters are deliberately absent: nothing here
  // may pull an LLM SDK into a browser bundle.
  transpilePackages: [
    "@sketchmind/shared-types",
    "@sketchmind/session-protocol",
    "@sketchmind/renderer-core",
    "@sketchmind/renderer-konva"
  ]
};
