import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "docs", "assets", "demo.gif");
const arguments_ = process.argv.slice(2);
if (arguments_.some((argument) => argument !== "--check") || arguments_.length > 1) {
  throw new Error("Usage: node scripts/render-demo-gif.mjs [--check]");
}
const checkOnly = arguments_[0] === "--check";
const delays = [50, 100, 100, 75, 75, 100, 83, 117, 100, 100, 300];
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

const frames = [
  {
    step: 0,
    title: "Install. Connect. Inspect.",
    lines: [
      ["plain", "44 n8n tools for your AI client."],
      ["muted", "Community Edition · local stdio · no external AI"],
    ],
  },
  {
    step: 1,
    title: "Install the latest release",
    lines: [["code", "$ npm install --global n8n-mcp-community@latest"]],
  },
  {
    step: 1,
    title: "Next: connect",
    lines: [
      ["plain", "When npm finishes, add one command to your client."],
      ["muted", "Update later with the same install command."],
    ],
  },
  {
    step: 2,
    title: "Connect your MCP client",
    lines: [
      ["code", 'command: "n8n-mcp-community"'],
      ["code", 'mode:    "read-only"'],
    ],
  },
  {
    step: 2,
    title: "Connected",
    lines: [
      ["success", "✓ 44 tools · 5 resources · 4 prompts"],
      ["muted", "Read-only by default"],
    ],
  },
  {
    step: 3,
    title: "Ask your AI client",
    lines: [["plain", "“Check workflow wf_demo for hidden risks.”"]],
  },
  {
    step: 3,
    title: "Running n8n_introspect",
    lines: [
      ["code", "workflow: wf_demo"],
      ["code", "profile:  quick"],
    ],
  },
  {
    step: 3,
    title: "Local checks only",
    lines: [
      ["success", "✓ 23 deterministic rules"],
      ["plain", "0 workflow runs · 0 external AI calls"],
    ],
  },
  {
    step: 3,
    title: "One risk found",
    lines: [["warning", "MEDIUM · Retry may repeat an HTTP side effect"]],
  },
  {
    step: 3,
    title: "Why it matters",
    lines: [
      ["plain", "A POST request retries without an idempotency key."],
      ["muted", "The same external action may happen twice."],
    ],
  },
  {
    step: 3,
    title: "Clear next step",
    lines: [
      ["success", "Add an idempotency key or turn off retry."],
      ["muted", "No external AI calls. Check your MCP client’s data policy."],
    ],
  },
];

function escapeXml(value) {
  return String(value).replace(/[&<>"]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}

function renderAttributes(attributes) {
  return Object.entries(attributes)
    .map(([name, value]) => " " + name + '="' + escapeXml(value) + '"')
    .join("");
}

function renderElement(name, attributes, children = "") {
  return "<" + name + renderAttributes(attributes) + ">" + children + "</" + name + ">";
}

function renderEmptyElement(name, attributes) {
  return "<" + name + renderAttributes(attributes) + "/>";
}

function renderText(attributes, value) {
  return renderElement("text", attributes, escapeXml(value));
}

function renderSteps(activeStep) {
  return ["INSTALL", "CONNECT", "INSPECT"]
    .map((label, index) => {
      const step = index + 1;
      const active = activeStep === step;
      const complete = activeStep > step;
      const fill = active ? "#2563eb" : complete ? "#123d31" : "#151d30";
      const stroke = active ? "#60a5fa" : complete ? "#34d399" : "#334155";
      const text = active ? "#ffffff" : complete ? "#6ee7b7" : "#94a3b8";
      const x = 636 + index * 162;
      return (
        renderEmptyElement("rect", {
          x,
          y: 83,
          width: 140,
          height: 38,
          rx: 19,
          fill,
          stroke,
        }) +
        renderText(
          {
            x: x + 70,
            y: 108,
            "text-anchor": "middle",
            fill: text,
            "font-size": 17,
            "font-weight": 700,
          },
          step + " " + label,
        )
      );
    })
    .join("");
}

function renderFrame(frame) {
  const colors = {
    plain: "#e5edf8",
    code: "#93c5fd",
    success: "#6ee7b7",
    warning: "#fbbf24",
    muted: "#94a3b8",
  };
  const lines = frame.lines
    .map(([kind, value], index) => {
      const y = 314 + index * 68;
      const codeBox =
        kind === "code"
          ? renderEmptyElement("rect", {
              x: 100,
              y: y - 39,
              width: 1000,
              height: 56,
              rx: 10,
              fill: "#111a2d",
              stroke: "#26344f",
            })
          : "";
      return (
        codeBox +
        renderText(
          {
            x: 126,
            y,
            fill: colors[kind],
            "font-size": kind === "code" ? 27 : 29,
            "font-weight": kind === "success" || kind === "warning" ? 700 : 500,
          },
          value,
        )
      );
    })
    .join("");

  const children = [
    renderElement("style", {}, 'text { font-family: Menlo, "DejaVu Sans Mono", monospace; }'),
    renderEmptyElement("rect", { width: 1200, height: 675, fill: "#080d18" }),
    renderEmptyElement("rect", {
      x: 50,
      y: 40,
      width: 1100,
      height: 595,
      rx: 18,
      fill: "#0c1323",
      stroke: "#26344f",
      "stroke-width": 2,
    }),
    renderEmptyElement("rect", {
      x: 50,
      y: 40,
      width: 1100,
      height: 58,
      rx: 18,
      fill: "#111a2d",
    }),
    renderEmptyElement("rect", {
      x: 50,
      y: 80,
      width: 1100,
      height: 18,
      fill: "#111a2d",
    }),
    renderEmptyElement("circle", { cx: 84, cy: 69, r: 7, fill: "#fb7185" }),
    renderEmptyElement("circle", { cx: 108, cy: 69, r: 7, fill: "#fbbf24" }),
    renderEmptyElement("circle", { cx: 132, cy: 69, r: 7, fill: "#34d399" }),
    renderText(
      { x: 164, y: 77, fill: "#dbeafe", "font-size": 21, "font-weight": 700 },
      "n8n MCP Community",
    ),
    renderText(
      {
        x: 1092,
        y: 77,
        "text-anchor": "end",
        fill: "#64748b",
        "font-size": 17,
      },
      "MCP · stdio",
    ),
    renderSteps(frame.step),
    renderText(
      { x: 100, y: 225, fill: "#ffffff", "font-size": 42, "font-weight": 700 },
      frame.title,
    ),
    lines,
    renderEmptyElement("line", {
      x1: 100,
      y1: 555,
      x2: 1100,
      y2: 555,
      stroke: "#26344f",
    }),
    renderText(
      { x: 100, y: 592, fill: "#64748b", "font-size": 18 },
      "Synthetic demo · no real workflow data",
    ),
  ].join("");

  return renderElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: 1200,
      height: 675,
      viewBox: "0 0 1200 675",
    },
    children,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: Object.hasOwn(options, "encoding") ? options.encoding : "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    const detail = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

async function renderSvg(chrome, svgPath, pngPath, profilePath) {
  const child = spawn(
    chrome,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-device-scale-factor=1",
      "--window-size=1200,675",
      `--user-data-dir=${profilePath}`,
      `--screenshot=${pngPath}`,
      `file://${svgPath}`,
    ],
    { detached: process.platform !== "win32", stdio: "ignore" },
  );

  const deadline = Date.now() + 10_000;
  let lastSize = -1;
  try {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 75));
      try {
        const current = (await stat(pngPath)).size;
        if (current > 0 && current === lastSize) return;
        lastSize = current;
      } catch {
        // Wait until Chrome finishes the screenshot.
      }
    }
    throw new Error(`Chrome did not render ${path.basename(svgPath)} within 10 seconds.`);
  } finally {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
    } catch {
      // The renderer may have already exited.
    }
  }
}

if (frames.length !== delays.length) {
  throw new Error("Every demo frame must have one reviewed delay.");
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "n8n-mcp-demo-"));
try {
  let chrome;
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate);
      chrome = candidate;
      break;
    } catch {
      // Try the next known browser path.
    }
  }
  if (!chrome) {
    throw new Error("Chrome or Chromium is required to render the reviewed demo frames.");
  }
  const chromeVersion = run(chrome, ["--version"]).stdout.trim();
  const ffmpegVersion = run("ffmpeg", ["-version"]).stdout.split("\n", 1)[0].trim();
  const gifsicleVersion = run("gifsicle", ["--version"]).stdout.split("\n", 1)[0].trim();
  console.log(`Renderer: ${chromeVersion}; ${ffmpegVersion}; ${gifsicleVersion}`);

  const gifFrames = [];
  for (const [index, frame] of frames.entries()) {
    const stem = `frame-${String(index).padStart(2, "0")}`;
    const svgPath = path.join(temporaryRoot, `${stem}.svg`);
    const pngPath = path.join(temporaryRoot, `${stem}.png`);
    const gifPath = path.join(temporaryRoot, `${stem}.gif`);
    await writeFile(svgPath, renderFrame(frame));
    await renderSvg(chrome, svgPath, pngPath, path.join(temporaryRoot, `${stem}-profile`));
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", pngPath, gifPath]);
    gifFrames.push(gifPath);
  }

  const gifsicleArgs = ["--loopcount=0", "--colors=256", "--optimize=3"];
  for (const [index, gifPath] of gifFrames.entries()) {
    gifsicleArgs.push(`--delay=${delays[index]}`, gifPath);
  }
  const assembled = run("gifsicle", gifsicleArgs, { encoding: null });
  const temporaryOutput = path.join(temporaryRoot, "demo.gif");
  await writeFile(temporaryOutput, assembled.stdout);
  const rendered = await readFile(temporaryOutput);
  if (checkOnly) {
    const tracked = await readFile(output);
    if (!tracked.equals(rendered)) {
      throw new Error(
        "The tracked demo GIF differs from a fresh render. Run npm run demo:render only after reviewing every frame.",
      );
    }
    console.log(`Verified ${frames.length} reviewed frames (${rendered.length} bytes).`);
  } else {
    await rename(temporaryOutput, output);
    console.log(`Rendered ${frames.length} reviewed frames (${rendered.length} bytes).`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
