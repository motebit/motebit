/**
 * Hand-written, plausible model answers with NO real internal block: code
 * (C/C++ includes, generics, JSX/HTML/XML/SVG, templates, shell), math,
 * tables, lists, JSON, CRLF, and prose or code that merely MENTIONS the
 * words memory / thinking / state / parameter. origin/main's tag chains
 * leave every one of them intact, so every display path must too.
 */
export const REALISTIC_ANSWERS: readonly string[] = [
  "Use a smart pointer:\n\n```cpp\n#include <memory>\n#include <vector>\n\nint main() {\n  auto p = std::make_unique<int>(4);\n  std::vector<int> v{1, 2, 3};\n}\n```\n\nThat frees the int when `p` goes out of scope.",
  '```c\n#include <stdio.h>\n#include <stdlib.h>\n\nint main(void) { printf("hi\\n"); return 0; }\n```\n\nCompile with `gcc main.c`.',
  "Include `<memory>` for `std::shared_ptr` and `<thread>` for `std::thread`. Both live in the standard library.",
  "```cpp\n#include <memory>\nstd::shared_ptr<Widget> w = std::make_shared<Widget>();\n```\nThe control block is allocated once.",
  'A JasperReports sample:\n\n```xml\n<jasperReport name="r">\n  <parameter name="T" class="java.lang.String"/>\n  <queryString>select 1</queryString>\n</jasperReport>\n```\n\nPass `T` at fill time.',
  '```xml\n<parameters>\n  <parameter name="limit" class="java.lang.Integer"/>\n</parameters>\n```\n\nThe wrapper groups them.',
  'In XML-RPC a value looks like `<parameter name="x">5</parameter>` — here is a full one:\n\n```xml\n<parameter name="x">5</parameter>\n```\n\nDone.',
  'In Java: `Map<String, List<Integer>> m = new HashMap<>();` then `m.put("a", List.of(1));`.',
  "```ts\nfunction first<T>(xs: Array<T>): T | undefined {\n  return xs[0];\n}\nconst cache: Map<K, V> = new Map();\n```\n\nGenerics keep it typed.",
  '```tsx\nexport function Card({ title }: { title: string }) {\n  return (\n    <div className="card">\n      <h2>{title}</h2>\n    </div>\n  );\n}\n```',
  "```html\n<!doctype html>\n<html>\n  <body>\n    <p>Hello <b>world</b></p>\n  </body>\n</html>\n```\n\nSave as `index.html`.",
  '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">\n  <circle cx="5" cy="5" r="4"/>\n</svg>\n```',
  "Jinja:\n\n```jinja\n{% for item in items %}\n  <li>{{ item.name }}</li>\n{% endfor %}\n```",
  "Handlebars: `{{#each people}}<li>{{this}}</li>{{/each}}` renders a list.",
  "Redirect both ways: `sort < in.txt > out.txt`. Or `a < b > c` in some shells.",
  "If x < y and y > z then nothing follows about x and z.",
  "Compute 2*3*4 = 24, and 5*6 = 30. Then a*b*c is the product.",
  "| Tag | Meaning |\n| --- | --- |\n| `<memory>` | C++ header |\n| `<vector>` | dynamic array |\n\nBoth are standard.",
  "1. Install\n   - run `npm i`\n   - check `node -v`\n2. Build\n   1. `pnpm build`\n   2. `pnpm test`",
  '```json\n{\n  "memory": 512,\n  "thinking": false,\n  "state": "idle"\n}\n```',
  "Line one\r\nLine two with <memory> mention\r\nLine three\r\n",
  "My memory of the thinking process is that state matters. **Memory** is cheap; *thinking* is not.",
  "Call `thinking()` then `memory.read()`; a `<thinkingCap>` or `<memoryCard/>` element is just JSX.",
  "Python generics: `def f(x: list[int]) -> dict[str, int]:` and the `<lambda>` repr.",
  "```rust\nuse std::collections::HashMap;\nfn main() { let m: HashMap<String, Vec<u8>> = HashMap::new(); }\n```",
  "```go\nfunc Map[T, U any](xs []T, f func(T) U) []U { return nil }\n```\nGo 1.18+.",
  "> Note: `<state>` here is the React state, not anything special.\n\nSee the docs.",
  'Use `<input type="text">` and `<br>` tags. The `<memory>` element does not exist in HTML.',
  "```bash\ncat <<EOF > config.ini\n[section]\nkey=value\nEOF\n```",
  "```cpp\ntemplate <typename T>\nclass Stack {\n  std::vector<T> data;\n};\n```\nNote the `<typename T>`.",
  "Markdown list with emphasis:\n\n- **bold** item\n- *italic phrase here* item\n- `code<T>` item",
  "Keyboard: press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy.",
  "<details>\n<summary>Click</summary>\n\nHidden text.\n\n</details>",
  'XML namespaces: `<ns:memory xmlns:ns="urn:x">v</ns:memory>` is fine.',
  "```xml\n<memory>\n  <size>512</size>\n</memory>\n```\n\nThat config sets memory to 512.",
  "A thinking emoji 🤔 and the word state in **State management** headings.\n\n## State\n\nText.",
  "Escape `<` as `&lt;` and `>` as `&gt;` in HTML: `a &lt; b`.",
  'Vue: `<template><div v-if="state.ready">{{ memory }}</div></template>`.',
  "```kotlin\nval m: Map<String, List<Int>> = mapOf()\n```",
  "In C#: `List<Dictionary<string, int>> rows = new();` works in C# 9.",
  "Arrow functions: `const f = (a) => a > 0 ? a : -a;`",
  "```diff\n- old <memory> include\n+ #include <memory>\n```",
  "Results:\n\n| n | n*n |\n|---|-----|\n| 2 | 4 |\n| 3 | 9 |",
  "Brackets are fine: [link](https://example.com) and [x] checkboxes:\n\n- [x] done\n- [ ] todo",
  "The `<parameter>` element in XML-RPC holds one value. Also `<param>` in some dialects.",
];

/** Real trailing internal blocks every path still hides. */
export const TRAILING_INTERNAL: readonly string[] = [
  '\n<state curiosity="0.8" warmth="0.5"/>',
  '\n<memory confidence="0.9" sensitivity="none">SECRET_MEM</memory>',
];
