// AN S3 THE SERVER CAN BE POINTED AT, IN THE TEST'S OWN PROCESS. `s3.ts` honours `S3_ENDPOINT`
// (path-style, explicit creds: how it runs against Versity on the NAS), so booting the real
// `server.ts` against this runs the whole data path with no storage and no network beyond
// loopback. It speaks only what the server uses: HEAD bucket, GET/PUT object (with
// `If-None-Match: *`) and ListObjectsV2. `scripts/s3-conformance.mjs` is still what proves a
// REAL substrate honours those; this proves the server behaves given one that does.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const xmlError = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`;

const body = async (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

export interface FakeS3 {
  /** `http://127.0.0.1:<port>` */
  endpoint: string;
  /** key (without the bucket) → body */
  objects: Map<string, string>;
  /** While true every request answers 500, the way a dead store does. */
  down: boolean;
  close: () => Promise<void>;
}

export async function startFakeS3(bucket: string, pageSize = 1000): Promise<FakeS3> {
  const objects = new Map<string, string>();
  const fake: FakeS3 = {
    endpoint: "",
    objects,
    down: false,
    close: async () => {
      // replaced once the server is listening
    },
  };

  /** [status, body, content type] */
  type Answer = [number, string, string];
  const xml = (status: number, text = ""): Answer => [status, text, "application/xml"];

  const answer = (
    method: string,
    url: URL,
    ifNoneMatch: string | undefined,
    payload: string,
  ): Answer => {
    const key = decodeURIComponent(url.pathname.slice(`/${bucket}/`.length));
    if (fake.down) return xml(500, xmlError("InternalError"));
    if (url.pathname !== `/${bucket}` && url.pathname !== `/${bucket}/`) {
      if (method === "GET") {
        const hit = objects.get(key);
        return hit === undefined ? xml(404, xmlError("NoSuchKey")) : [200, hit, "application/json"];
      }
      if (method === "PUT") {
        if (ifNoneMatch === "*" && objects.has(key))
          return xml(412, xmlError("PreconditionFailed"));
        objects.set(key, payload);
        return xml(200);
      }
      return xml(405, xmlError("MethodNotAllowed"));
    }
    if (method === "HEAD") return xml(200);
    if (method !== "GET" || url.searchParams.get("list-type") !== "2")
      return xml(400, xmlError("InvalidRequest"));
    const prefix = url.searchParams.get("prefix") ?? "";
    const after = url.searchParams.get("continuation-token") ?? "";
    const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).toSorted();
    const page = keys.slice(0, pageSize);
    const more = keys.length > page.length;
    return xml(
      200,
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${bucket}</Name><Prefix>${prefix}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount><IsTruncated>${more}</IsTruncated>` +
        (more ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : "") +
        page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") +
        `</ListBucketResult>`,
    );
  };

  const respond = async (req: IncomingMessage, res: ServerResponse) => {
    const payload = await body(req);
    const [status, text, type] = answer(
      req.method ?? "GET",
      new URL(req.url ?? "/", "http://x"),
      req.headers["if-none-match"],
      payload,
    );
    res.writeHead(status, { "content-type": type });
    res.end(text);
  };

  const server: Server = createServer((req, res) => {
    respond(req, res).catch(() => {
      res.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  fake.endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = async () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  return fake;
}
