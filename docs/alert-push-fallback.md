# DS 告警：拉取默认；Webhook 预留

## 当前默认（推荐）

- **拉取为主**：`alert_watch` 约每 90s 扫 FAILURE → 飞书卡  
- **`ds_alert_webhook.enabled: false`**：不监听推送口  

消耗很小（几次 DS HTTP）；本机 bot 在线即可。

## 预留：推送为主 + 拉取兜底

代码与配置项已保留。将来要启用时：

```json
"ds_alert_webhook": {
  "enabled": true,
  "prefer_push": true,
  "port": 18766,
  "bind": "127.0.0.1",
  "path": "/ds-alert",
  "token": ""
},
"alert_watch": {
  "enabled": true,
  "fallback_interval_seconds": 600
}
```

此时轮询自动改为兜底间隔（默认 600s）。接收端：

```text
POST http://127.0.0.1:18766/ds-alert
Authorization: Bearer <token>
```

Token：配置 / `DS_ALERT_WEBHOOK_TOKEN` / 首次启动写入 `.data/ds-alert-webhook-token.txt`。

云端 DS 需隧道或中转才能打到本机；未接通前不要开 `enabled`。
