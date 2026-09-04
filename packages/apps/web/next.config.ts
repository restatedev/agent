import type {NextConfig} from "next";
import {join} from "node:path";

const config: NextConfig = {
  allowedDevOrigins: ["*.ngrok-free.app"],
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../../.."),
};

export default config;
