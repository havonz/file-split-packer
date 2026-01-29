# File Split Packer

大文件切分 + Zip 打包/解包工具，支持分片打包与逆向合并解包：

- 先分割后逐个压缩：`filename.parts/filename.part-0001.zip`
- 先压缩然后分割：`filename.parts/filename.zip.part-0001`
- 逆向合并解包：自动识别分片并合并，可选合并后自动解压

## 软件作用

用于将大文件或目录切分为可分发的分片包（Zip），并在需要时将分片恢复为原始文件或目录。

## 开发

```bash
pnpm install
pnpm tauri dev
```

## 构建

```bash
pnpm tauri build -- --no-bundle
```

## 推荐开发环境

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
