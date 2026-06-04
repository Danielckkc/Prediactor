import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { fetchHttpAttempt } from "../src/http.js";

const execFileAsync = promisify(execFile);

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "lupin-http-"));
}

async function createFreshTlsCert(tempDir) {
  const keyPath = path.join(tempDir, "server-key.pem");
  const certPath = path.join(tempDir, "server-cert.pem");
  const configPath = path.join(tempDir, "openssl.cnf");
  const config = `
[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no

[req_distinguished_name]
CN = 127.0.0.1

[v3_req]
basicConstraints = critical,CA:TRUE
keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
IP.1 = 127.0.0.1
DNS.1 = localhost
`.trim();

  await fs.writeFile(configPath, config);

  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "7",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-config",
    configPath,
    "-extensions",
    "v3_req",
  ]);

  const [key, cert] = await Promise.all([
    fs.readFile(keyPath, "utf8"),
    fs.readFile(certPath, "utf8"),
  ]);

  return { key, cert };
}

test("http attempt keeps script and frame URLs for mitigation detection", async () => {
  const server = http.createServer((_, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
      <html>
        <head>
          <title>Protected Article</title>
          <script src="/challenge.js"></script>
        </head>
        <body>
          <iframe src="/frame.html"></iframe>
          <main>
            <h1>Protected Article</h1>
            <p>This page has enough visible text to exercise the HTTP extractor while still exposing
            provider markers through script and frame URLs for downstream mitigation detection.</p>
          </main>
        </body>
      </html>`);
  });

  await listen(server);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/article`;

  try {
    const result = await fetchHttpAttempt(url);
    assert.deepEqual(result.scriptUrls, [`http://127.0.0.1:${address.port}/challenge.js`]);
    assert.deepEqual(result.frameUrls, [`http://127.0.0.1:${address.port}/frame.html`]);
    assert.doesNotMatch(result.text, /challenge\.js/);
  } finally {
    await close(server);
  }
});

test("http attempt verifies HTTPS certificates by default", async () => {
  const tempDir = await makeTempDir();
  const { key, cert } = await createFreshTlsCert(tempDir);
  const server = https.createServer(
    {
      key,
      cert,
    },
    (_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><main>trusted content</main></body></html>");
    }
  );

  await listen(server);
  const address = server.address();
  const url = `https://127.0.0.1:${address.port}/secure`;

  try {
    await assert.rejects(
      () => fetchHttpAttempt(url, { timeout: 3000 }),
      (error) => {
        const details = `${error?.message || ""}\n${error?.cause?.message || ""}\n${error?.cause?.code || ""}`;
        assert.match(details, /self-signed|certificate|DEPTH_ZERO_SELF_SIGNED_CERT/i);
        return true;
      }
    );

    const result = await fetchHttpAttempt(url, {
      timeout: 3000,
      ignoreHttpsErrors: true,
    });
    assert.equal(result.status, 200);
    assert.match(result.text, /trusted content/i);
  } finally {
    await close(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("http attempt accepts an explicit CA bundle in strict mode", async () => {
  const tempDir = await makeTempDir();
  const caBundlePath = path.join(tempDir, "ca.pem");
  const { key, cert } = await createFreshTlsCert(tempDir);
  const server = https.createServer(
    {
      key,
      cert,
    },
    (_, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<html><body><main>trusted by custom ca</main></body></html>");
    }
  );

  await fs.writeFile(caBundlePath, cert);
  await listen(server);
  const address = server.address();
  const url = `https://127.0.0.1:${address.port}/secure`;

  try {
    const result = await fetchHttpAttempt(url, {
      timeout: 3000,
      caBundlePath,
    });
    assert.equal(result.status, 200);
    assert.match(result.text, /trusted by custom ca/i);
  } finally {
    await close(server);
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
