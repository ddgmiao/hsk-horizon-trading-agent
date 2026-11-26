import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {createServer} from "node:http";
import {extname, resolve, sep} from "node:path";

const root = resolve(".");
const routes = new Map([
  ["/", resolve(root, "dashboard/index.html")],
  ["/index.html", resolve(root, "dashboard/index.html")],
  ["/logs/decisions.jsonl", resolve(root, "logs/decisions.jsonl")],
]);
const types = {".html": "text/html; charset=utf-8", ".jsonl": "application/x-ndjson; charset=utf-8"};

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || "/", "http://localhost").pathname;
  const path = routes.get(pathname);
  if (!path || !path.startsWith(root + sep)) {
    response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
    response.end("Not found");
    return;
  }
  try {
    await stat(path);
    response.writeHead(200, {
      "content-type": types[extname(path)] || "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    createReadStream(path).pipe(response);
  } catch {
    if (pathname === "/logs/decisions.jsonl") {
      response.writeHead(200, {"content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store"});
      response.end("");
      return;
    }
    response.writeHead(500, {"content-type": "text/plain; charset=utf-8"});
    response.end("Dashboard asset could not be read");
  }
});

const port = Number(process.env.PORT || 4173);
server.listen(port, "127.0.0.1", () => console.log(`Horizon dashboard: http://127.0.0.1:${port}`));
