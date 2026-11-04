[English](README.md) | 繁體中文

# Bellwether 領頭羊

Herdr 的股票與加密貨幣自選清單。它停靠在 agent 旁邊，顯示每檔標的的價格、漲跌幅與當日走勢線，點一下即可查看該標的當天的詳細資料。停靠成矮長條時，會變成單行報價列。報價來自 Yahoo Finance 與 Binance，僅供參考。

## 語言與顏色

介面提供 English、繁體中文、简体中文、日本語與 한국어。在你做出選擇前，新增欄位上方會顯示一行 `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`：點選語言即可切換，按 `×`（或新增一檔標的）則維持英文。這行不會再出現。語言完全由你決定，不會依所看的市場或系統語言而改變。四種亞洲語言預設紅漲綠跌，英文預設綠漲紅跌。

## 網路與儲存

Bellwether 只對 `query1.finance.yahoo.com` 與 `data-api.binance.vision` 發出唯讀請求，不執行任何程式。自選清單存於 Herdr 共享狀態的 `bellwether.watchlist.v1`，設定（語言、顏色、是否已回應語言列）存於 `bellwether.settings.v1`。

## 致謝

Bellwether 修改自 [fatwang2/Pulse](https://github.com/fatwang2/Pulse)（MIT）中的 Herdr mod，與 Pulse 無關，亦未獲其背書。
