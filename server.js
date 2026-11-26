// PULL backend: Express + yt-dlp. Run: node server.js
const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

const ALLOWED = /^https?:\/\/([a-z0-9-]+\.)?(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|pinterest\.[a-z.]+|pin\.it)\//i;

const FORMATS = {
  "MP4 1080p": ["-f", "b[height<=1080][ext=mp4]/b[height<=1080]/b"],
  "MP4 720p": ["-f", "b[height<=720][ext=mp4]/b[height<=720]/b"],
  "MP3": ["-x", "--audio-format", "mp3"],
  "Thumbnail": ["--skip-download", "--write-thumbnail", "--convert-thumbnails", "jpg"],
};

// simple in-memory rate limit: 20 requests per 10 minutes per IP
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 600000);
  list.push(now);
  hits.set(ip, list);
  return list.length > 20;
}

function validUrl(u) {
  return typeof u === "string" && u.length < 500 && ALLOWED.test(u);
}

function ytdlp(args) {
  return spawn("yt-dlp", ["--no-playlist", "--no-warnings", "--max-filesize", "500M", ...args]);
}

app.get("/api/info", (req, res) => {
  const url = req.query.url;
  if (!validUrl(url)) return res.status(400).json({ error: "Unsupported or invalid link" });
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests" });
  let out = "";
  const p = ytdlp(["--dump-json", "--", url]);
  p.stdout.on("data", (d) => (out += d));
  p.on("close", (code) => {
    if (code !== 0) return res.status(422).json({ error: "Could not read this video" });
    try {
      const j = JSON.parse(out);
      res.json({ title: j.title, thumbnail: j.thumbnail, duration: j.duration, uploader: j.uploader });
    } catch (e) {
      res.status(500).json({ error: "Bad response" });
    }
  });
});

app.get("/api/download", (req, res) => {
  const { url, format } = req.query;
  if (!validUrl(url) || !FORMATS[format]) return res.status(400).json({ error: "Invalid request" });
  if (limited(req.ip)) return res.status(429).json({ error: "Too many requests" });

  const dir = path.join(os.tmpdir(), "pull-" + crypto.randomBytes(8).toString("hex"));
  fs.mkdirSync(dir);
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});

  const p = ytdlp([...FORMATS[format], "-o", path.join(dir, "%(id)s.%(ext)s"), "--", url]);
  p.on("close", (code) => {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (code !== 0 || !files.length) {
      cleanup();
      return res.status(422).json({ error: "Download failed" });
    }
    res.download(path.join(dir, files[0]), files[0], cleanup);
  });
  req.on("close", () => p.kill());
});

app.get("/", (_req, res) => res.send("PULL backend running"));
app.listen(process.env.PORT || 3000);
