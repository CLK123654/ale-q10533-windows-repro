# 搜索建议更新材料

data/query_events.jsonl是搜索运营导出的本次业务查询事件，包含语种、原始词、曝光、点击和事件时刻。

data/normalization_rules.json记录本批次的参考时刻、衰减参数、每个语种的建议数量与查询别名。data/sensitive_terms.csv是合规团队维护的压制词和分类。三份文件共同决定本次排名和压制结果。

将完成的Node.js程序保存到output/build_suggestions.mjs。在input_data目录执行npm run process，程序将三份业务结果写入同级output/reports。
