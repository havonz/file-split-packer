import { createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./App.css";
import mergePartsLua from "../xxtouch/merge_parts.lua?raw";

type ProgressPayload = {
  phase: string;
  processedBytes: number;
  totalBytes: number;
  partIndex: number;
  partTotal: number;
  message: string;
};

type SplitResult = {
  parts: number;
  outputFiles: string[];
  isDir: boolean;
  baseName: string;
};

const unitToBytes = (value: number, unit: string) => {
  const base =
    unit === "B"
      ? 1
      : unit === "KB"
      ? 1024
      : unit === "MB"
      ? 1024 * 1024
      : 1024 * 1024 * 1024;
  return Math.max(1, Math.round(value * base));
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes)) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unitIndex]}`;
};

const extractDir = (path: string) => {
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slashIndex === -1 ? "" : path.slice(0, slashIndex);
};

const extractName = (path: string) => {
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slashIndex === -1 ? path : path.slice(slashIndex + 1);
};

const normalizePath = (path: string) => path.replace(/\\/g, "/");

const toRelative = (fullPath: string, baseDir: string) => {
  const full = normalizePath(fullPath);
  const base = normalizePath(baseDir).replace(/\/+$/, "");
  if (full.startsWith(base + "/")) {
    return full.slice(base.length + 1);
  }
  return extractName(fullPath);
};

const escapeLuaString = (value: string) =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

function App() {
  const buildTag = import.meta.env.VITE_BUILD_TAG || "dev";
  const [inputPath, setInputPath] = createSignal("");
  const [outputDir, setOutputDir] = createSignal("");
  const [splitBy, setSplitBy] = createSignal<"size" | "count">("size");
  const [sizeValue, setSizeValue] = createSignal(95);
  const [sizeUnit, setSizeUnit] = createSignal("MB");
  const [countValue, setCountValue] = createSignal(4);
  const [password, setPassword] = createSignal("");
  const [packMode, setPackMode] = createSignal<
    "split-then-zip" | "zip-then-split"
  >("split-then-zip");
  const [dirSplitMode, setDirSplitMode] = createSignal<
    "compress-split-store" | "store-split-compress"
  >("compress-split-store");
  const [running, setRunning] = createSignal(false);
  const [progress, setProgress] = createSignal<ProgressPayload | null>(null);
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [outputFiles, setOutputFiles] = createSignal<string[]>([]);
  const [luaSnippet, setLuaSnippet] = createSignal("");
  const [copyHint, setCopyHint] = createSignal("");
  const [openHint, setOpenHint] = createSignal("");

  onMount(async () => {
    const unlisten = await listen<ProgressPayload>(
      "split-progress",
      (event) => {
        setProgress(event.payload);
      }
    );
    const unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const path = event.payload.paths?.[0];
      if (!path) return;
      setInputPath(path);
      if (!outputDir()) {
        setOutputDir(extractDir(path));
      }
    });
    onCleanup(() => {
      unlisten();
      unlistenDrop();
    });
  });

  const chooseInput = async () => {
    const selected = await openDialog({ multiple: false, directory: false });
    if (!selected || Array.isArray(selected)) return;
    setInputPath(selected);
    if (!outputDir()) {
      setOutputDir(extractDir(selected));
    }
  };

  const handleFileDrop = (event: DragEvent) => {
    event.preventDefault();
    const list = event.dataTransfer?.files;
    if (!list || list.length === 0) return;
    const file = list[0];
    if (!file?.path) return;
    setInputPath(file.path);
    if (!outputDir()) {
      setOutputDir(extractDir(file.path));
    }
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
  };

  const chooseOutput = async () => {
    const selected = await openDialog({ multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    setOutputDir(selected);
  };

  const startProcess = async () => {
    setError("");
    setSuccess("");
    setOutputFiles([]);
    setLuaSnippet("");
    setCopyHint("");
    setOpenHint("");

    if (!inputPath()) {
      setError("请先选择输入文件");
      return;
    }
    const resolvedOutput = outputDir() || extractDir(inputPath());
    if (!resolvedOutput) {
      setError("请指定输出目录");
      return;
    }
    setOutputDir(resolvedOutput);

    if (splitBy() === "size" && sizeValue() <= 0) {
      setError("每份大小必须大于 0");
      return;
    }
    if (splitBy() === "size" && sizeUnit() === "B" && sizeValue() < 1024) {
      setError("Bytes 模式下每份大小不得小于 1024");
      return;
    }
    if (splitBy() === "count" && countValue() <= 0) {
      setError("份数必须大于 0");
      return;
    }

    const payload = {
      inputPath: inputPath(),
      outputDir: resolvedOutput,
      splitBy: splitBy(),
        sizeBytes:
          splitBy() === "size"
            ? unitToBytes(sizeValue(), sizeUnit())
            : undefined,
        count: splitBy() === "count" ? countValue() : undefined,
        packMode: packMode(),
        dirSplitMode: dirSplitMode(),
        password: password().trim() ? password().trim() : undefined,
      };

    try {
      setRunning(true);
      const result = await invoke<SplitResult>("process_file", {
        options: payload,
      });
      setOutputFiles(result.outputFiles);
      const baseName = result.baseName || extractName(inputPath());
      const fileList = result.outputFiles.map((filePath) => {
        const relative = toRelative(filePath, resolvedOutput);
        return `      XXT_SCRIPTS_PATH.."/${escapeLuaString(relative)}",`;
      });
      const passwordValue = password().trim();
      const outputName = result.isDir ? `${baseName}.zip` : baseName;
      const outputFileLine = `  output_file = XXT_SCRIPTS_PATH.."/${escapeLuaString(outputName)}",`;
      const scriptLines = [
        'local merge_parts = require("merge_parts")',
        "",
        `-- ${packMode() === "split-then-zip" ? "split-then-zip" : "zip-then-split"}`,
        "local ok, out = merge_parts.restore({",
        `  mode = "${packMode()}",`,
        "  file_list = {",
        ...fileList,
        "  },",
        outputFileLine,
      ];
      if (passwordValue) {
        scriptLines.push(`  password = "${escapeLuaString(passwordValue)}",`);
      }
      scriptLines.push("})");
      if (result.isDir) {
        const unzipTarget = `XXT_SCRIPTS_PATH.."/${escapeLuaString(baseName)}"`;
        if (packMode() === "zip-then-split" && passwordValue) {
          scriptLines.push("");
          scriptLines.push("if ok and out then");
          scriptLines.push(
            `  local unzip_ok, unzip_err = file.unzip(out, ${unzipTarget}, "${escapeLuaString(
              passwordValue
            )}")`
          );
          scriptLines.push("  if not unzip_ok then");
          scriptLines.push('    nLog("解压失败", unzip_err)');
          scriptLines.push("  end");
          scriptLines.push("  if unzip_ok then");
          scriptLines.push("    file.remove(out)");
          scriptLines.push("  end");
          scriptLines.push("else");
          scriptLines.push('  nLog("合并失败", out)');
          scriptLines.push("end");
        } else {
          scriptLines.push("");
          scriptLines.push("if ok and out then");
          scriptLines.push(
            `  local unzip_ok, unzip_err = file.unzip(out, ${unzipTarget})`
          );
          scriptLines.push("  if not unzip_ok then");
          scriptLines.push('    nLog("解压失败", unzip_err)');
          scriptLines.push("  end");
          scriptLines.push("  if unzip_ok then");
          scriptLines.push("    file.remove(out)");
          scriptLines.push("  end");
          scriptLines.push("else");
          scriptLines.push('  nLog("合并失败", out)');
          scriptLines.push("end");
        }
      } else {
        scriptLines.push("");
        scriptLines.push("if not ok then");
        scriptLines.push('  nLog("合并失败", out)');
        scriptLines.push("end");
      }
      setLuaSnippet(scriptLines.join("\n"));
      setSuccess(`完成：共输出 ${result.parts} 份`);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  };

  const currentProgress = () => {
    const data = progress();
    if (!data || data.totalBytes === 0) return 0;
    return Math.min(100, (data.processedBytes / data.totalBytes) * 100);
  };

  const copyLuaSnippet = async () => {
    if (!luaSnippet()) return;
    try {
      await navigator.clipboard.writeText(luaSnippet());
      setCopyHint("已复制");
    } catch (err) {
      setCopyHint("复制失败");
    }
  };

  const openPartsFolder = async () => {
    const files = outputFiles();
    if (!files.length) return;
    const dir = extractDir(files[0]);
    if (!dir) return;
    try {
      setOpenHint("");
      await openPath(dir);
      setOpenHint("已打开");
    } catch (err) {
      try {
        await revealItemInDir(files[0]);
        setOpenHint("已打开");
      } catch (inner) {
        setOpenHint("打开失败");
      }
    }
  };

  const downloadLuaModule = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const targetPath = await save({
        title: "保存 merge_parts.lua",
        defaultPath: "merge_parts.lua",
      });
      if (!targetPath) return;
      await writeTextFile(targetPath, mergePartsLua);
      setCopyHint("已保存");
    } catch (err) {
      setCopyHint("保存失败");
    }
  };

  return (
    <main class="app-shell">
      <header class="hero">
        <div>
          <p class="eyebrow">
            File Split Packer <span class="version-tag">{buildTag}</span>
          </p>
          <h1>大文件切分 + Zip 打包</h1>
          <p class="lead">
            支持两种切分策略与两种打包流程。
          </p>
        </div>
      </header>

      <section class="grid">
        <div class="card">
          <h2>源文件与输出</h2>
          <div
            class="field dropzone"
            onDrop={handleFileDrop}
            onDragOver={handleDragOver}
          >
            <label>输入文件</label>
            <div class="path-row">
              <input
                readOnly
                value={inputPath()}
                placeholder="选择要处理的文件"
              />
              <button onClick={chooseInput} disabled={running()}>
                选择文件
              </button>
            </div>
          </div>

          <div class="field">
            <label>输出目录</label>
            <div class="path-row">
              <input
                readOnly
                value={outputDir()}
                placeholder="选择输出目录（默认同目录）"
              />
              <button onClick={chooseOutput} disabled={running()}>
                选择目录
              </button>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>切分方式</h2>
          <div class="option-row">
            <label class="option inline">
              <span class="option-label">
                <input
                  type="radio"
                  name="splitBy"
                  checked={splitBy() === "size"}
                  onChange={() => setSplitBy("size")}
                  disabled={running()}
                />
                <span>按每份大小</span>
              </span>
              <div class="inline-controls">
                <input
                  type="number"
                  min={sizeUnit() === "B" ? 1024 : 1}
                  value={sizeValue()}
                  onInput={(e) => setSizeValue(Number(e.currentTarget.value))}
                  disabled={running() || splitBy() !== "size"}
                />
                <select
                  value={sizeUnit()}
                  onChange={(e) => setSizeUnit(e.currentTarget.value)}
                  disabled={running() || splitBy() !== "size"}
                >
                  <option value="B">Bytes</option>
                  <option value="KB">KB</option>
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
              </div>
            </label>
            <label class="option inline">
              <span class="option-label">
                <input
                  type="radio"
                  name="splitBy"
                  checked={splitBy() === "count"}
                  onChange={() => setSplitBy("count")}
                  disabled={running()}
                />
                <span>按份数</span>
              </span>
              <input
                class="inline-count"
                type="number"
                min="1"
                value={countValue()}
                onInput={(e) => setCountValue(Number(e.currentTarget.value))}
                disabled={running() || splitBy() !== "count"}
              />
            </label>
          </div>

          <Show when={packMode() === "split-then-zip"}>
            <div class="field">
              <label>目录切分策略</label>
            <div class="option-row">
              <label class="option">
                <input
                  type="radio"
                    name="dirSplitMode"
                    checked={dirSplitMode() === "compress-split-store"}
                    onChange={() => setDirSplitMode("compress-split-store")}
                    disabled={running()}
                  />
                  <span>先压缩 → 切分 → Store 打包（默认）</span>
                </label>
                <label class="option">
                  <input
                    type="radio"
                    name="dirSplitMode"
                    checked={dirSplitMode() === "store-split-compress"}
                    onChange={() => setDirSplitMode("store-split-compress")}
                    disabled={running()}
                  />
                <span>先 Store → 切分 → 压缩</span>
              </label>
            </div>
          </div>
        </Show>
        </div>

        <div class="card">
          <h2>打包流程</h2>
          <div class="option-row">
            <label class="option inline">
              <span class="option-label">
                <input
                  type="radio"
                  name="packMode"
                  checked={packMode() === "split-then-zip"}
                  onChange={() => setPackMode("split-then-zip")}
                  disabled={running()}
                />
                <span>先分割后逐个压缩</span>
              </span>
              <span class="option-hint">
                filename.parts/filename.part-0001.zip
              </span>
            </label>
            <label class="option inline">
              <span class="option-label">
                <input
                  type="radio"
                  name="packMode"
                  checked={packMode() === "zip-then-split"}
                  onChange={() => setPackMode("zip-then-split")}
                  disabled={running()}
                />
                <span>先压缩然后分割</span>
              </span>
              <span class="option-hint">
                filename.parts/filename.zip.part-0001
              </span>
            </label>
          </div>

          <div class="field">
            <label>压缩密码（可选）</label>
            <input
              type="password"
              value={password()}
              placeholder="留空则不加密"
              onInput={(e) => setPassword(e.currentTarget.value)}
              disabled={running()}
            />
          </div>
        </div>


        <div class="card accent">
          <h2>执行</h2>
          <button class="primary" onClick={startProcess} disabled={running()}>
            {running() ? "处理中..." : "开始处理"}
          </button>

          <Show when={progress()}>
            <div class="progress">
              <div class="progress-bar">
                <div
                  class="progress-fill"
                  style={{ width: `${currentProgress()}%` }}
                />
              </div>
              <div class="progress-meta">
                <span>{progress()!.message}</span>
                <span>
                  {formatBytes(progress()!.processedBytes)} /{" "}
                  {formatBytes(progress()!.totalBytes)}
                </span>
              </div>
              <Show when={progress()!.partTotal > 0}>
                <div class="progress-part">
                  分片 {progress()!.partIndex} / {progress()!.partTotal}
                </div>
              </Show>
            </div>
          </Show>

          <Show when={error()}>
            <div class="alert error">{error()}</div>
          </Show>
          <Show when={success()}>
            <div class="alert success">{success()}</div>
          </Show>
        </div>
      </section>

      <Show when={luaSnippet()}>
        <section class="result">
          <div class="result-header">
            <h2>XXT 合并脚本</h2>
            <button class="ghost" onClick={copyLuaSnippet}>
              复制
            </button>
            <button class="ghost" onClick={downloadLuaModule}>
              下载 merge_parts.lua
            </button>
            <Show when={copyHint()}>
              <span class="copy-hint">{copyHint()}</span>
            </Show>
          </div>
          <pre class="code-block">{luaSnippet()}</pre>
        </section>
      </Show>

      <Show when={outputFiles().length > 0}>
        <section class="result output">
          <div class="result-header">
            <h2>输出文件</h2>
            <button class="ghost" onClick={openPartsFolder}>
              打开输出目录
            </button>
            <Show when={openHint()}>
              <span class="copy-hint">{openHint()}</span>
            </Show>
          </div>
          <ul>
            <For each={outputFiles()}>
              {(file) => <li>{file}</li>}
            </For>
          </ul>
        </section>
      </Show>
    </main>
  );
}

export default App;
