// A deliberately small markdown renderer for model output. Every source
// character is escaped before formatting tags are introduced, so model text
// cannot inject markup into the demonstration UI.

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineMarkdown(escaped: string) {
  const codes: string[] = [];
  let output = escaped.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\uE000${codes.length - 1}\uE001`;
  });
  output = output
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
  return output.replace(
    /\uE000(\d+)\uE001/g,
    (_, index: string) => `<code>${codes[Number(index)]}</code>`,
  );
}

const unorderedList = /^\s{0,3}[-*+]\s+/;
const orderedList = /^\s{0,3}\d+[.)]\s+/;
const heading = /^(#{1,4})\s+(.*)$/;

export function renderMarkdown(text: string) {
  const lines = text.split("\n");
  const html: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence) {
      const buffer: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        buffer.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      html.push(`<pre><code>${escapeHtml(buffer.join("\n"))}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    const headingMatch = line.match(heading);
    if (headingMatch) {
      const level = Math.min((headingMatch[1]?.length ?? 1) + 2, 6);
      html.push(
        `<h${level}>${inlineMarkdown(escapeHtml(headingMatch[2] ?? ""))}</h${level}>`,
      );
      index += 1;
      continue;
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const buffer: string[] = [];
      while (index < lines.length && /^\s{0,3}>\s?/.test(lines[index] ?? "")) {
        buffer.push((lines[index] ?? "").replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      html.push(
        `<blockquote>${renderMarkdown(buffer.join("\n"))}</blockquote>`,
      );
      continue;
    }
    if (unorderedList.test(line) || orderedList.test(line)) {
      const ordered = orderedList.test(line);
      const marker = ordered ? orderedList : unorderedList;
      const items: string[] = [];
      while (index < lines.length && marker.test(lines[index] ?? "")) {
        items.push((lines[index] ?? "").replace(marker, ""));
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(
        `<${tag}>${items
          .map((item) => `<li>${inlineMarkdown(escapeHtml(item))}</li>`)
          .join("")}</${tag}>`,
      );
      continue;
    }
    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      /^\s*\|?[\s:|-]+$/.test(lines[index + 1] ?? "") &&
      (lines[index + 1] ?? "").includes("-") &&
      (lines[index + 1] ?? "").includes("|")
    ) {
      const cells = (row: string) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => inlineMarkdown(escapeHtml(cell.trim())));
      const head = cells(line)
        .map((cell) => `<th>${cell}</th>`)
        .join("");
      index += 2;
      const body: string[] = [];
      while (
        index < lines.length &&
        (lines[index] ?? "").includes("|") &&
        (lines[index] ?? "").trim() !== ""
      ) {
        body.push(
          `<tr>${cells(lines[index] ?? "")
            .map((cell) => `<td>${cell}</td>`)
            .join("")}</tr>`,
        );
        index += 1;
      }
      html.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${body.join("")}</tbody></table>`,
      );
      continue;
    }

    const buffer = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? "").trim() !== "" &&
      !/^\s*```/.test(lines[index] ?? "") &&
      !heading.test(lines[index] ?? "") &&
      !unorderedList.test(lines[index] ?? "") &&
      !orderedList.test(lines[index] ?? "") &&
      !/^\s{0,3}>\s?/.test(lines[index] ?? "")
    ) {
      buffer.push(lines[index] ?? "");
      index += 1;
    }
    html.push(
      `<p>${buffer
        .map((paragraphLine) => inlineMarkdown(escapeHtml(paragraphLine)))
        .join("<br>")}</p>`,
    );
  }

  return html.join("");
}

export function renderInline(text: string) {
  return inlineMarkdown(escapeHtml(text));
}
