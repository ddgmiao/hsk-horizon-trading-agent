import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

class Element {
  children: Element[] = [];
  get childNodes() { return this.children; }
  textContent = "";
  href = "";
  classList = {toggle() {}, remove() {}};

  constructor(readonly tag: string) {}
  addEventListener() {}
  append(...elements: Element[]) { this.children.push(...elements); }
  replaceChildren() { this.children = []; }
  insertCell() {
    const cell = new Element("td");
    this.append(cell);
    return cell;
  }
  descendants(tag: string): Element[] {
    return this.children.flatMap(e => [...(e.tag === tag ? [e] : []), ...e.descendants(tag)]);
  }
}

async function render(content: string) {
  const html = await readFile("dashboard/index.html", "utf8");
  const elements = new Map([...html.matchAll(/ id="(\w+)"/g)].map(([, id]) => [id, new Element(id)]));
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  // The last expression returns the initial refresh promise to the harness.
  await runInNewContext(script.replace("setInterval(refresh, 15000);", ""), {
    document: {
      getElementById: (id: string) => elements.get(id),
      createElement: (tag: string) => new Element(tag),
      createTextNode: (textContent: string) => Object.assign(new Element("text"), {textContent}),
    },
    fetch: async (path: string) => {
      assert.equal(path.split("?")[0], "/logs/decisions.jsonl");
      return new Response(content);
    },
  });
  return elements;
}

test("dashboard attaches the 17 published rows and all seven explorer links, with the portfolio in TT1", async () => {
  const elements = await render(await readFile("logs/decisions.jsonl", "utf8"));
  assert.equal(elements.get("rows")!.children.length, 17);
  assert.equal(elements.get("count")!.textContent, "17 records");
  assert.equal(elements.get("value")!.textContent, "0.171952583404081495 TT1");
  assert.equal(elements.get("trades")!.textContent, "2");
  const links = elements.get("rows")!.descendants("a");
  assert.equal(links.length, 7);
  assert.deepEqual(links.map(l => l.textContent).sort(), ["Approve", "Approve", "Decision", "Decision", "Swap", "Swap", "Wrap"]);
  for (const link of links) assert.match(link.href, /^https:\/\/testnet-explorer\.hskchain\.net\/tx\/0x[\da-f]{64}$/);
});

test("dashboard counts a mined bounds violation and excludes a reverted swap", async () => {
  const elements = await render(["swap_success_bounds_violation", "swap_reverted"].map(status =>
    JSON.stringify({execution: {status, swapTxHash: "0x" + "1".repeat(64)}})).join("\n"));
  assert.equal(elements.get("trades")!.textContent, "1");
});

test("dashboard shows an approval when the swap was blocked before submission", async () => {
  const hash = "0x" + "a".repeat(64);
  const elements = await render(JSON.stringify({execution: {status: "risk_blocked", approvalTxHash: hash, swapTxHash: null}}));
  const links = elements.get("rows")!.descendants("a");
  assert.deepEqual(links.map(l => [l.textContent, l.href]), [["Approve", "https://testnet-explorer.hskchain.net/tx/" + hash]]);
});
