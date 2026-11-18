# 字体 Fonts

这些字体文件随网站一起打包，播放时不需要联网。 These font files ship with the site, so it needs no internet for type.

| 文件 File | 字体 Font | 用途 Used for | 许可 Licence |
| --- | --- | --- | --- |
| `Fredoka-latin.woff2`, `Fredoka-latin-ext.woff2` | Fredoka (variable, 300–700) | 标题里的英文和数字 | SIL Open Font License 1.1 — © 2016 The Fredoka Project Authors |
| `ZCOOLKuaiLe-chinese-simplified.woff2` | 站酷快乐体 ZCOOL KuaiLe | 标题里的中文 | SIL Open Font License 1.1 — © 2018 The ZCOOL KuaiLe Project Authors |
| `ZCOOLKuaiLe-extra.woff2` | 站酷快乐体 ZCOOL KuaiLe（补字） | 常用字子集里没有的字：鲐 | 同上 |
| `Nunito-latin.woff2`, `Nunito-latin-ext.woff2` | Nunito (variable, 200–1000) | 正文里的英文和数字 | SIL Open Font License 1.1 — © 2014 The Nunito Project Authors |

正文里的中文用设备自带的中文字体（苹方、微软雅黑、思源黑体等），没有打包：一套完整的中文正文字体有十几 MB。

站酷快乐体这份文件包含约 6000 个常用简体字。照片说明里如果用到生僻字，那个字会用设备自带字体显示。

文件来自 npm 上的 Fontsource 包（`@fontsource-variable/fredoka`、`@fontsource-variable/nunito`、`@fontsource/zcool-kuaile`，均为 5.3.0）。
