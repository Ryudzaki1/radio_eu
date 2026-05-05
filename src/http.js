const fs = require("node:fs");

async function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

async function sendFile(request, response, filePath, contentType) {
  const stat = await fs.promises.stat(filePath);
  const range = request.headers.range;

  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", contentType);
  if (/^(text\/html|text\/css|text\/javascript)/.test(contentType)) {
    response.setHeader("Cache-Control", "no-store");
  }

  if (!range) {
    response.writeHead(200, { "Content-Length": stat.size });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
    return;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }

  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stat.size - 1;

  if (start >= stat.size || end >= stat.size || start > end) {
    response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
    response.end();
    return;
  }

  response.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`,
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  fs.createReadStream(filePath, { start, end }).pipe(response);
}

async function fetchJson(url, options, timeoutMs = 45_000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchJson, fetchWithTimeout, readJson, sendFile, sendJson };
