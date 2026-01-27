-- XXTouch module: merge split parts and unzip
-- Usage:
-- local merge_parts = require("merge_parts")
-- local ok, out = merge_parts.restore({
--   mode = "split-then-zip", -- or "zip-then-split"
--   file_list = {"/path/parts/video.mp4.part-0001.zip", "/path/parts/video.mp4.part-0002.zip"},
--   base = "video.mp4", -- optional if file_list is provided
--   output_file = "/path/output/video.mp4",
--   output_dir = "/path/output", -- optional if output_file is provided
--   password = "1234", -- optional
-- })

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

M.restore_split_then_zip = restore_split_then_zip
M.restore_zip_then_split = restore_zip_then_split

return M
