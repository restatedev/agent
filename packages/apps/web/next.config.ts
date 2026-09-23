import type {NextConfig} from "next";
import {join} from "node:path";

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../../.."),
};

export default config;
