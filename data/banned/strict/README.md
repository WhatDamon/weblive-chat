# strict 扩展词表（默认不加载）

`BANNED_WORDS_MODE=strict` 时，本目录下的 `*.txt` 会与 `basic/` 一并装载；`basic` 与 `off` 模式下本目录被完全忽略。

仓库**不内置**这些词表，原因有三：体量（单个文件可达 5 万+ 行）、误伤率，以及政治类词表的启用属于部署方的合规判断。

## 获取方式

以 Sensitive-lexicon（MIT）为例：

```bash
git clone --depth 1 https://github.com/konsheng/Sensitive-lexicon.git /tmp/sl
cp /tmp/sl/Vocabulary/政治类型.txt \
   /tmp/sl/Vocabulary/反动词库.txt \
   /tmp/sl/Vocabulary/暴恐词库.txt \
   data/banned/strict/
```

可选的分类文件与体量：

| 文件 | 行数 | 说明 |
|---|---|---|
| 政治类型.txt | 326 | 政治类 |
| 反动词库.txt | 557 | 政治类 |
| 民生词库.txt | 571 | 民生/群体事件 |
| 贪腐词库.txt | 244 | 贪腐/时政 |
| GFW补充词库.txt | 6414 | 翻墙/网络封锁 |
| 暴恐词库.txt | 178 | 含宗教组织名，误伤风险较高 |
| 网易前端过滤敏感词库.txt | 7746 | 大表，短词多 |
| 零时-Tencent.txt | 53308 | 大表，短词与常见组合多 |

## 使用注意

- 两份大表（网易 / Tencent）含大量短词与常见组合，**启用前请抽样人工复核**，并配合 `BANNED_WORDS_ALLOW` 处理误伤
- 自建词库不等于合规：面向中国大陆公众提供 UGC 服务还涉及备案与平台责任，必要时叠加云内容安全复核
- 词库会随语境变化，建议定期重新拉取并复核（本目录文件随代码一起部署，改完需重新部署）
