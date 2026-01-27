use serde::{Deserialize, Serialize};
use std::{
    cmp,
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};
use zip::{write::FileOptions, AesMode, CompressionMethod, ZipWriter};

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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitResult {
    parts: usize,
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

fn process_file_blocking(app: &AppHandle, options: SplitOptions) -> Result<SplitResult, String> {
    let input_path = PathBuf::from(options.input_path);
    let output_dir = PathBuf::from(options.output_dir);

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
        ),
        _ => Err("未知的打包方式".to_string()),
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
) -> Result<SplitResult, String> {
    let input_file = File::open(input_path).map_err(|e| e.to_string())?;
    let total_size = input_file.metadata().map_err(|e| e.to_string())?.len();
    if total_size == 0 {
        return Err("输入文件大小为 0，无法切分".to_string());
    }

    let (chunk_size, parts) = compute_parts(total_size, split_by, size_bytes, count)?;
    let base_name = file_base_name(input_path)?;
    let parts_dir = output_dir.join(format!("{}.parts", base_name));
    fs::create_dir_all(&parts_dir).map_err(|e| e.to_string())?;
    let width = cmp::max(3, parts.to_string().len());

    let mut reader = BufReader::new(input_file);
    let mut output_files = Vec::with_capacity(parts);
    let mut processed = 0u64;

    for part_index in 1..=parts {
        let remaining = total_size.saturating_sub(processed);
        let part_size = cmp::min(chunk_size, remaining);
        if part_size == 0 {
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
        let options = build_file_options(password);
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

    Ok(SplitResult { parts, output_files })
}

fn zip_then_split(
    app: &AppHandle,
    input_path: &Path,
    output_dir: &Path,
    split_by: &str,
    size_bytes: Option<u64>,
    count: Option<u64>,
    password: Option<&str>,
) -> Result<SplitResult, String> {
    let input_file = File::open(input_path).map_err(|e| e.to_string())?;
    let total_size = input_file.metadata().map_err(|e| e.to_string())?.len();
    if total_size == 0 {
        return Err("输入文件大小为 0，无法切分".to_string());
    }

    let base_name = file_base_name(input_path)?;
    let parts_dir = output_dir.join(format!("{}.parts", base_name));
    fs::create_dir_all(&parts_dir).map_err(|e| e.to_string())?;
    let zip_path = output_dir.join(format!("{}.zip", base_name));
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
    let options = build_file_options(password);
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
        if part_size == 0 {
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

    Ok(SplitResult { parts, output_files })
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
            let chunk_size = div_ceil(total_size, count);
            let parts = div_ceil(total_size, chunk_size) as usize;
            Ok((chunk_size, parts))
        }
        _ => Err("未知的切分方式".to_string()),
    }
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

fn build_file_options<'a>(password: Option<&'a str>) -> FileOptions<'a, ()> {
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    if let Some(password) = password {
        options.with_aes_encryption(AesMode::Aes256, password)
    } else {
        options
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![process_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
