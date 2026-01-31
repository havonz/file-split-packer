import { createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { confirm, open as openDialog } from "@tauri-apps/plugin-dialog";
import { exists, readDir, stat } from "@tauri-apps/plugin-fs";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
  partSha256s: { path: string; sha256: string }[];
};

type RestoreResult = {
  mergedFile?: string;
  extractedDir?: string;
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

const extractName = (path: string) => {
  const slashIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return slashIndex === -1 ? path : path.slice(slashIndex + 1);
};

const normalizePath = (path: string) => path.replace(/\\/g, "/");

const joinPath = (dir: string, name: string) => {
  if (!dir) return name;
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
};

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
  type DropTarget =
    | "input-pack"
    | "input-restore"
    | "output-pack"
    | "output-restore";
  let dropTarget: DropTarget | null = null;
  let dropDepth = 0;
  let windowScaleFactor = 1;
  let windowInnerPosition = { x: 0, y: 0 };
  let ignoreNextDrop = false;
  const [workMode, setWorkMode] = createSignal<"pack" | "restore">("pack");
  const [inputPath, setInputPath] = createSignal("");
  const [outputDir, setOutputDir] = createSignal("");
  const [splitBy, setSplitBy] = createSignal<"size" | "count">("size");
  const [sizeValue, setSizeValue] = createSignal(95);
  const [sizeUnit, setSizeUnit] = createSignal("MB");
  const [countValue, setCountValue] = createSignal(4);
  const [password, setPassword] = createSignal("");
  const [compressionLevel, setCompressionLevel] = createSignal("6");
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
  const [restoreInputPath, setRestoreInputPath] = createSignal("");
  const [restoreOutputDir, setRestoreOutputDir] = createSignal("");
  const [restoreMode, setRestoreMode] = createSignal<
    "split-then-zip" | "zip-then-split"
  >("split-then-zip");
  const [restorePassword, setRestorePassword] = createSignal("");
  const [restoreAutoExtract, setRestoreAutoExtract] = createSignal(true);
  const [dropHint, setDropHint] = createSignal<DropTarget | null>(null);
  const getLogicalPoint = (position: { x: number; y: number }) => {
    try {
      const logical = new PhysicalPosition(position.x, position.y).toLogical(
        windowScaleFactor
      );
      return { x: logical.x, y: logical.y };
    } catch (err) {
      return { x: position.x, y: position.y };
    }
  };

  const resolveTargetFromPosition = (position: { x: number; y: number }) => {
    const buildPoints = () => {
      const logical = getLogicalPoint(position);
      const points = [
        { x: logical.x, y: logical.y },
        { x: position.x, y: position.y },
      ];
      if (windowInnerPosition.x || windowInnerPosition.y) {
        const innerLogical = getLogicalPoint(windowInnerPosition);
        points.push({ x: logical.x - innerLogical.x, y: logical.y - innerLogical.y });
        points.push({ x: position.x - innerLogical.x, y: position.y - innerLogical.y });
      }
      return points.filter(
        (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
      );
    };

    const getRect = (target: DropTarget) => {
      const element = document.querySelector<HTMLElement>(
        `[data-drop-target="${target}"]`
      );
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return rect;
    };

    const contains = (rect: DOMRect, x: number, y: number) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

    const points = buildPoints();
    const priority: DropTarget[] = [
      "output-pack",
      "output-restore",
      "input-pack",
      "input-restore",
    ];

    for (const target of priority) {
      const rect = getRect(target);
      if (!rect) continue;
      if (points.some((point) => contains(rect, point.x, point.y))) {
        return target;
      }
    }

    return null;
  };

  onMount(async () => {
    try {
      const appWindow = getCurrentWindow();
      windowScaleFactor = await appWindow.scaleFactor();
      const initialPosition = await appWindow.innerPosition();
      windowInnerPosition = { x: initialPosition.x, y: initialPosition.y };
      const unlistenScale = await appWindow.onScaleChanged(({ payload }) => {
        windowScaleFactor = payload.scaleFactor;
      });
      const unlistenMove = await appWindow.onMoved(({ payload }) => {
        windowInnerPosition = { x: payload.x, y: payload.y };
      });
      onCleanup(() => {
        unlistenScale();
        unlistenMove();
      });
    } catch (err) {
      windowScaleFactor = window.devicePixelRatio || 1;
    }

    const unlisten = await listen<ProgressPayload>(
      "split-progress",
      (event) => {
        setProgress(event.payload);
      }
    );
    const unlistenDrop = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "leave") {
        dropTarget = null;
        dropDepth = 0;
        setDropHint(null);
        return;
      }
      if (event.payload.type === "enter" || event.payload.type === "over") {
        const position = event.payload.position;
        const resolved = resolveTargetFromPosition(position);
        dropTarget = resolved;
        setDropHint(resolved);
        return;
      }
      if (event.payload.type !== "drop") return;
      if (ignoreNextDrop) {
        ignoreNextDrop = false;
        return;
      }
      const path = event.payload.paths?.[0];
      if (!path) return;
      const position = event.payload.position;
      const resolved = resolveTargetFromPosition(position) || dropTarget;
      if (resolved === "output-pack") {
        void resolveDropDir(path).then((dir) => {
          if (dir) setOutputDir(dir);
        });
        dropTarget = null;
        dropDepth = 0;
        setDropHint(null);
        return;
      }
      if (resolved === "output-restore") {
        void resolveDropDir(path).then((dir) => {
          if (dir) setRestoreOutputDir(dir);
        });
        dropTarget = null;
        dropDepth = 0;
        setDropHint(null);
        return;
      }
      if (resolved === "input-pack") {
        setInputPath(path);
        dropTarget = null;
        dropDepth = 0;
        setDropHint(null);
        return;
      }
      if (resolved === "input-restore") {
        setRestoreInputPath(path);
        dropTarget = null;
        dropDepth = 0;
        setDropHint(null);
        return;
      }
      if (workMode() === "restore") {
        setRestoreInputPath(path);
      } else {
        setInputPath(path);
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
  };

  const chooseRestoreFile = async () => {
    const selected = await openDialog({ multiple: false, directory: false });
    if (!selected || Array.isArray(selected)) return;
    setRestoreInputPath(selected);
  };

  const chooseRestoreFolder = async () => {
    const selected = await openDialog({ multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    setRestoreInputPath(selected);
  };

  const handleFileDrop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dropTarget = null;
    dropDepth = 0;
    setDropHint(null);
    ignoreNextDrop = true;
    const list = event.dataTransfer?.files;
    if (!list || list.length === 0) return;
    const file = list[0];
    if (!file?.path) return;
    if (workMode() === "restore") {
      setRestoreInputPath(file.path);
    } else {
      setInputPath(file.path);
    }
  };

  const handleDragEnter =
    (target: DropTarget) => (event: DragEvent) => {
      event.preventDefault();
      if (dropTarget !== target) {
        dropTarget = target;
        dropDepth = 1;
        setDropHint(target);
      } else {
        dropDepth += 1;
      }
    };

  const handleDragOver =
    (target: DropTarget) => (event: DragEvent) => {
      event.preventDefault();
      if (dropTarget !== target) {
        dropTarget = target;
        dropDepth = 1;
        setDropHint(target);
      }
    };

  const handleDragLeave =
    (target: DropTarget) => () => {
      if (dropTarget !== target) return;
      dropDepth = Math.max(0, dropDepth - 1);
      if (dropDepth === 0) {
        dropTarget = null;
        setDropHint(null);
      }
    };

  const resolveDropDir = async (path: string) => {
    try {
      const info = await stat(path);
      if (info.isDir) {
        return path;
      }
    } catch (err) {
      // ignore
    }
    return extractDir(path);
  };

  const handlePackOutputDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dropTarget = null;
    dropDepth = 0;
    setDropHint(null);
    ignoreNextDrop = true;
    if (running()) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file?.path) return;
    const dir = await resolveDropDir(file.path);
    if (!dir) return;
    setOutputDir(dir);
  };

  const handleRestoreOutputDrop = async (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dropTarget = null;
    dropDepth = 0;
    setDropHint(null);
    ignoreNextDrop = true;
    if (running()) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file?.path) return;
    const dir = await resolveDropDir(file.path);
    if (!dir) return;
    setRestoreOutputDir(dir);
  };

  const chooseOutput = async () => {
    const selected = await openDialog({ multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    setOutputDir(selected);
  };

  const chooseRestoreOutput = async () => {
    const selected = await openDialog({ multiple: false, directory: true });
    if (!selected || Array.isArray(selected)) return;
    setRestoreOutputDir(selected);
  };

  const resetStatus = () => {
    setError("");
    setSuccess("");
    setOutputFiles([]);
    setLuaSnippet("");
    setCopyHint("");
    setOpenHint("");
    setProgress(null);
  };

  const ensurePartsDir = async (baseName: string, resolvedOutput: string) => {
    const partsDir = joinPath(resolvedOutput, `${baseName}.parts`);
    try {
      const existsDir = await exists(partsDir);
      if (!existsDir) {
        return { proceed: true, overwrite: false };
      }
      const entries = await readDir(partsDir);
      if (entries.length === 0) {
        return { proceed: true, overwrite: false };
      }
      const confirmed = await confirm(
        "检测到已存在的分片目录，继续将覆盖其中内容，是否确认？",
        { title: "确认覆盖", kind: "warning" }
      );
      return { proceed: confirmed, overwrite: confirmed };
    } catch (err) {
      setError("无法检查输出目录，请手动确认分片目录是否可写");
      return { proceed: false, overwrite: false };
    }
  };

  const switchMode = (mode: "pack" | "restore") => {
    if (mode === workMode()) return;
    setWorkMode(mode);
    resetStatus();
  };

  const startProcess = async () => {
    if (workMode() === "restore") {
      await startRestore();
      return;
    }
    await startPack();
  };

  const startPack = async () => {
    resetStatus();

    if (!inputPath()) {
      setError("请先选择输入文件");
      return;
    }
    const resolvedOutput = outputDir() || extractDir(inputPath());
    if (!resolvedOutput) {
      setError("请指定输出目录");
      return;
    }
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
    const baseName = extractName(inputPath());
    let overwriteDecision = { proceed: true, overwrite: false };
    if (outputDir()) {
      overwriteDecision = await ensurePartsDir(baseName, resolvedOutput);
      if (!overwriteDecision.proceed) {
        return;
      }
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
      compressionLevel: Number(compressionLevel()),
      overwriteParts: overwriteDecision.overwrite,
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
        return `  XXT_SCRIPTS_PATH.."/${escapeLuaString(relative)}",`;
      });
      const sha256Map = new Map(
        (result.partSha256s || []).map((item) => [item.path, item.sha256])
      );
      const passwordValue = password().trim();
      const outputName = result.isDir ? `${baseName}.zip` : baseName;
      const outputFileLine = `  output_file = XXT_SCRIPTS_PATH.."/${escapeLuaString(outputName)}",`;
      const scriptLines = [
        'local merge_parts = require("merge_parts")',
        "",
        `-- ${packMode() === "split-then-zip" ? "split-then-zip" : "zip-then-split"}`,
        "local file_list = {",
        ...fileList,
        "}",
      ];
      if (
        packMode() === "split-then-zip" &&
        result.partSha256s &&
        result.partSha256s.length === result.outputFiles.length
      ) {
        const sha256Lines = result.outputFiles.map((filePath) => {
          const sha256Value = sha256Map.get(filePath) || "";
          return `  "${sha256Value}",`;
        });
        scriptLines.push(
          "",
          "-- SHA256 校验",
          "local part_sha256 = {",
          ...sha256Lines,
          "}",
          "local failed = merge_parts.verify_parts(file_list, part_sha256)",
          "if #failed > 0 then",
          '  nLog("分包校验失败", failed)',
          "  return",
          "end"
        );
      }
      scriptLines.push(
        "",
        "local ok, out = merge_parts.restore({",
        `  mode = "${packMode()}",`,
        "  file_list = file_list,",
        outputFileLine,
      );
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

  const startRestore = async () => {
    resetStatus();

    if (!restoreInputPath()) {
      setError("请先选择分片文件或目录");
      return;
    }
    const resolvedOutput = restoreOutputDir() || extractDir(restoreInputPath());
    if (!resolvedOutput) {
      setError("请指定输出目录");
      return;
    }
    const payload = {
      inputPath: restoreInputPath(),
      outputDir: resolvedOutput,
      mergeMode: restoreMode(),
      password: restorePassword().trim()
        ? restorePassword().trim()
        : undefined,
      autoExtract: restoreAutoExtract(),
    };

    try {
      setRunning(true);
      const result = await invoke<RestoreResult>("restore_parts", {
        options: payload,
      });
      setOutputFiles(result.outputFiles || []);
      if (result.extractedDir) {
        setSuccess("合并并解包完成");
      } else {
        setSuccess("合并完成");
      }
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
    const primary =
      workMode() === "restore" && files.length > 1
        ? files[files.length - 1]
        : files[0];
    const dir = workMode() === "restore" && files.length > 1
      ? primary
      : extractDir(primary);
    if (!dir) return;
    try {
      setOpenHint("");
      await openPath(dir);
      setOpenHint("已打开");
    } catch (err) {
      try {
        await revealItemInDir(primary);
        setOpenHint("已打开");
      } catch (inner) {
        setOpenHint("打开失败");
      }
    }
  };

  const downloadLuaModule = async () => {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const targetPath = await save({
        title: "保存 merge_parts.lua",
        defaultPath: "merge_parts.lua",
      });
      if (!targetPath) return;
      await invoke("save_text_file", {
        options: {
          targetPath,
          content: mergePartsLua,
        },
      });
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
          <h1>切分/合并 + Zip 打包/解包</h1>
          <p class="lead">
            一键完成分片打包与逆向合并解包。
          </p>
        </div>
      </header>

      <section class="mode-bar">
        <div class="mode-switch">
          <button
            classList={{ active: workMode() === "pack" }}
            onClick={() => switchMode("pack")}
            disabled={running()}
          >
            切分打包
          </button>
          <button
            classList={{ active: workMode() === "restore" }}
            onClick={() => switchMode("restore")}
            disabled={running()}
          >
            合并解包
          </button>
        </div>
        <p class="mode-hint">
          {workMode() === "pack"
            ? "用于生成分片压缩包。"
            : "用于将分片合并并恢复文件或目录。"}
        </p>
      </section>

      <section class="grid">
        <div class="card" classList={{ hidden: workMode() !== "pack" }}>
          <h2>源文件与输出</h2>
          <div
            class="field dropzone"
            data-drop-target="input-pack"
            onDrop={handleFileDrop}
            onDragEnter={handleDragEnter("input-pack")}
            onDragOver={handleDragOver("input-pack")}
            onDragLeave={handleDragLeave("input-pack")}
            classList={{ "drop-active": dropHint() === "input-pack" }}
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

          <div
            class="field"
            data-drop-target="output-pack"
            onDrop={handlePackOutputDrop}
            onDragEnter={handleDragEnter("output-pack")}
            onDragOver={handleDragOver("output-pack")}
            onDragLeave={handleDragLeave("output-pack")}
            classList={{ "drop-active": dropHint() === "output-pack" }}
          >
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

        <div class="card" classList={{ hidden: workMode() !== "pack" }}>
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
                <span>每份最大</span>
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

        <div class="card" classList={{ hidden: workMode() !== "pack" }}>
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
          <div class="field">
            <label>压缩等级</label>
            <select
              value={compressionLevel()}
              onChange={(e) => setCompressionLevel(e.currentTarget.value)}
              disabled={running()}
            >
              <option value="1">速度优先（1）</option>
              <option value="6">平衡（6）</option>
              <option value="9">体积优先（9）</option>
            </select>
          </div>
        </div>


        <div class="card" classList={{ hidden: workMode() !== "restore" }}>
          <h2>分片来源与输出</h2>
          <div
            class="field dropzone"
            data-drop-target="input-restore"
            onDrop={handleFileDrop}
            onDragEnter={handleDragEnter("input-restore")}
            onDragOver={handleDragOver("input-restore")}
            onDragLeave={handleDragLeave("input-restore")}
            classList={{ "drop-active": dropHint() === "input-restore" }}
          >
            <label>分片文件/目录</label>
            <div class="path-row multi">
              <input
                readOnly
                value={restoreInputPath()}
                placeholder="选择任意分片文件或 .parts 目录"
              />
              <button onClick={chooseRestoreFile} disabled={running()}>
                选文件
              </button>
              <button onClick={chooseRestoreFolder} disabled={running()}>
                选目录
              </button>
            </div>
            <p class="hint">支持拖拽分片文件或分片目录。</p>
          </div>

          <div
            class="field"
            data-drop-target="output-restore"
            onDrop={handleRestoreOutputDrop}
            onDragEnter={handleDragEnter("output-restore")}
            onDragOver={handleDragOver("output-restore")}
            onDragLeave={handleDragLeave("output-restore")}
            classList={{ "drop-active": dropHint() === "output-restore" }}
          >
            <label>输出目录</label>
            <div class="path-row">
              <input
                readOnly
                value={restoreOutputDir()}
                placeholder="合并输出目录（默认同目录）"
              />
              <button onClick={chooseRestoreOutput} disabled={running()}>
                选择目录
              </button>
            </div>
          </div>
        </div>

        <div class="card" classList={{ hidden: workMode() !== "restore" }}>
          <h2>合并方式</h2>
          <div class="option-row">
            <label class="option inline">
              <span class="option-label">
                <input
                  type="radio"
                  name="restoreMode"
                  checked={restoreMode() === "split-then-zip"}
                  onChange={() => setRestoreMode("split-then-zip")}
                  disabled={running()}
                />
                <span>解包合并</span>
              </span>
              <span class="option-hint">对应 先分割后逐个压缩</span>
            </label>
            <label class="option inline">
              <span class="option-label">
                <input
                  type="radio"
                  name="restoreMode"
                  checked={restoreMode() === "zip-then-split"}
                  onChange={() => setRestoreMode("zip-then-split")}
                  disabled={running()}
                />
                <span>合并解包</span>
              </span>
              <span class="option-hint">对应 先压缩后分割</span>
            </label>
          </div>
        </div>

        <div class="card" classList={{ hidden: workMode() !== "restore" }}>
          <h2>解包设置</h2>
          <label class="option inline">
            <span class="option-label">
              <input
                type="checkbox"
                checked={restoreAutoExtract()}
                onChange={(e) => setRestoreAutoExtract(e.currentTarget.checked)}
                disabled={running()}
              />
              <span>合并后自动解压</span>
            </span>
            <span class="option-hint">合并结果为 Zip 时自动解包</span>
          </label>
          <div class="field">
            <label>解密/解压密码（可选）</label>
            <input
              type="password"
              value={restorePassword()}
              placeholder="分片或 Zip 密码"
              onInput={(e) => setRestorePassword(e.currentTarget.value)}
              disabled={running()}
            />
          </div>
        </div>

        <div class="card accent">
          <h2>执行</h2>
          <button class="primary" onClick={startProcess} disabled={running()}>
            {running()
              ? "处理中..."
              : workMode() === "pack"
              ? "开始切分"
              : "开始合并"}
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

      <Show when={workMode() === "pack" && luaSnippet()}>
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
