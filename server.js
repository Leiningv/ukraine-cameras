const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 4173;
const DEVICE_ID = crypto.randomUUID();
const MEDIA_HOST = "mediaserver.border.gov.md";

const ECHERHA_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Client-Locale": "en",
  "X-User-Agent": "UABorder/3.9.0 Web/1.1.0 User/guest",
  "X-Device-Id": DEVICE_ID,
};

app.use(express.static(path.join(__dirname, "public")));

function withTimeout(ms) {
  return AbortSignal.timeout(ms);
}

function requestRaw(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: "GET",
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 502,
            contentType: res.headers["content-type"] || "",
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    const timer = setTimeout(() => req.destroy(new Error("Media request timed out")), timeoutMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on("timeout", () => req.destroy(new Error("Media request timed out")));
    req.on("close", () => clearTimeout(timer));
    req.end();
  });
}

async function echerhaWorkload(kind) {
  const res = await fetch(`https://back.echerha.gov.ua/api/v5/workload/${kind}`, {
    headers: ECHERHA_HEADERS,
    signal: withTimeout(20000),
  });
  if (!res.ok) throw new Error(`eCherha ${kind} returned ${res.status}`);
  return res.json();
}

app.get("/api/queues", async (_req, res) => {
  try {
    const [trucks, buses] = await Promise.all([
      echerhaWorkload(1),
      echerhaWorkload(2),
    ]);
    res.json({
      trucks: trucks.data || [],
      buses: buses.data || [],
      updatedAt: Date.now(),
    });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/hls-status", async (_req, res) => {
  const probe = `https://${MEDIA_HOST}:50793/hls/palanca_intrare/index.m3u8`;
  try {
    const upstream = await requestRaw(probe, 5000);
    const body = upstream.body.toString("utf8");
    res.json({
      ok: upstream.status >= 200 && upstream.status < 400 && body.includes("#EXTM3U"),
      status: upstream.status,
    });
  } catch (error) {
    res.json({ ok: false, error: error.message });
  }
});

app.get("/api/media", async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ""));
  } catch {
    res.status(400).end("Bad URL");
    return;
  }
  if (target.hostname !== MEDIA_HOST) {
    res.status(403).end("Host not allowed");
    return;
  }

  try {
    const upstream = await requestRaw(target.href);
    if (target.pathname.endsWith(".m3u8") || upstream.contentType.includes("mpegurl")) {
      const rewritten = upstream.body
        .toString("utf8")
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#")) {
            return line.replace(/URI="([^"]+)"/, (_, uri) => {
              const abs = new URL(uri, target).href;
              return `URI="/api/media?url=${encodeURIComponent(abs)}"`;
            });
          }
          const abs = new URL(trimmed, target).href;
          return `/api/media?url=${encodeURIComponent(abs)}`;
        })
        .join("\n");
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.send(rewritten);
      return;
    }

    res.status(upstream.status);
    res.set("Content-Type", upstream.contentType || "application/octet-stream");
    res.send(upstream.body);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, device: DEVICE_ID });
});

app.listen(PORT, () => {
  console.log(`Ukraine camera portal: http://localhost:${PORT}`);
});
