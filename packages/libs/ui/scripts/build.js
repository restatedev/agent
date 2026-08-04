import {copyFile, mkdir, readFile} from "node:fs/promises";
import {createServer} from "node:http";
import {dirname, extname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDirectory = join(root, "dist");

async function compile() {
  await mkdir(outputDirectory, {recursive: true});
  await build({
    entryPoints: [join(root, "src/main.tsx")],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: !process.argv.includes("--serve"),
    sourcemap: true,
    outfile: join(outputDirectory, "app.js"),
  });
  await copyFile(join(root, "index.html"), join(outputDirectory, "index.html"));
}

await compile();

if (process.argv.includes("--serve")) {
  const port = Number(process.env.UI_PORT ?? 3000);
  const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".map": "application/json",
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).pathname;
    const fileName = pathname === "/" ? "index.html" : pathname.slice(1);
    const allowed = new Set(["index.html", "app.js", "app.js.map", "app.css", "app.css.map"]);
    if (!allowed.has(fileName)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    try {
      const file =
        fileName === "index.html" ? join(root, "index.html") : join(outputDirectory, fileName);
      response.setHeader(
        "content-type",
        contentTypes[extname(file)] ?? "application/octet-stream",
      );
      response.end(await readFile(file));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Demo UI: http://127.0.0.1:${port}`);
  });
}
