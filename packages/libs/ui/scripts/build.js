import {mkdir, readFile, writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {dirname, extname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "index.html");
const outputDirectory = join(root, "dist");

async function compile() {
  const source = await readFile(sourcePath, "utf8");
  const match = source.match(
    /<script type="module">\s*([\s\S]*?)\s*<\/script>/,
  );
  if (!match) {
    throw new Error("index.html must contain one inline module script");
  }

  await mkdir(outputDirectory, {recursive: true});
  await build({
    stdin: {
      contents: match[1],
      loader: "ts",
      resolveDir: root,
      sourcefile: "ui.ts",
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: !process.argv.includes("--serve"),
    sourcemap: true,
    outfile: join(outputDirectory, "app.js"),
  });
  await writeFile(
    join(outputDirectory, "index.html"),
    source.replace(match[0], '<script type="module" src="./app.js"></script>'),
  );
}

await compile();

if (process.argv.includes("--serve")) {
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".map": "application/json",
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(
      request.url ?? "/",
      "http://127.0.0.1",
    ).pathname;
    const fileName =
      pathname === "/"
        ? "index.html"
        : ["/app.js", "/app.js.map"].includes(pathname)
          ? pathname.slice(1)
          : undefined;
    if (!fileName) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    try {
      const file = join(outputDirectory, fileName);
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
  server.listen(3000, "127.0.0.1", () => {
    console.log("Demo UI: http://127.0.0.1:3000");
  });
}
