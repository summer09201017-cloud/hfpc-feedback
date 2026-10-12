# hfpc-feedback — 全艦隊共用「👍 按讚 + 留言(先待審)」Worker

線上:https://hfpc-feedback.summer09201017.workers.dev · 後台:/admin?key=<ADMIN_KEY>(密碼在使用者家目錄 `~/.hfpc-feedback-admin-key.txt`)
skill:`like-comment-kit`(hfpc-claude-skills)。任何站一行接入:

```html
<div id="hfpc-feedback"></div>
<script src="https://hfpc-feedback.summer09201017.workers.dev/widget.js" data-g="<作品id>" data-mode="free|kids" data-title="<作品名>" defer></script>
```

- `data-mode="kids"`:只能選預設短語、不收暱稱、不用 Turnstile(兒童站預設)。
- `data-mode="free"`:自由輸入 + 暱稱 + Turnstile;電話/Email/網址/帳號伺服器端退回。
- 留言一律 pending,後台放行才顯示;按讚每裝置一次(localStorage)+ 同 IP 雜湊 10 分鐘去重。

部署:`npx wrangler deploy`;建表:`npx wrangler d1 execute hfpc-feedback --remote --file schema.sql`;
密碼:`npx wrangler secret put ADMIN_KEY` / `TURNSTILE_SECRET`。Turnstile 網域清單:CF 後台 Turnstile → hfpc-feedback(新平台域名要加進去,否則 free 模式留言送不出)。
