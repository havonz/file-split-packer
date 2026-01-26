import { createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

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

function App() {
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
  const [running, setRunning] = createSignal(false);
  const [progress, setProgress] = createSignal<ProgressPayload | null>(null);
  const [error, setError] = createSignal("");
  const [success, setSuccess] = createSignal("");
  const [outputFiles, setOutputFiles] = createSignal<string[]>([]);

  onMount(async () => {
    const unlisten = await listen<ProgressPayload>(
      "split-progress",
      (event) => {
        setProgress(event.payload);
      }
    );
    onCleanup(() => {
      unlisten();
    });
  });

  const chooseInput = async () => {
    const selected = await open({ multiple: false, directory: false });
    if (!selected || Array.isArray(selected)) return;
    setInputPath(selected);
    if (!outputDir()) {
      setOutputDir(extractDir(selected));
    }
  };

  const chooseOutput = async () => {
    const selected = await open({ multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    setOutputDir(selected);
  };

  const startProcess = async () => {
    setError("");
    setSuccess("");
    setOutputFiles([]);

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
        password: password().trim() ? password().trim() : undefined,
      };

    try {
      setRunning(true);
      const result = await invoke<SplitResult>("process_file", {
        options: payload,
      });
      setOutputFiles(result.outputFiles);
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

  return (
    <main class="app-shell">
      <header class="hero">
        <div>
          <p class="eyebrow">File Split Packer</p>
          <h1>大文件切分 + Zip 打包</h1>
          <p class="lead">
            支持两种切分策略与两种打包流程。
          </p>
        </div>
      </header>

      <section class="grid">
        <div class="card">
          <h2>源文件与输出</h2>
          <div class="field">
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
            <label class="option">
              <input
                type="radio"
                name="splitBy"
                checked={splitBy() === "size"}
                onChange={() => setSplitBy("size")}
                disabled={running()}
              />
              <span>按每份大小</span>
            </label>
            <label class="option">
              <input
                type="radio"
                name="splitBy"
                checked={splitBy() === "count"}
                onChange={() => setSplitBy("count")}
                disabled={running()}
              />
              <span>按份数</span>
            </label>
          </div>

          <div class="field dual">
            <div classList={{ hidden: splitBy() !== "size" }}>
              <label>每份大小</label>
              <div class="inline-controls">
                <input
                  type="number"
                  min="1"
                  value={sizeValue()}
                  onInput={(e) => setSizeValue(Number(e.currentTarget.value))}
                  disabled={running()}
                />
                <select
                  value={sizeUnit()}
                  onChange={(e) => setSizeUnit(e.currentTarget.value)}
                  disabled={running()}
                >
                  <option value="B">Bytes</option>
                  <option value="KB">KB</option>
                  <option value="MB">MB</option>
                  <option value="GB">GB</option>
                </select>
              </div>
            </div>

            <div classList={{ hidden: splitBy() !== "count" }}>
              <label>份数</label>
              <input
                type="number"
                min="1"
                value={countValue()}
                onInput={(e) => setCountValue(Number(e.currentTarget.value))}
                disabled={running()}
              />
            </div>
          </div>
        </div>

        <div class="card">
          <h2>打包流程</h2>
          <div class="option-row">
            <label class="option">
              <input
                type="radio"
                name="packMode"
                checked={packMode() === "split-then-zip"}
                onChange={() => setPackMode("split-then-zip")}
                disabled={running()}
              />
              <span>先分割后逐个压缩</span>
            </label>
            <label class="option">
              <input
                type="radio"
                name="packMode"
                checked={packMode() === "zip-then-split"}
                onChange={() => setPackMode("zip-then-split")}
                disabled={running()}
              />
              <span>先压缩然后分割</span>
            </label>
          </div>

          <div class="hint">
            先分割后压缩：<strong>filename.001.zip</strong>；
            先压缩后分割：<strong>filename.zip.001</strong>
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

      <Show when={outputFiles().length > 0}>
        <section class="result">
          <h2>输出文件</h2>
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
