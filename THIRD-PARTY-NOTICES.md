# 第三方组件说明

本项目自身以 **AGPL-3.0-only** 发布。下面列出随仓库分发的第三方代码。

## @applemusic-like-lyrics/core

- 版本：0.6.0
- 许可证：**AGPL-3.0-only**
- 来源：<https://github.com/amll-dev/applemusic-like-lyrics>
- npm：<https://www.npmjs.com/package/@applemusic-like-lyrics/core>
- 在本仓库中的形式：`site/vendor/amll-core.js`（用 esbuild 打成的 IIFE，导出 `window.AMLL`）与
  `site/vendor/amll-core.css`，由 `scripts/build-amll.mjs` 生成
- 说明：逐字歌词播放器。因为它以 AGPL 分发，本项目整体也采用 AGPL-3.0。
  完整许可证文本见 [LICENSE](LICENSE)（与 AMLL 的 LICENSE 相同）。

## qrcode-generator

- 作者：Kazuhiko Arase
- 许可证：MIT
- 来源：<https://github.com/kazuhikoarase/qrcode-generator>
- 在本仓库中的形式：`site/js/qrcode.js`，用于扫码登录

MIT 许可证文本：

```
The MIT License (MIT)

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 其它

- 图标：Google [Material Symbols](https://fonts.google.com/icons)（Apache-2.0），以 SVG 路径内联在 HTML 中
- 音乐、歌词、封面等数据来自网易云音乐公开接口，版权归原权利人所有，不在本许可证范围内
