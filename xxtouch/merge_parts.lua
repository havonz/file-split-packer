--[[
XXTouch 模块：分包合并与解包

导出函数说明：
1) merge_parts.restore(opts)
   - 功能：根据 mode 自动选择合并方式。
   - opts:
     - mode: "split-then-zip" | "zip-then-split"
     - file_list: 分包路径列表（按顺序），提供后可不填 input_dir/base
     - input_dir: 分包目录（当未提供 file_list 时必填）
     - base: 基础文件名（当未提供 file_list 时必填）
       split-then-zip 对应原文件名；zip-then-split 对应原文件名（不含 .zip）
     - output_file: 输出文件路径（可选）
     - output_dir: 输出目录（可选，默认 input_dir / file_list[1] 所在目录 / "."）
     - password: 分包或 zip 的密码（可选）
     - chunk_size: 合并时的读写块大小（可选，默认 4MB）
     - temp_dir: split-then-zip 解压缓存目录（可选）
     - keep_temp: split-then-zip 是否保留解压缓存（可选）
     - temp_zip: zip-then-split 临时合并的 zip 路径（可选）
     - keep_zip: zip-then-split 是否保留临时 zip（可选）
   - 返回：ok, output_file 或 nil, err

2) merge_parts.restore_split_then_zip(opts)
   - 功能：解包每个分片 zip -> 合并成原文件。
   - 参数同 restore(opts)，mode 固定为 "split-then-zip"。
   - 返回：ok, output_file 或 nil, err

3) merge_parts.restore_zip_then_split(opts)
   - 功能：合并分片 -> 生成 zip -> 解压 -> 输出目标。
   - 参数同 restore(opts)，mode 固定为 "zip-then-split"。
   - 返回：ok, output_file 或 nil, err

4) merge_parts.verify_parts(file_list, part_sha256)
   - 功能：校验分包文件 SHA256 是否匹配。
   - file_list: 分包路径列表（按顺序）
   - part_sha256: SHA256 列表（按顺序，对应 file_list）
   - 返回：failed 列表（元素为失败分包的完整路径）；全部通过返回空表 {}
   - 注意：参数不合法会直接 error

使用示例：
local merge_parts = require("merge_parts")
local ok, out = merge_parts.restore({
  mode = "split-then-zip", -- 或 "zip-then-split"
  file_list = {"/path/parts/video.mp4.part-0001.zip", "/path/parts/video.mp4.part-0002.zip"},
  base = "video.mp4", -- 提供 file_list 时可省略
  output_file = "/path/output/video.mp4",
  output_dir = "/path/output", -- 提供 output_file 时可省略
  password = "1234", -- 可选
})
--]]

if sys.xtversion():compare_version("1.3.8-2025091400000") < 0 then
	error('merge_parts 模块仅支持 XXT 1.3.8-2025091400000 或更高版本')
	return
end

local M = {}

local function log(...)
  if type(nLog) == "function" then
    nLog(...)
  else
    print(...)
  end
end

local function escape_lua_pattern(text)
  return (text:gsub("(%W)", "%%%1"))
end

local function basename(path)
  if file and file.path and file.path.last_component then
    return file.path.last_component(path)
  end
  return path:match("([^/\\]+)$") or path
end

local function dirname(path)
  if file and file.path and file.path.remove_last_component then
    return file.path.remove_last_component(path)
  end
  local last = path:match("^.*()[/\\]")
  if not last then
    return "."
  end
  if last == 1 then
    return path:sub(1, 1)
  end
  return path:sub(1, last - 1)
end

local function join_path(dir, name)
  if file and file.path and file.path.add_component then
    return file.path.add_component(dir, name)
  end
  if dir:sub(-1) == "/" then
    return dir .. name
  end
  return dir .. "/" .. name
end

local function parse_part_name(name, mode)
  if mode == "split-then-zip" then
    local base, idx = name:match("^(.*)%.part%-(%d+)%.zip$")
    if base and idx then
      return base, tonumber(idx), idx
    end
  elseif mode == "zip-then-split" then
    local base, idx = name:match("^(.*)%.zip%.part%-(%d+)$")
    if base and idx then
      return base, tonumber(idx), idx
    end
  end
  return nil
end

local function parts_from_dir(input_dir, base, mode)
  local names = file.list(input_dir) or {}
  local parts = {}
  local base_pattern = escape_lua_pattern(base)
  local pattern
  if mode == "split-then-zip" then
    pattern = "^" .. base_pattern .. "%.part%-(%d+)%.zip$"
  elseif mode == "zip-then-split" then
    pattern = "^" .. base_pattern .. "%.zip%.part%-(%d+)$"
  else
    return nil, "unknown mode"
  end

  for _, name in ipairs(names) do
    local idx = name:match(pattern)
    if idx then
      parts[#parts + 1] = {
        index = tonumber(idx),
        name = name,
        path = join_path(input_dir, name),
        label = idx,
      }
    end
  end

  table.sort(parts, function(a, b)
    return a.index < b.index
  end)

  return parts
end

local function parts_from_list(file_list, mode, base)
  local parts = {}
  local inferred_base = base
  local mismatched = false

  for _, path in ipairs(file_list or {}) do
    local name = basename(path)
    local part_base, idx, label = parse_part_name(name, mode)
    if part_base and idx then
      if inferred_base and part_base ~= inferred_base then
        mismatched = true
      else
        inferred_base = inferred_base or part_base
        parts[#parts + 1] = {
          index = idx,
          name = name,
          path = path,
          label = label,
        }
      end
    end
  end

  if mismatched then
    return nil, "file_list contains mixed base names"
  end
  if not inferred_base then
    return nil, "cannot infer base from file_list"
  end
  if #parts == 0 then
    return nil, "no parts found"
  end

  table.sort(parts, function(a, b)
    return a.index < b.index
  end)

  return parts, inferred_base
end

local function resolve_parts(opts, mode)
  if opts.file_list then
    return parts_from_list(opts.file_list, mode, opts.base)
  end
  if not opts.input_dir or not opts.base then
    return nil, "input_dir and base are required (or provide file_list)"
  end
  local parts, err = parts_from_dir(opts.input_dir, opts.base, mode)
  if not parts or #parts == 0 then
    return nil, err or "no parts found"
  end
  return parts, opts.base
end

local function ensure_dir(path)
  if file.exists(path) then
    return true
  end
  local ok, err = file.mkdir_p(path, 0, 0, "0755")
  if not ok then
    return nil, err or "mkdir failed"
  end
  return true
end

local function concat_files(paths, output_path, chunk_size)
  local out, err = io.open(output_path, "wb")
  if not out then
    return nil, err
  end

  for _, path in ipairs(paths) do
    local input, in_err = io.open(path, "rb")
    if not input then
      out:close()
      return nil, in_err
    end
    while true do
      local data = input:read(chunk_size)
      if not data then
        break
      end
      out:write(data)
    end
    input:close()
  end

  out:flush()
  out:close()
  return true
end

local function verify_parts(file_list, part_sha256)
  local failed = {}
  if type(file_list) ~= "table" or type(part_sha256) ~= "table" then
    error("file_list and part_sha256 must be tables", 2)
    return failed
  end

  for index, path in ipairs(file_list) do
    local expected = part_sha256[index]
    if not expected then
      failed[#failed + 1] = path
    else
      expected = string.lower(expected)
      local hash = file.sha256(path)
      if not hash then
        failed[#failed + 1] = path
      else
        hash = string.lower(hash)
        if hash ~= expected then
          failed[#failed + 1] = path
        end
      end
    end
  end

  return failed
end

local function restore_split_then_zip(opts)
  local input_dir = opts.input_dir
  local output_dir = opts.output_dir
  local output_file = opts.output_file
  local password = opts.password
  local chunk_size = opts.chunk_size or 1024 * 1024 * 4
  local temp_dir = opts.temp_dir
  local keep_temp = opts.keep_temp

  local parts, base = resolve_parts(opts, "split-then-zip")
  if not parts then
    return nil, base
  end

  if output_file and not output_dir then
    output_dir = dirname(output_file)
  end
  if not output_dir then
    if input_dir then
      output_dir = input_dir
    elseif opts.file_list and opts.file_list[1] then
      output_dir = dirname(opts.file_list[1])
    else
      output_dir = "."
    end
  end

  if not output_file then
    output_file = join_path(output_dir, base)
  end

  if not temp_dir then
    temp_dir = join_path(output_dir, "_xxt_merge_parts_temp")
  end

  local ok, err = ensure_dir(output_dir)
  if not ok then
    return nil, err
  end
  ok, err = ensure_dir(temp_dir)
  if not ok then
    return nil, err
  end

  log("unzip parts:", #parts)
  for _, part in ipairs(parts) do
    local unzip_ok, unzip_err = file.unzip(part.path, temp_dir, password)
    if not unzip_ok then
      return nil, unzip_err or ("unzip failed: " .. part.path)
    end
  end

  local part_paths = {}
  for _, part in ipairs(parts) do
    part_paths[#part_paths + 1] = join_path(temp_dir, base .. ".part-" .. part.label)
  end

  log("merge to:", output_file)
  local merged_ok, merged_err = concat_files(part_paths, output_file, chunk_size)
  if not merged_ok then
    return nil, merged_err or "merge failed"
  end

  if not keep_temp then
    file.remove(temp_dir)
  end

  return true, output_file
end

local function restore_zip_then_split(opts)
  local input_dir = opts.input_dir
  local output_dir = opts.output_dir
  local output_file = opts.output_file
  local password = opts.password
  local chunk_size = opts.chunk_size or 1024 * 1024 * 4
  local temp_zip = opts.temp_zip
  local keep_zip = opts.keep_zip

  local parts, base = resolve_parts(opts, "zip-then-split")
  if not parts then
    return nil, base
  end

  if output_file and not output_dir then
    output_dir = dirname(output_file)
  end
  if not output_dir then
    if input_dir then
      output_dir = input_dir
    elseif opts.file_list and opts.file_list[1] then
      output_dir = dirname(opts.file_list[1])
    else
      output_dir = "."
    end
  end

  if not output_file then
    output_file = join_path(output_dir, base)
  end

  if not temp_zip then
    temp_zip = join_path(output_dir, base .. ".zip")
  end

  local ok, err = ensure_dir(output_dir)
  if not ok then
    return nil, err
  end

  local part_paths = {}
  for _, part in ipairs(parts) do
    part_paths[#part_paths + 1] = part.path
  end

  if file.exists(temp_zip) then
    file.remove(temp_zip)
  end

  log("merge zip:", temp_zip)
  local merged_ok, merged_err = concat_files(part_paths, temp_zip, chunk_size)
  if not merged_ok then
    return nil, merged_err or "merge failed"
  end

  local unzip_ok, unzip_err = file.unzip(temp_zip, output_dir, password)
  if not unzip_ok then
    return nil, unzip_err or "unzip failed"
  end

  if not keep_zip then
    file.remove(temp_zip)
  end

  local default_output = join_path(output_dir, base)
  if output_file ~= default_output then
    if file.exists(output_file) then
      file.remove(output_file)
    end
    local move_ok, move_err = file.move(default_output, output_file, "overwrite")
    if not move_ok then
      return nil, move_err or "move failed"
    end
  end

  return true, output_file
end

function M.restore(opts)
  local mode = opts.mode or "split-then-zip"
  if mode == "split-then-zip" then
    return restore_split_then_zip(opts)
  elseif mode == "zip-then-split" then
    return restore_zip_then_split(opts)
  end
  return nil, "unknown mode"
end

M.verify_parts = verify_parts
M.restore_split_then_zip = restore_split_then_zip
M.restore_zip_then_split = restore_zip_then_split

M._VERSION = "202602010027"
M._AUTHOR = "havonz"

return M
