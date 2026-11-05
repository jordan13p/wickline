<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" width="96" alt="Bellwether">
  </picture>
</p>

<h1 align="center">Bellwether</h1>

<p align="center">在 Herdr 的 agent 旁看盤：哪些是即時、哪些是延遲，一眼分清楚。</p>

<p align="center"><a href="README.md">English</a> · 繁體中文</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License: MIT"></a>
  <a href="https://herdr.dev/mods"><img src="https://img.shields.io/badge/Herdr-mod-555" alt="Herdr mod"></a>
  <a href="https://github.com/jordan13p/bellwether/actions/workflows/checks.yml"><img src="https://github.com/jordan13p/bellwether/actions/workflows/checks.yml/badge.svg" alt="checks"></a>
</p>

![Bellwether](preview.png)

## 特色

- 每個市場各有來源：股票與指數用 Yahoo Finance，加密貨幣用 Binance Spot；台股（證交所 MIS）與美股（Finnhub，用你自己的 key）的即時報價需自行開啟。
- 即時或延遲一眼可辨：每一列都標示價格來源與新舊程度，延遲或快取的價格絕不會看起來像即時。
- 五種介面語言：English、繁體中文、简体中文、日本語與 한국어，可選紅漲綠跌或綠漲紅跌。
- 拖曳列即可調整順序，每個開啟的 copy 立即同步。
- 不執行程式、沒有遙測、沒有中繼伺服器：請求直接從你的電腦送到各個來源。
- 跟隨你的 Herdr 佈景主題（淺色或深色）；版面依寬度而定：寬度小於 720 px 是側邊欄，720 px 以上是表格（在自己的分頁中開啟時會很寬），高度小於 72 px 時是單行報價列。

## 市場與資料來源

| 市場 | 預設 | 可選即時來源 | 說明 |
|---|---|---|---|
| 美股 | Yahoo Finance（延遲） | Finnhub，需你自己的 API key | 預設額度每分鐘 60 次時，Finnhub 提供清單中前 15 檔美股的報價，其餘仍用 Yahoo。 |
| 台股 | Yahoo Finance（延遲 20 分鐘） | 證交所 MIS，同意後才會開啟 | MIS 為非官方來源；超出該股當日漲跌停範圍的價格會被捨棄，該列改顯示 Yahoo。 |
| 港股、陸股、日股、韓股 | Yahoo Finance（延遲） | — | 延遲時間依交易所而定，Yahoo 通常不回報。 |
| 加密貨幣 | Binance Spot（即時） | — | 部分地區（例如美國）無法使用 Binance；可改設提供相同 API 的其他網址。 |

每一列都有一個圓點和一個標籤：

- **實心圓點**：即時。即時來源、市場交易中，且報價在 120 秒內（`Binance Spot`、`證交所 MIS`、`Finnhub`）。
- **空心圓圈**：延遲或停滯。Yahoo 的報價（`延遲 20 分鐘`、`Yahoo · 延遲`）、超過 120 秒的即時報價（`報價停在 13:05`），或尚不知道交易時段。
- **無圓點**：市場已收盤或不在一般交易時段（`已收盤 · 10/31 16:00`、`盤前`、`盤後`）。

每個來源各自更新：Yahoo 每 60 秒，Binance 每 15 秒，證交所 MIS 在台股交易時每 10 秒，Finnhub 在美股交易時每檔約每 30 秒。失敗或被限制頻率的來源會暫緩並在該列說明原因，其他來源照常更新。

## 安裝

在 Herdr 中請 agent 執行：

```text
Read ~/.config/herdr-app/AGENTS.md, then add this mod: https://github.com/jordan13p/bellwether
```

agent 會先告訴你 Bellwether 會連線到哪些主機，再複製 mod、合併它的 `keys.json`（取代你已在使用的按鍵前會先詢問）並檢查。

<details>
<summary>手動安裝</summary>

1. 將 `mods/bellwether/` 複製到 `~/.config/herdr-app/mods/bellwether/`。它的 `mod.json` 是 `"place": "none"`，所以你的 layout 不會被改動。
2. 將本 repo `keys.json` 中的那一行加到 `~/.config/herdr-app/keys.json` 的 `global` 區段。編輯過這個檔案後，它就算是你自己的：Herdr 升級時不會再自動加入新的預設快捷鍵。
3. 檢查：

   ```sh
   herdr-app check ~/.config/herdr-app/mods/bellwether
   ```

4. 按 `ctrl-alt-b` 開啟；不用快捷鍵時，在 Herdr 的 `main` layout 或你自己的 layout 執行：

   ```sh
   herdr-app do pane.split --direction right --mod bellwether
   ```

</details>

## 使用方式

在新增欄位輸入代號後按 Enter：

| 代號 | 市場 |
|---|---|
| `AAPL` | 美股 |
| `^GSPC` | 指數（S&P 500） |
| `2330.TW` | 台股上市（上櫃用 `.TWO`） |
| `0700.HK` | 港股（輸入 `700.HK` 也可以） |
| `7203.T` | 日股 |
| `BTC/USDT` | Binance 加密貨幣交易對，格式為 `BASE/QUOTE` |

- **移除**：滑鼠移到某一列，按右側的 `×`。
- **調整順序**：滑鼠移到某一列，按住左側的六點把手拖曳；強調色線會標出落點。拖出清單即取消。
- **詳細資料**：點一下某一列即可查看當天的走勢圖、開盤、最高、最低與昨收、交易時段、報價時間與取得時間。
- **重新整理與暫停**：標題列的圖示。重新整理會讓 Finnhub 以外的每個來源立即更新一輪，暫停時也可以；暫停會停止每個 copy 的自動更新。
- **快捷鍵**：Bellwether 接受 `bellwether.refresh` 與 `bellwether.pause` 兩個指令，預設都沒有綁定。要綁定時，加到 `~/.config/herdr-app/keys.json`：

  ```json
  { "global": { "ctrl-alt-r": "bellwether.refresh" } }
  ```

### 開啟與關閉

- `ctrl-alt-b` 會在目前 focus 的終端機右側開一個 Bellwether pane，任何 layout 皆適用。再按一次會多開一個 copy，而每個 copy 都會各自發出請求，所以請只開一個。
- 要改按鍵，把 `~/.config/herdr-app/keys.json` `global` 區段中的 `ctrl-alt-b` 改掉；不要這個按鍵，就刪掉那一行。不用快捷鍵時：`herdr-app do pane.split --direction right --mod bellwether`。
- 關閉方式和其他 pane 一樣：用 Herdr 的 pane 標題列，或執行 `pane.close`。
- 標題列的 **在自己的分頁開啟** 圖示會把 Bellwether 移到名為 `Bellwether` 的分頁，那裡夠寬，會顯示表格；在那裡按 **回到側邊**，會把它放回原分頁中某個 pane 的右側並關閉該分頁。無論哪種方式，都只有一個 copy 在抓報價。
- 放大（zoom）交給 Herdr 自己的 pane 標題列；Bellwether 沒有自己的放大功能。

## 設定

齒輪圖示會開啟設定對話框，共三個分頁。按「儲存」前不會有任何變更，按「取消」或 Esc 會捨棄修改。

**資料來源。** Yahoo Finance 與 Binance Spot 不需要任何設定。「美股」卡片可將美股改用 Finnhub，需填入你自己的 API key（免費方案即可）、每分鐘請求數，並顯示可涵蓋的檔數。「台股」卡片在你閱讀責任聲明並勾選同意後，可將台股改用證交所 MIS。「加密貨幣」卡片可改設其他 Binance 網址（限 `https://`）。

**顯示。** 介面語言（只改變介面文字，不影響報價）、漲跌顏色（依語言自動、紅漲綠跌或綠漲紅跌），以及開啟 Herdr 外觀設定的按鈕；淺色與深色主題由 Herdr 設定。

**免責聲明與隱私。** 完整免責聲明、各來源報價的意思，以及下方列出的連線主機、程式與儲存位置。面板底部那一行免責聲明會開啟這個分頁。

## 隱私與安全

連線主機與連線時機：

| 主機 | 時機 |
|---|---|
| `query1.finance.yahoo.com` | 一律，用於股票與指數 |
| `data-api.binance.vision`，或你設定的 Binance 網址 | 一律，用於加密貨幣交易對 |
| `mis.twse.com.tw`，或你設定的 MIS 網址 | 只有在你將台股改為證交所 MIS 並勾選同意後（非官方） |
| `finnhub.io`，或你設定的 Finnhub 網址 | 只有在你將美股改為 Finnhub 並儲存 API 金鑰後；金鑰放在請求標頭中，不會出現在網址裡 |

- **程式**：不執行任何程式。
- **儲存**：自選清單存於 Herdr 共用狀態的 `bellwether.watchlist.v1`，設定存於 `bellwether.settings.v1`。你儲存的 Finnhub API 金鑰以明文存放在這台電腦上 Herdr 資料夾內的 `data/bellwether/secrets.json`，不會寫入共用狀態；能讀取你檔案的人都能看到它，所以請使用免費方案的 API 金鑰。不讀寫其他檔案。
- **Finnhub**：只會查詢額度所能涵蓋的前幾檔美股（預設每分鐘 60 次即 15 檔）。每個開啟的 copy 都會各自發出請求，開兩個 copy 額度就會用得快一倍。
- 沒有遙測、沒有分析、沒有中繼伺服器：請求直接從這台電腦送到各個來源。
- 請只開一個 Bellwether。每個 copy（即使被隱藏）都會跑自己的更新迴圈，開第二個就會讓所有請求加倍。

## 常見問題

**為什麼我的台股報價晚了 20 分鐘？** Yahoo Finance 的台股報價延遲 20 分鐘，Bellwether 會在每一列台股標示 `延遲 20 分鐘`。要看即時台股價格，請在設定中開啟證交所 MIS。

**為什麼證交所 MIS 預設關閉？** 開啟前，設定中會顯示以下責任聲明（以繁體中文版為準），你必須勾選同意才能使用：

> 證交所 MIS（mis.twse.com.tw）是臺灣證券交易所的基本市況報導網站，並非提供給第三方程式使用的 API。Bellwether 與臺灣證券交易所無任何關聯，亦未獲其授權。啟用後，Bellwether 會從這台電腦直接向 MIS 查詢你清單中的台股（開盤期間約每 10 秒一次），取代延遲約 20 分鐘的 Yahoo 價格；走勢圖仍來自 Yahoo。MIS 資料可能延遲、錯誤或中斷，也可能隨時變更或停止提供。Bellwether 會捨棄超出該股當日漲跌停範圍的價格，但無法保證其他價格正確。是否使用 MIS、使用方式是否符合臺灣證券交易所網站的使用條款，以及使用其資料的一切後果，均由你自行判斷並負責。資料僅供個人參考，不構成投資建議。

**為什麼美股只有 15 檔即時報價？** Finnhub 免費方案每分鐘可發 60 次請求。Bellwether 提供即時報價的美股檔數是額度除以 4，因此每檔約每 30 秒更新一次，並留一半額度給重試與第二個 copy。清單中靠前的美股使用 Finnhub，其餘顯示 Yahoo 並標示超出上限。若你的方案允許，可在設定中調高每分鐘請求數。

**為什麼我無法使用 Binance？** Binance 會拒絕部分地區（例如美國）的請求，此時加密貨幣列會顯示此地區無法使用 Binance。股票不受影響。你可以在設定中改設提供相同 API 的其他 Binance 網址。

**Bellwether 會把我的自選清單傳到任何地方嗎？** 不會。每個代號只會作為請求的一部分，直接從你的電腦送到提供該報價的來源。沒有 Bellwether 伺服器，也沒有遙測；清單本身存放在這台電腦上 Herdr 的共用狀態中。

## 免責聲明

一般免責聲明以英文版為準。

報價來自第三方，不保證正確、即時或可用。此處顯示的任何內容均不構成投資建議。啟用非公開來源或輸入 API 金鑰，屬於你自己的行為，並受該來源的條款規範。請求直接從這台電腦送到各個來源。Bellwether 沒有伺服器，也不傳送任何遙測資料。你儲存的 Finnhub API 金鑰以明文存放在這台電腦上。

## 致謝與授權

Bellwether 修改自 [fatwang2/Pulse](https://github.com/fatwang2/Pulse)（MIT）中的 Herdr mod，與 Pulse 無關，亦未獲其背書。

以 [MIT License](LICENSE) 授權，著作權 (c) 2026 fatwang2 與 (c) 2026 jordan13p。

## 開發

```sh
node --test tests/
herdr-app check "$PWD/mods/bellwether"
```

`RECIPE.md` 是完整的建構說明：Bellwether 畫出什麼、如何運作，以及由哪些檔案組成。
