[English](README.md) | 繁體中文

# Bellwether 領頭羊

Herdr 的股票與加密貨幣自選清單。它停靠在 agent 旁邊，顯示每檔標的的價格、漲跌幅與當日走勢線，點一下即可查看該標的當天的詳細資料。停靠成矮長條時，會變成單行報價列。報價來自 Yahoo Finance 與 Binance，僅供參考。

## 語言與顏色

介面提供 English、繁體中文、简体中文、日本語與 한국어。在你做出選擇前，新增欄位上方會顯示一行 `Language: English · 繁中 · 简中 · 日本語 · 한국어 ×`：點選語言即可切換，按 `×`（或新增一檔標的）則維持英文。這行不會再出現。語言完全由你決定，不會依所看的市場或系統語言而改變。四種亞洲語言預設紅漲綠跌，英文預設綠漲紅跌。

## 設定

面板標題列的「設定」按鈕會開啟設定對話框，共四個分頁；按「儲存」前不會有任何變更，按「取消」或 Esc 會捨棄你的修改。

- **資料來源**：股票與指數使用 Yahoo Finance（延遲報價，沒有可調整的項目），加密貨幣交易對使用 Binance Spot。部分地區（例如美國）可能無法使用 Binance，可將 Binance 網址改為提供相同 API 的其他網址。網址必須以 `https://` 開頭，否則無法儲存。
- **顯示**：漲跌顏色（依語言自動、紅漲綠跌或綠漲紅跌），整份清單不分市場一律套用；另有按鈕可開啟 Herdr 自己的外觀設定。Bellwether 本身沒有淺色／深色設定。
- **語言**：介面語言。
- **免責聲明與隱私**：完整免責聲明、連線主機與儲存位置。面板底部的免責聲明那一行會開啟這個分頁。

## 網路與儲存

Bellwether 只對 `query1.finance.yahoo.com` 與 `data-api.binance.vision` 發出唯讀請求，若你在設定中改用其他 Binance 網址，也會對該網址發出請求，不執行任何程式。自選清單存於 Herdr 共享狀態的 `bellwether.watchlist.v1`，設定（語言、顏色、是否已回應語言列、Binance 網址）存於 `bellwether.settings.v1`。不讀寫其他檔案。

## 致謝

Bellwether 修改自 [fatwang2/Pulse](https://github.com/fatwang2/Pulse)（MIT）中的 Herdr mod，與 Pulse 無關，亦未獲其背書。
