# 各国天级任务全员加急

已确认规则：TikTok 天级任务按国家当地日期检查前一天的数据；完成截止为当地 13:10，印尼为雅加达 15:10。未成功完成（包括运行、失败、暂停、停止、未开始）额外发送一条群消息并 @所有人，对同一条消息向群内用户发送应用内加急＋短信。欧洲超时未开始阈值统一为北京时间 15:40；其余国家保留当地 02:10。沿用当前看板国家和通知群。

采用独立每分钟检查器，避免现有每日四次看板推送错过国家截止时间。相比绑定看板推送，独立检查可以准点发现；相比增加 DS 调度任务，部署和状态管理仍留在 bot。现有看板与检查器共用截止时间，欧洲文案明确显示北京时间 15:40。

以国家、当地数据日、告警类型去重；同一轮异常汇总为一条消息。状态以原子 JSON 写入 .data，在任何飞书请求之前标记所有本轮检查项，确保发送失败或进程重启也不再次尝试。仅记录已检查项，不保留待发送队列。成员读取、消息发送或加急失败只记日志，不重试、不补发。超过 200 人时各批只尝试一次，失败批次不影响后续批次。旧版 pending 队列丢弃并标记对应检查项，避免补发过时告警。同一存储保留时进程重启可去重，ECS 换容器的临时磁盘不保证保留去重记录。

数据查询基于工作流 globalParams 的 country_code/data_date，独立于北京时间当日实例名称，覆盖美洲跨北京时间午夜和夏令时。查询失败、详情缺失或分页未完整读取时不把国家误报为未开始。检查最新实例，仅 SUCCESS 视为完成。

飞书操作使用 bot 身份、现有 profile。完整分页获取通知群内的真实用户成员，排除机器人和群外用户；消息首行使用文本消息的 @所有人 标签，超过 200 人分批调用短信加急（urgent_sms）。短信加急本身包含应用内加急，不重复调用 urgent_app，不调用 urgent_phone。群成员列表不完整或权限失败时只记日志，不伪报全员成功，也不再次发送。消息发送保留 API 幂等键，但不安排重试。所需权限为群成员读取和短信加急（im:message.urgent:sms 或 im:message.urgent:sms_send），群须允许机器人 @所有人。

验证覆盖欧洲 15:39/15:40、当地 13:09/13:10、印尼 15:09/15:10、跨日和夏令时、成功不提醒、各种未完成状态、无实例、重启去重、查询失败、失败不重试、旧队列不补发、独立告警各一次、成员分页和超过 200 人分批。禁止向真实群发送测试加急。

查询使用近三天至次日的 DS startDate/endDate 范围；整轮查询默认 45 秒超时（query_timeout_ms 可调整）。参数按开始时间筛选的依据是 [Apache DolphinScheduler 3.2.2 mapper](https://github.com/apache/dolphinscheduler/blob/3.2.2/dolphinscheduler-dao/src/main/resources/org/apache/dolphinscheduler/dao/mapper/ProcessInstanceMapper.xml)。

用户追加要求：截止告警 @群内所有人，改为应用内加急＋短信。继续保留所有截止延后十分钟、每国家/数据日/类型只尝试一次。依据：[飞书加急概述](https://open.feishu.cn/document/im-v1/buzz-messages/buzz-overview)、[消息内容结构](https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json.md)。
