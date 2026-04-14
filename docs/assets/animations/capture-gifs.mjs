/**
 * capture-gifs.mjs — Records HTML animations as animated GIFs using Puppeteer + gif-encoder-2.
 *
 * Usage:
 *   node docs/assets/animations/capture-gifs.mjs
 *
 * Prerequisites:
 *   npm install --no-save puppeteer gif-encoder-2 png-js
 *
 * Output:
 *   docs/assets/oil-search-inspect.gif
 *   docs/assets/oil-safe-writes.gif
 *   docs/assets/oil-customer-workflows.gif
 *   docs/assets/oil-audit-log.gif
 */

import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import puppeteer from "puppeteer";
import GIFEncoder from "gif-encoder-2";
import { createCanvas, Image } from "canvas";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, "..");

const ANIMATIONS = [
  {
    html: "search-inspect.html",
    out: "oil-search-inspect.gif",
    duration: 11000,
    label: "Search & Inspect",
  },
  {
    html: "safe-writes.html",
    out: "oil-safe-writes.gif",
    duration: 12000,
    label: "Safe Writes",
  },
  {
    html: "customer-workflows.html",
    out: "oil-customer-workflows.gif",
    duration: 12000,
    label: "Customer Workflows",
  },
  {
    html: "audit-log.html",
    out: "oil-audit-log.gif",
    duration: 12000,
    label: "Audit & Observability",
  },
];

const WIDTH = 800;
const HEIGHT = 450;
const FPS = 12;   // 12 fps is plenty for UI animations
const FRAME_INTERVAL = Math.round(1000 / FPS);

async function captureAnimation(browser, animDef) {
  const { html, out, duration, label } = animDef;
  const htmlPath = join(__dirname, html);
  const outPath = join(ASSETS_DIR, out);

  console.log(`  ⏺  Capturing: ${label} (${duration}ms @ ${FPS}fps)…`);

  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 2 });

  // Load the HTML file
  const htmlUrl = `file://${htmlPath}`;
  await page.goto(htmlUrl, { waitUntil: "domcontentloaded" });

  // Set up GIF encoder
  const encoder = new GIFEncoder(WIDTH * 2, HEIGHT * 2, "neuquant", true);
  encoder.setDelay(FRAME_INTERVAL);
  encoder.setRepeat(0); // loop forever
  encoder.setQuality(10);
  encoder.start();

  const totalFrames = Math.ceil(duration / FRAME_INTERVAL);

  for (let i = 0; i < totalFrames; i++) {
    const screenshot = await page.screenshot({
      type: "png",
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });

    // Decode PNG and add frame to GIF
    const img = new Image();
    img.src = screenshot;
    const canvas = createCanvas(WIDTH * 2, HEIGHT * 2);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    encoder.addFrame(ctx);

    // Wait for next frame
    await page.evaluate(
      (ms) => new Promise((r) => setTimeout(r, ms)),
      FRAME_INTERVAL
    );

    // Progress indicator every 10 frames
    if (i % 10 === 0) {
      process.stdout.write(`\r    Frame ${i + 1}/${totalFrames}`);
    }
  }

  encoder.finish();
  const buffer = encoder.out.getData();
  await writeFile(outPath, buffer);

  console.log(`\r    ✓ ${totalFrames} frames → ${out} (${(buffer.length / 1024).toFixed(0)}KB)`);
  await page.close();
}

async function main() {
  console.log("🎬 OIL Animation → GIF Capture\n");
  console.log(`  Resolution: ${WIDTH}×${HEIGHT} @2x`);
  console.log(`  Frame rate: ${FPS} fps\n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  for (const anim of ANIMATIONS) {
    await captureAnimation(browser, anim);
  }

  await browser.close();
  console.log("\n✅ All GIFs generated in docs/assets/");
}

main().catch((err) => {
  console.error("❌ Capture failed:", err);
  process.exit(1);
});
