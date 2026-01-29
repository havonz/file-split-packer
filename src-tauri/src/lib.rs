use serde::{Deserialize, Serialize};
use std::{
    cmp,
    collections::HashMap,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use rayon::prelude::*;
use zip::{result::ZipError, write::FileOptions, AesMode, CompressionMethod, ZipArchive, ZipWriter};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitOptions {
    input_path: String,
    output_dir: String,
    split_by: String,
    size_bytes: Option<u64>,
    count: Option<u64>,
    pack_mode: String,
    password: Option<String>,
    dir_split_mode: Option<String>,
    overwrite_parts: Option<bool>,
    compression_level: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitResult {
    parts: usize,
    output_files: Vec<String>,
    is_dir: bool,
    base_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreOptions {
    input_path: String,
    output_dir: String,
    merge_mode: String,
    password: Option<String>,
    auto_extract: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreResult {
    merged_file: Option<String>,
    extracted_dir: Option<String>,
    output_files: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    phase: String,
    processed_bytes: u64,
    total_bytes: u64,
    part_index: usize,
    part_total: usize,
    message: String,
}

#[tauri::command]
async fn process_file(app: AppHandle, options: SplitOptions) -> Result<SplitResult, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || process_file_blocking(&app, options))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn restore_parts(app: AppHandle, options: RestoreOptions) -> Result<RestoreResult, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || restore_parts_blocking(&app, options))
        .await
        .map_err(|e| e.to_string())?
}

fn process_file_blocking(app: &AppHandle, options: SplitOptions) -> Result<SplitResult, String> {
    let input_path = PathBuf::from(options.input_path);
    let output_dir = PathBuf::from(options.output_dir);
    let overwrite_parts = options.overwrite_parts.unwrap_or(false);
    let compression_level = options.compression_level;

    if !input_path.exists() {
        return Err("输入文件不存在".to_string());
    }
    if !output_dir.exists() {
        fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    }

    match options.pack_mode.as_str() {
        "split-then-zip" => split_then_zip(
            app,
            &input_path,
            &output_dir,
            options.split_by.as_str(),
            options.size_bytes,
            options.count,
            options
                .password
                .as_deref()
                .filter(|value| !value.is_empty()),
            options.dir_split_mode.as_deref(),
            overwrite_parts,
            compression_level,
        ),
        "zip-then-split" => zip_then_split(
            app,
            &input_path,
            &output_dir,
            options.split_by.as_str(),
            options.size_bytes,
            options.count,
            options
                .password
                .as_deref()
                .filter(|value| !value.is_empty()),
            overwrite_parts,
            compression_level,
        ),
        _ => Err("未知的打包方式".to_string()),
    }
}

fn restore_parts_blocking(
    app: &AppHandle,
    options: RestoreOptions,
) -> Result<RestoreResult, String> {
    let input_path = PathBuf::from(options.input_path);
    let output_dir = PathBuf::from(options.output_dir);

    if !input_path.exists() {
        return Err("输入分片不存在".to_string());
    }
    if !output_dir.exists() {
        fs::create_dir_all(&output_dir).map_err(|e| e.to_string())?;
    }

    let password = options.password.as_deref().filter(|value| !value.is_empty());
    let auto_extract = options.auto_extract.unwrap_or(false);

    match options.merge_mode.as_str() {
        "split-then-zip" => restore_split_then_zip(app, &input_path, &output_dir, password, auto_extract),
        "zip-then-split" => restore_zip_then_split(app, &input_path, &output_dir, password, auto_extract),
        _ => Err("未知的合并方式".to_string()),
    }
}

fn split_then_zip(
    app: &AppHandle,
    input_path: &Path,
    output_dir: &Path,
    split_by: &str,
    size_bytes: Option<u64>,
    count: Option<u64>,
    password: Option<&str>,
    dir_split_mode: Option<&str>,
    overwrite_parts: bool,
    compression_level: Option<i64>,
) -> Result<SplitResult, String> {
    let metadata = fs::metadata(input_path).map_err(|e| e.to_string())?;
    let is_dir = metadata.is_dir();

    let base_name = file_base_name(input_path)?;
    let parts_dir = output_dir.join(format!("{}.parts", base_name));
    ensure_parts_dir(&parts_dir, overwrite_parts)?;

    let (dir_zip_compression, dir_part_compression) = match dir_split_mode.unwrap_or("") {
        "store-split-compress" => (CompressionMethod::Stored, CompressionMethod::Deflated),
        "compress-split-store" => (CompressionMethod::Deflated, CompressionMethod::Stored),
        _ => (CompressionMethod::Deflated, CompressionMethod::Stored),
    };
    let strict_size = split_by == "size";
    if strict_size && is_dir && !matches!(dir_part_compression, CompressionMethod::Stored) {
        return Err("按每份最大时，请选择“先压缩 → 切分 → Store 打包”".to_string());
    }
    let part_compression = if strict_size {
        CompressionMethod::Stored
    } else if is_dir {
        dir_part_compression
    } else {
        CompressionMethod::Deflated
    };

    let temp_zip_path = if is_dir {
        let zip_path = parts_dir.join(format!("{}.zip", base_name));
        zip_directory(
            app,
            input_path,
            &zip_path,
            None,
            dir_zip_compression,
            compression_level,
            "pack-dir",
        )?;
        Some(zip_path)
    } else {
        None
    };

    let source_path: &Path = match temp_zip_path.as_ref() {
        Some(path) => path.as_path(),
        None => input_path,
    };
    let input_file = File::open(source_path).map_err(|e| e.to_string())?;
    let total_size = input_file.metadata().map_err(|e| e.to_string())?.len();
    if total_size == 0 {
        return Err("输入文件大小为 0，无法切分".to_string());
    }

    let (chunk_size, parts) = if strict_size && matches!(part_compression, CompressionMethod::Stored)
    {
        compute_parts_with_overhead(
            total_size,
            size_bytes,
            base_name.as_str(),
            password.is_some(),
        )?
    } else {
        compute_parts(total_size, split_by, size_bytes, count)?
    };
    let width = cmp::max(3, parts.to_string().len());
    let max_threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let use_parallel = matches!(part_compression, CompressionMethod::Deflated)
        && parts > 1
        && max_threads > 1;
    let output_files = if use_parallel {
        split_file_parts_parallel(
            app,
            source_path,
            &parts_dir,
            base_name.as_str(),
            total_size,
            chunk_size,
            parts,
            split_by,
            part_compression,
            password,
            compression_level,
            width,
        )?
    } else {
        split_file_parts_sequential(
            app,
            input_file,
            &parts_dir,
            base_name.as_str(),
            total_size,
            chunk_size,
            parts,
            split_by,
            part_compression,
            password,
            compression_level,
            width,
        )?
    };

    if let Some(path) = temp_zip_path {
        let _ = fs::remove_file(path);
    }

    Ok(SplitResult {
        parts,
        output_files,
        is_dir,
        base_name,
    })
}

#[derive(Debug, Clone)]
struct PartTask {
    index: usize,
    offset: u64,
    size: u64,
    zip_path: PathBuf,
    entry_name: String,
}

fn split_file_parts_sequential(
    app: &AppHandle,
    input_file: File,
    parts_dir: &Path,
    base_name: &str,
    total_size: u64,
    chunk_size: u64,
    parts: usize,
    split_by: &str,
    part_compression: CompressionMethod,
    password: Option<&str>,
    compression_level: Option<i64>,
    width: usize,
) -> Result<Vec<String>, String> {
    let mut reader = BufReader::new(input_file);
    let mut output_files = Vec::with_capacity(parts);
    let mut processed = 0u64;

    for part_index in 1..=parts {
        let remaining = total_size.saturating_sub(processed);
        let part_size = cmp::min(chunk_size, remaining);
        if part_size == 0 && split_by != "count" {
            break;
        }
        let part_label = format_part_index(part_index, width);
        let zip_name = format!("{}.part-{}.zip", base_name, part_label);
        let entry_name = format!("{}.part-{}", base_name, part_label);
        let zip_path = parts_dir.join(&zip_name);

        emit_progress(
            app,
            "split-zip",
            processed,
            total_size,
            part_index,
            parts,
            format!("准备写入第 {} 份", part_index),
        );

        let zip_file = File::create(&zip_path).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(BufWriter::new(zip_file));
        let options = build_file_options(password, part_compression, compression_level);
        zip.start_file(entry_name, options)
            .map_err(|e| e.to_string())?;

        copy_n_with_progress(
            &mut reader,
            &mut zip,
            part_size,
            |delta| {
                processed += delta;
                emit_progress(
                    app,
                    "split-zip",
                    processed,
                    total_size,
                    part_index,
                    parts,
                    "写入中".to_string(),
                );
            },
        )
        .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
        output_files.push(zip_path.to_string_lossy().to_string());
    }

    Ok(output_files)
}

fn split_file_parts_parallel(
    app: &AppHandle,
    source_path: &Path,
    parts_dir: &Path,
    base_name: &str,
    total_size: u64,
    chunk_size: u64,
    parts: usize,
    split_by: &str,
    part_compression: CompressionMethod,
    password: Option<&str>,
    compression_level: Option<i64>,
    width: usize,
) -> Result<Vec<String>, String> {
    let mut tasks = Vec::with_capacity(parts);
    for part_index in 1..=parts {
        let offset = chunk_size.saturating_mul((part_index - 1) as u64);
        let remaining = total_size.saturating_sub(offset);
        let part_size = cmp::min(chunk_size, remaining);
        if part_size == 0 && split_by != "count" {
            break;
        }
        let part_label = format_part_index(part_index, width);
        let zip_name = format!("{}.part-{}.zip", base_name, part_label);
        let entry_name = format!("{}.part-{}", base_name, part_label);
        let zip_path = parts_dir.join(&zip_name);
        tasks.push(PartTask {
            index: part_index,
            offset,
            size: part_size,
            zip_path,
            entry_name,
        });
    }

    let output_files = Arc::new(Mutex::new(vec![String::new(); parts]));
    let processed_total = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(Mutex::new(Instant::now()));

    emit_progress(
        app,
        "split-zip",
        0,
        total_size,
        if parts > 0 { 1 } else { 0 },
        parts,
        "并行压缩中".to_string(),
    );

    let max_threads = thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let concurrency = cmp::min(max_threads, tasks.len().max(1));
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(concurrency)
        .build()
        .map_err(|e| e.to_string())?;

    let result = pool.install(|| {
        tasks.par_iter().try_for_each(|task| {
            let mut source = File::open(source_path).map_err(|e| e.to_string())?;
            source
                .seek(SeekFrom::Start(task.offset))
                .map_err(|e| e.to_string())?;
            let mut reader = BufReader::new(source);

            let zip_file = File::create(&task.zip_path).map_err(|e| e.to_string())?;
            let mut zip = ZipWriter::new(BufWriter::new(zip_file));
            let options = build_file_options(password, part_compression, compression_level);
            zip.start_file(task.entry_name.as_str(), options)
                .map_err(|e| e.to_string())?;

            let processed_total = processed_total.clone();
            let last_emit = last_emit.clone();
            let app = app.clone();
            copy_n_with_progress(&mut reader, &mut zip, task.size, |delta| {
                let current = processed_total.fetch_add(delta, Ordering::Relaxed) + delta;
                if let Ok(mut last) = last_emit.lock() {
                    let now = Instant::now();
                    if current >= total_size
                        || now.duration_since(*last) >= Duration::from_millis(120)
                    {
                        *last = now;
                        emit_progress(
                            &app,
                            "split-zip",
                            current,
                            total_size,
                            task.index,
                            parts,
                            "并行压缩中".to_string(),
                        );
                    }
                }
            })
            .map_err(|e| e.to_string())?;

            zip.finish().map_err(|e| e.to_string())?;

            {
                let mut guard = output_files.lock().map_err(|_| "输出列表被锁定".to_string())?;
                guard[task.index - 1] = task.zip_path.to_string_lossy().to_string();
            }
            Ok::<(), String>(())
        })
    });

    result?;

    emit_progress(
        app,
        "split-zip",
        total_size,
        total_size,
        parts,
        parts,
        "完成".to_string(),
    );

    Arc::try_unwrap(output_files)
        .map_err(|_| "输出列表无法回收".to_string())?
        .into_inner()
        .map_err(|_| "输出列表被锁定".to_string())
}

fn zip_then_split(
    app: &AppHandle,
    input_path: &Path,
    output_dir: &Path,
    split_by: &str,
    size_bytes: Option<u64>,
    count: Option<u64>,
    password: Option<&str>,
    overwrite_parts: bool,
    compression_level: Option<i64>,
) -> Result<SplitResult, String> {
    let metadata = fs::metadata(input_path).map_err(|e| e.to_string())?;
    let is_dir = metadata.is_dir();

    let base_name = file_base_name(input_path)?;
    let parts_dir = output_dir.join(format!("{}.parts", base_name));
    ensure_parts_dir(&parts_dir, overwrite_parts)?;
    let zip_path = output_dir.join(format!("{}.zip", base_name));
    if is_dir {
        zip_directory(
            app,
            input_path,
            &zip_path,
            password,
            CompressionMethod::Deflated,
            compression_level,
            "zip",
        )?;
    } else {
        let input_file = File::open(input_path).map_err(|e| e.to_string())?;
        let total_size = input_file.metadata().map_err(|e| e.to_string())?.len();
        if total_size == 0 {
            return Err("输入文件大小为 0，无法切分".to_string());
        }
        emit_progress(
            app,
            "zip",
            0,
            total_size,
            0,
            0,
            "开始压缩".to_string(),
        );

        let mut reader = BufReader::new(input_file);
        let zip_file = File::create(&zip_path).map_err(|e| e.to_string())?;
        let mut zip = ZipWriter::new(BufWriter::new(zip_file));
        let options =
            build_file_options(password, CompressionMethod::Deflated, compression_level);
        zip.start_file(base_name.clone(), options)
            .map_err(|e| e.to_string())?;

        let mut processed = 0u64;
        copy_n_with_progress(&mut reader, &mut zip, total_size, |delta| {
            processed += delta;
            emit_progress(
                app,
                "zip",
                processed,
                total_size,
                0,
                0,
                "压缩中".to_string(),
            );
        })
        .map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }

    let zip_size = fs::metadata(&zip_path)
        .map_err(|e| e.to_string())?
        .len();
    let (chunk_size, parts) = compute_parts(zip_size, split_by, size_bytes, count)?;
    let width = cmp::max(3, parts.to_string().len());

    let mut zip_reader = BufReader::new(File::open(&zip_path).map_err(|e| e.to_string())?);
    let mut output_files = Vec::with_capacity(parts);
    let mut split_processed = 0u64;

    for part_index in 1..=parts {
        let remaining = zip_size.saturating_sub(split_processed);
        let part_size = cmp::min(chunk_size, remaining);
        if part_size == 0 && split_by != "count" {
            break;
        }
        let part_label = format_part_index(part_index, width);
        let part_name = format!("{}.zip.part-{}", base_name, part_label);
        let part_path = parts_dir.join(&part_name);

        emit_progress(
            app,
            "split",
            split_processed,
            zip_size,
            part_index,
            parts,
            format!("准备写入第 {} 份", part_index),
        );

        let part_file = File::create(&part_path).map_err(|e| e.to_string())?;
        let mut writer = BufWriter::new(part_file);

        copy_n_with_progress(&mut zip_reader, &mut writer, part_size, |delta| {
            split_processed += delta;
            emit_progress(
                app,
                "split",
                split_processed,
                zip_size,
                part_index,
                parts,
                "写入中".to_string(),
            );
        })
        .map_err(|e| e.to_string())?;

        writer.flush().map_err(|e| e.to_string())?;
        output_files.push(part_path.to_string_lossy().to_string());
    }

    let _ = fs::remove_file(&zip_path);

    Ok(SplitResult {
        parts,
        output_files,
        is_dir,
        base_name,
    })
}

fn compute_parts(
    total_size: u64,
    split_by: &str,
    size_bytes: Option<u64>,
    count: Option<u64>,
) -> Result<(u64, usize), String> {
    match split_by {
        "size" => {
            let size = size_bytes.ok_or("缺少每份大小参数")?;
            if size == 0 {
                return Err("每份大小必须大于 0".to_string());
            }
            let parts = div_ceil(total_size, size) as usize;
            Ok((size, parts))
        }
        "count" => {
            let count = count.ok_or("缺少份数参数")?;
            if count == 0 {
                return Err("份数必须大于 0".to_string());
            }
            let chunk_size = cmp::max(1, div_ceil(total_size, count));
            let parts = count as usize;
            Ok((chunk_size, parts))
        }
        _ => Err("未知的切分方式".to_string()),
    }
}

fn ensure_parts_dir(parts_dir: &Path, overwrite: bool) -> Result<(), String> {
    if parts_dir.exists() {
        let metadata = fs::metadata(parts_dir).map_err(|e| e.to_string())?;
        if !metadata.is_dir() {
            return Err("分片输出路径已存在且不是目录".to_string());
        }
        let is_empty = dir_is_empty(parts_dir)?;
        if !is_empty && !overwrite {
            return Err("分片输出目录已存在，请确认是否覆盖".to_string());
        }
        if overwrite && !is_empty {
            fs::remove_dir_all(parts_dir).map_err(|e| e.to_string())?;
        }
    }
    fs::create_dir_all(parts_dir).map_err(|e| e.to_string())?;
    Ok(())
}

fn dir_is_empty(path: &Path) -> Result<bool, String> {
    let mut entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    Ok(entries.next().is_none())
}

fn div_ceil(value: u64, divisor: u64) -> u64 {
    (value + divisor - 1) / divisor
}

fn file_base_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .ok_or_else(|| "无法解析文件名".to_string())
}

fn format_part_index(index: usize, width: usize) -> String {
    format!("{:0width$}", index, width = width)
}

fn build_file_options<'a>(
    password: Option<&'a str>,
    compression: CompressionMethod,
    compression_level: Option<i64>,
) -> FileOptions<'a, ()> {
    let mut options = FileOptions::default().compression_method(compression);
    if let Some(level) = compression_level {
        if matches!(compression, CompressionMethod::Deflated) {
            options = options.compression_level(Some(level));
        }
    }
    if let Some(password) = password {
        options.with_aes_encryption(AesMode::Aes256, password)
    } else {
        options
    }
}

fn compute_parts_with_overhead(
    total_size: u64,
    size_bytes: Option<u64>,
    base_name: &str,
    encrypted: bool,
) -> Result<(u64, usize), String> {
    let size = size_bytes.ok_or("缺少每份大小参数")?;
    let mut parts = div_ceil(total_size, size) as usize;

    for _ in 0..5 {
        let width = cmp::max(3, parts.to_string().len());
        let entry_len = base_name.len() + ".part-".len() + width;
        let overhead = zip_stored_overhead(entry_len, encrypted);
        if size <= overhead {
            return Err(format!(
                "每份大小过小，至少需要 {} 字节",
                overhead + 1
            ));
        }
        let payload = size - overhead;
        let next_parts = div_ceil(total_size, payload) as usize;
        if next_parts == parts {
            return Ok((payload, parts));
        }
        parts = next_parts;
    }

    let width = cmp::max(3, parts.to_string().len());
    let entry_len = base_name.len() + ".part-".len() + width;
    let overhead = zip_stored_overhead(entry_len, encrypted);
    if size <= overhead {
        return Err(format!(
            "每份大小过小，至少需要 {} 字节",
            overhead + 1
        ));
    }
    Ok((size - overhead, parts))
}

fn zip_stored_overhead(entry_name_len: usize, encrypted: bool) -> u64 {
    let name_len = entry_name_len as u64;
    let local_header = 30u64;
    let central_header = 46u64;
    let end_of_central = 22u64;
    let data_descriptor = 16u64;
    let safety = 32u64;
    let mut overhead =
        local_header + central_header + end_of_central + data_descriptor + safety + (2 * name_len);
    if encrypted {
        // AES 加密的保守额外开销估算，避免分片超过最大大小
        overhead += 64u64;
    }
    overhead
}

fn zip_directory(
    app: &AppHandle,
    dir_path: &Path,
    zip_path: &Path,
    password: Option<&str>,
    compression: CompressionMethod,
    compression_level: Option<i64>,
    phase: &str,
) -> Result<(), String> {
    let total_size = dir_total_size(dir_path)?;
    let zip_file = File::create(zip_path).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(BufWriter::new(zip_file));
    let mut processed = 0u64;

    let root_name = dir_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法解析目录名".to_string())?
        .to_string();

    emit_progress(
        app,
        phase,
        0,
        total_size,
        0,
        0,
        "打包目录中".to_string(),
    );

    add_dir_entries(
        dir_path,
        dir_path,
        &root_name,
        password,
        compression,
        compression_level,
        app,
        phase,
        &mut processed,
        total_size,
        &mut zip,
    )?;

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

fn add_dir_entries(
    root: &Path,
    current: &Path,
    root_name: &str,
    password: Option<&str>,
    compression: CompressionMethod,
    compression_level: Option<i64>,
    app: &AppHandle,
    phase: &str,
    processed: &mut u64,
    total_size: u64,
    zip: &mut ZipWriter<BufWriter<File>>,
) -> Result<(), String> {
    let mut has_entry = false;
    let entries = fs::read_dir(current).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?;
        let rel_path = if rel.as_os_str().is_empty() {
            root_name.to_string()
        } else {
            format!(
                "{}/{}",
                root_name,
                rel.to_string_lossy().replace('\\', "/")
            )
        };
        has_entry = true;

        if path.is_dir() {
            let dir_name = format!("{}/", rel_path.trim_end_matches('/'));
            zip.add_directory(
                dir_name,
                build_file_options(password, compression, compression_level),
            )
                .map_err(|e| e.to_string())?;
            add_dir_entries(
                root,
                &path,
                root_name,
                password,
                compression,
                compression_level,
                app,
                phase,
                processed,
                total_size,
                zip,
            )?;
        } else if path.is_file() {
            zip.start_file(
                rel_path,
                build_file_options(password, compression, compression_level),
            )
                .map_err(|e| e.to_string())?;
            let file_size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
            let mut file = BufReader::new(File::open(&path).map_err(|e| e.to_string())?);
            copy_n_with_progress(&mut file, zip, file_size, |delta| {
                *processed += delta;
                emit_progress(
                    app,
                    phase,
                    *processed,
                    total_size,
                    0,
                    0,
                    "打包目录中".to_string(),
                );
            })
            .map_err(|e| e.to_string())?;
        }
    }

    if !has_entry {
        let dir_name = format!("{}/", root_name.trim_end_matches('/'));
        zip.add_directory(
            dir_name,
            build_file_options(password, compression, compression_level),
        )
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn dir_total_size(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    let entries = fs::read_dir(path).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            total += dir_total_size(&entry_path)?;
        } else if meta.is_file() {
            total += meta.len();
        }
    }
    Ok(total)
}

fn copy_n_with_progress<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    mut remaining: u64,
    mut progress: impl FnMut(u64),
) -> io::Result<()> {
    let mut buffer = vec![0u8; 8 * 1024 * 1024];
    while remaining > 0 {
        let buffer_len = buffer.len() as u64;
        let read_len =
            reader.read(&mut buffer[..cmp::min(remaining, buffer_len) as usize])?;
        if read_len == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "读取到意外的文件结束",
            ));
        }
        writer.write_all(&buffer[..read_len])?;
        remaining -= read_len as u64;
        progress(read_len as u64);
    }
    Ok(())
}

fn emit_progress(
    app: &AppHandle,
    phase: &str,
    processed_bytes: u64,
    total_bytes: u64,
    part_index: usize,
    part_total: usize,
    message: String,
) {
    let payload = ProgressPayload {
        phase: phase.to_string(),
        processed_bytes,
        total_bytes,
        part_index,
        part_total,
        message,
    };
    let _ = app.emit("split-progress", payload);
}

#[derive(Debug, Clone)]
struct PartInfo {
    index: usize,
    path: PathBuf,
}

#[derive(Debug)]
struct PartGroup {
    prefix: String,
    parts: Vec<PartInfo>,
}

fn parse_part_name(name: &str) -> Option<(String, usize, String)> {
    let part_pos = name.rfind("part-")?;
    let digits_start = part_pos + "part-".len();
    let mut digits_end = digits_start;
    for (offset, ch) in name[digits_start..].char_indices() {
        if ch.is_ascii_digit() {
            digits_end = digits_start + offset + ch.len_utf8();
        } else {
            break;
        }
    }
    if digits_end == digits_start {
        return None;
    }
    let digits = &name[digits_start..digits_end];
    let index = digits.parse::<usize>().ok()?;
    let prefix = name[..part_pos].to_string();
    let suffix = name[digits_end..].to_string();
    Some((prefix, index, suffix))
}

fn collect_part_group(input_path: &Path) -> Result<PartGroup, String> {
    if input_path.is_file() {
        let name = input_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "无法解析分片文件名".to_string())?;
        let (prefix, _, suffix) =
            parse_part_name(name).ok_or_else(|| "无法识别分片文件名".to_string())?;
        let dir = input_path
            .parent()
            .ok_or_else(|| "无法解析分片目录".to_string())?;
        let parts = collect_part_group_from_dir(dir, Some((&prefix, &suffix)))?;
        return Ok(PartGroup { prefix, parts });
    }

    if input_path.is_dir() {
        let parts = collect_part_group_from_dir(input_path, None)?;
        if parts.is_empty() {
            return Err("未找到分片文件".to_string());
        }
        let (prefix, _) = parts
            .first()
            .and_then(|part| {
                part.path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .and_then(|name| parse_part_name(name).map(|(p, _, s)| (p, s)))
            })
            .ok_or_else(|| "无法识别分片文件名".to_string())?;
        return Ok(PartGroup { prefix, parts });
    }

    Err("输入路径不是文件或目录".to_string())
}

fn collect_part_group_from_dir(
    dir: &Path,
    filter: Option<(&String, &String)>,
) -> Result<Vec<PartInfo>, String> {
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut groups: HashMap<(String, String), Vec<PartInfo>> = HashMap::new();

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|value| value.to_str()) {
            Some(name) => name,
            None => continue,
        };
        let Some((prefix, index, suffix)) = parse_part_name(name) else {
            continue;
        };

        if let Some((filter_prefix, filter_suffix)) = filter {
            if &prefix != filter_prefix || &suffix != filter_suffix {
                continue;
            }
        }

        groups
            .entry((prefix.clone(), suffix.clone()))
            .or_default()
            .push(PartInfo { index, path });
    }

    if groups.is_empty() {
        return Err("未找到分片文件".to_string());
    }
    if groups.len() > 1 && filter.is_none() {
        return Err("检测到多组分片，请选择具体的分片文件".to_string());
    }

    let mut parts = if let Some((filter_prefix, filter_suffix)) = filter {
        groups
            .remove(&(filter_prefix.clone(), filter_suffix.clone()))
            .unwrap_or_default()
    } else {
        groups.into_values().next().unwrap_or_default()
    };

    if parts.is_empty() {
        return Err("未找到分片文件".to_string());
    }

    parts.sort_by_key(|part| part.index);
    validate_part_sequence(&parts)?;
    Ok(parts)
}

fn validate_part_sequence(parts: &[PartInfo]) -> Result<(), String> {
    for (idx, part) in parts.iter().enumerate() {
        let expected = idx + 1;
        if part.index != expected {
            return Err(format!("分片序号不连续，缺少第 {} 份", expected));
        }
    }
    Ok(())
}

fn open_zip_file<'a>(
    archive: &'a mut ZipArchive<BufReader<File>>,
    index: usize,
    password: Option<&str>,
) -> Result<zip::read::ZipFile<'a, BufReader<File>>, String> {
    if let Some(password) = password {
        return archive
            .by_index_decrypt(index, password.as_bytes())
            .map_err(|decrypt_err| map_zip_error(decrypt_err, true));
    }
    archive.by_index(index).map_err(|err| map_zip_error(err, false))
}

fn map_zip_error(err: ZipError, had_password: bool) -> String {
    match err {
        ZipError::InvalidPassword => {
            if had_password {
                "解密失败，请确认密码".to_string()
            } else {
                "需要密码才能解包".to_string()
            }
        }
        _ => err.to_string(),
    }
}

fn is_zip_file(path: &Path) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut signature = [0u8; 4];
    let read_len = file.read(&mut signature).map_err(|e| e.to_string())?;
    if read_len < 4 {
        return Ok(false);
    }
    Ok(matches!(
        signature,
        [0x50, 0x4b, 0x03, 0x04] | [0x50, 0x4b, 0x05, 0x06] | [0x50, 0x4b, 0x07, 0x08]
    ))
}

fn restore_split_then_zip(
    app: &AppHandle,
    input_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
    auto_extract: bool,
) -> Result<RestoreResult, String> {
    let part_group = collect_part_group(input_path)?;
    let base_name = part_group.prefix.trim_end_matches('.').to_string();

    let mut parts_with_size = Vec::with_capacity(part_group.parts.len());
    for part in &part_group.parts {
        let file = File::open(&part.path).map_err(|e| e.to_string())?;
        let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        if archive.len() == 0 {
            return Err("分片压缩包为空".to_string());
        }
        if archive.len() > 1 {
            return Err("分片压缩包内包含多个文件".to_string());
        }
        let entry = open_zip_file(&mut archive, 0, password)?;
        if entry.is_dir() {
            return Err("分片压缩包内容异常".to_string());
        }
        parts_with_size.push((part.clone(), entry.size()));
    }

    let total_bytes: u64 = parts_with_size.iter().map(|(_, size)| *size).sum();
    let temp_path = output_dir.join(format!("{}.merge.tmp", base_name));
    let mut writer = BufWriter::new(File::create(&temp_path).map_err(|e| e.to_string())?);
    let mut processed = 0u64;

    for (idx, (part, size)) in parts_with_size.iter().enumerate() {
        emit_progress(
            app,
            "restore",
            processed,
            total_bytes,
            idx + 1,
            parts_with_size.len(),
            format!("合并第 {} 份", idx + 1),
        );
        let file = File::open(&part.path).map_err(|e| e.to_string())?;
        let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
        let mut entry = open_zip_file(&mut archive, 0, password)?;
        copy_n_with_progress(&mut entry, &mut writer, *size, |delta| {
            processed += delta;
            emit_progress(
                app,
                "restore",
                processed,
                total_bytes,
                idx + 1,
                parts_with_size.len(),
                "合并中".to_string(),
            );
        })
        .map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())?;

    let mut merged_name = base_name.clone();
    if is_zip_file(&temp_path)? && !merged_name.ends_with(".zip") {
        merged_name = format!("{}.zip", merged_name);
    }
    let merged_path = output_dir.join(&merged_name);
    if merged_path.exists() {
        fs::remove_file(&merged_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp_path, &merged_path).map_err(|e| e.to_string())?;

    let mut output_files = vec![merged_path.to_string_lossy().to_string()];
    let mut extracted_dir = None;

    if auto_extract && is_zip_file(&merged_path)? {
        let target_dir = output_dir.join(strip_zip_extension(&merged_name));
        unzip_file(app, &merged_path, &target_dir, password)?;
        extracted_dir = Some(target_dir.to_string_lossy().to_string());
        output_files.push(target_dir.to_string_lossy().to_string());
    }

    Ok(RestoreResult {
        merged_file: Some(merged_path.to_string_lossy().to_string()),
        extracted_dir,
        output_files,
    })
}

fn restore_zip_then_split(
    app: &AppHandle,
    input_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
    auto_extract: bool,
) -> Result<RestoreResult, String> {
    let part_group = collect_part_group(input_path)?;
    let mut zip_name = part_group.prefix.trim_end_matches('.').to_string();
    if !zip_name.ends_with(".zip") {
        zip_name = format!("{}.zip", zip_name);
    }
    let temp_path = output_dir.join(format!("{}.merge.tmp", zip_name));
    let mut writer = BufWriter::new(File::create(&temp_path).map_err(|e| e.to_string())?);
    let mut processed = 0u64;
    let mut total_bytes = 0u64;

    for part in &part_group.parts {
        let size = fs::metadata(&part.path).map_err(|e| e.to_string())?.len();
        total_bytes += size;
    }

    for (idx, part) in part_group.parts.iter().enumerate() {
        emit_progress(
            app,
            "merge",
            processed,
            total_bytes,
            idx + 1,
            part_group.parts.len(),
            format!("合并第 {} 份", idx + 1),
        );
        let mut reader = BufReader::new(File::open(&part.path).map_err(|e| e.to_string())?);
        let size = fs::metadata(&part.path).map_err(|e| e.to_string())?.len();
        copy_n_with_progress(&mut reader, &mut writer, size, |delta| {
            processed += delta;
            emit_progress(
                app,
                "merge",
                processed,
                total_bytes,
                idx + 1,
                part_group.parts.len(),
                "合并中".to_string(),
            );
        })
        .map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())?;

    let merged_path = output_dir.join(&zip_name);
    if merged_path.exists() {
        fs::remove_file(&merged_path).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp_path, &merged_path).map_err(|e| e.to_string())?;

    let mut output_files = vec![merged_path.to_string_lossy().to_string()];
    let mut extracted_dir = None;

    if auto_extract {
        let target_dir = output_dir.join(strip_zip_extension(&zip_name));
        unzip_file(app, &merged_path, &target_dir, password)?;
        extracted_dir = Some(target_dir.to_string_lossy().to_string());
        output_files.push(target_dir.to_string_lossy().to_string());
    }

    Ok(RestoreResult {
        merged_file: Some(merged_path.to_string_lossy().to_string()),
        extracted_dir,
        output_files,
    })
}

fn strip_zip_extension(name: &str) -> String {
    name.strip_suffix(".zip").unwrap_or(name).to_string()
}

fn unzip_file(
    app: &AppHandle,
    zip_path: &Path,
    output_dir: &Path,
    password: Option<&str>,
) -> Result<(), String> {
    fs::create_dir_all(output_dir).map_err(|e| e.to_string())?;
    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let total_entries = archive.len();
    let mut total_bytes = 0u64;

    for index in 0..total_entries {
        let entry = open_zip_file(&mut archive, index, password)?;
        total_bytes += entry.size();
    }

    let file = File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = ZipArchive::new(BufReader::new(file)).map_err(|e| e.to_string())?;
    let mut processed = 0u64;
    let total_entries = archive.len();

    for index in 0..total_entries {
        let mut entry = open_zip_file(&mut archive, index, password)?;
        let Some(name) = entry.enclosed_name().map(|value| value.to_path_buf()) else {
            continue;
        };
        let out_path = output_dir.join(name);
        if entry.is_dir() || entry.name().ends_with('/') {
            fs::create_dir_all(&out_path).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        emit_progress(
            app,
            "unzip",
            processed,
            total_bytes,
            index + 1,
            total_entries,
            "解压中".to_string(),
        );

        let mut writer = BufWriter::new(File::create(&out_path).map_err(|e| e.to_string())?);
        let size = entry.size();
        copy_n_with_progress(&mut entry, &mut writer, size, |delta| {
            processed += delta;
            emit_progress(
                app,
                "unzip",
                processed,
                total_bytes,
                index + 1,
                total_entries,
                "解压中".to_string(),
            );
        })
        .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![process_file, restore_parts])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
