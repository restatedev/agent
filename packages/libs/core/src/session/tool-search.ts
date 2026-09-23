import MiniSearch from "minisearch";

import type {ToolManifest} from "../gateway/model.js";

export const TOOL_SEARCH_NAME = "searchTools";
const RESULT_LIMIT = 5;

function words(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_/.-]+/g, " ");
}

// Index schema field names, not examples/defaults or arbitrary schema values.
function parameterNames(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const object = schema as Record<string, unknown>;
  const result: string[] = [];
  if (object.properties && typeof object.properties === "object") {
    for (const [name, child] of Object.entries(object.properties)) {
      result.push(name, ...parameterNames(child));
    }
  }
  for (const keyword of ["items", "additionalProperties"])
    result.push(...parameterNames(object[keyword]));
  for (const keyword of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(object[keyword]))
      for (const child of object[keyword])
        result.push(...parameterNames(child));
  for (const keyword of ["$defs", "definitions"])
    if (object[keyword] && typeof object[keyword] === "object")
      for (const child of Object.values(object[keyword]))
        result.push(...parameterNames(child));
  return result;
}

/** Ephemeral, permission-filtered catalog. Only search selections are journaled. */
export function createToolSearch(
  catalog: ToolManifest[],
  providers: ReadonlyMap<string, string>,
) {
  const byName = new Map(catalog.map((tool) => [tool.name, tool]));
  let index: MiniSearch | undefined;
  const loaded = new Set<string>();
  return {
    loaded,
    search(query: string): string[] {
      // Build lazily: most turns that only use built-ins need no index at all.
      if (!index) {
        index = new MiniSearch({
          idField: "name",
          fields: ["toolName", "provider", "description", "parameters"],
          searchOptions: {
            boost: {toolName: 5, provider: 3, description: 1, parameters: 0.5},
            prefix: true,
          },
        });
        index.addAll(
          catalog
            .filter((tool) => tool.name !== TOOL_SEARCH_NAME)
            .map((tool) => ({
              name: tool.name,
              toolName: words(tool.name),
              provider: words(providers.get(tool.name) ?? "builtin"),
              description: words(tool.description.slice(0, 16_000)),
              parameters: words(
                parameterNames(tool.inputSchema).join(" ").slice(0, 8_000),
              ),
            })),
        );
      }
      const normalized = words(query.trim());
      // No fuzzy matching initially: misspellings should not bury exact terms.
      const matches = index.search(normalized);
      matches.sort(
        (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      const exact = catalog.find(
        (tool) => tool.name.toLowerCase() === query.trim().toLowerCase(),
      );
      return [
        ...new Set([
          ...(exact && exact.name !== TOOL_SEARCH_NAME ? [exact.name] : []),
          ...matches.map((match) => String(match.id)),
        ]),
      ].slice(0, RESULT_LIMIT);
    },
    load(names: string[]) {
      return names.flatMap((name) => {
        const tool = byName.get(name);
        if (!tool || name === TOOL_SEARCH_NAME) return [];
        loaded.add(name);
        return [{name, description: tool.description.slice(0, 400)}];
      });
    },
  };
}

export type TurnToolSearch = ReturnType<typeof createToolSearch>;
