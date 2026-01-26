# File Split Packer

大文件切分 + Zip 打包工具，支持两种切分方式与两种打包流程：

- 先分割后逐个压缩：`filename.001.zip`
- 先压缩然后分割：`filename.zip.001`

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
