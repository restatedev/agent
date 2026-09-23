import type {NextConfig} from "next";
import {join} from "node:path";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../../.."),
  // TypeScript 7 (native) has no JS compiler API; type-check via its CLI.
  experimental: {useTypeScriptCli: true},
};

export default config;
