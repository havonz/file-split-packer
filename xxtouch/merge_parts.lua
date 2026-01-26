-- XXTouch module: merge split parts and unzip
-- Usage:
-- local m = require("merge_parts")
-- local ok, out = m.restore({
--   mode = "split-then-zip", -- or "zip-then-split"
--   input_dir = "/path/to/parts",
--   base = "video.mp4",
--   output_dir = "/path/to/output",
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

local function join_path(dir, name)
  if file and file.path and file.path.add_component then
    return file.path.add_component(dir, name)
  end
  if dir:sub(-1) == "/" then
    return dir .. name
  end
  return dir .. "/" .. name
end

local function list_parts(input_dir, base, mode)
  local names = file.list(input_dir) or {}
  local parts = {}
  local base_pattern = escape_lua_pattern(base)
  local pattern
  if mode == "split-then-zip" then
    pattern = "^" .. base_pattern .. "%.(%d+)%.zip$"
  elseif mode == "zip-then-split" then
    pattern = "^" .. base_pattern .. "%.zip%.(%d+)$"
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
  local output_dir = opts.output_dir or input_dir
  local base = opts.base
  local password = opts.password
  local chunk_size = opts.chunk_size or 1024 * 1024 * 4
  local temp_dir = opts.temp_dir or join_path(output_dir, "_xxt_parts")
  local keep_temp = opts.keep_temp

  if not input_dir or not base then
    return nil, "input_dir and base are required"
  end

  local ok, err = ensure_dir(output_dir)
  if not ok then
    return nil, err
  end
  ok, err = ensure_dir(temp_dir)
  if not ok then
    return nil, err
  end

  local parts, list_err = list_parts(input_dir, base, "split-then-zip")
  if not parts or #parts == 0 then
    return nil, list_err or "no parts found"
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
    part_paths[#part_paths + 1] = join_path(temp_dir, base .. "." .. part.label)
  end

  local output_path = join_path(output_dir, base)
  log("merge to:", output_path)
  local merged_ok, merged_err = concat_files(part_paths, output_path, chunk_size)
  if not merged_ok then
    return nil, merged_err or "merge failed"
  end

  if not keep_temp then
    file.remove(temp_dir)
  end

  return true, output_path
end

local function restore_zip_then_split(opts)
  local input_dir = opts.input_dir
  local output_dir = opts.output_dir or input_dir
  local base = opts.base
  local password = opts.password
  local chunk_size = opts.chunk_size or 1024 * 1024 * 4
  local temp_zip = opts.temp_zip or join_path(output_dir, base .. ".zip")
  local keep_zip = opts.keep_zip

  if not input_dir or not base then
    return nil, "input_dir and base are required"
  end

  local ok, err = ensure_dir(output_dir)
  if not ok then
    return nil, err
  end

  local parts, list_err = list_parts(input_dir, base, "zip-then-split")
  if not parts or #parts == 0 then
    return nil, list_err or "no parts found"
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

  return true, join_path(output_dir, base)
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
