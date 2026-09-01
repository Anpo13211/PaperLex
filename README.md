# PaperLex

PaperLex は、macOS の Preview で論文を読みながら使える個人用単語帳です。選択した単語に対して Apple 標準の「調べる」を実行すると、いつもの辞書パネルを表示したまま、その単語と辞書情報を自動保存します。

Apple 辞書の定義に加えて、Free Dictionary API / Wiktionary の英語定義と Tatoeba の例文を表示できます。ローカル版は Mac または同じ Wi-Fi 上のスマートフォンから、任意のプライベートクラウド版は Mac の停止中や別のネットワークからも復習できます。

## 主な機能

- Preview の右クリックメニューにある「“単語”を調べる」と連動して自動保存
- 予備の取り込み方法として「サービス > PaperLex に保存」を利用可能
- Mac で有効な Apple 辞書の日本語定義を、品詞・語義・派生語に整理して表示
- Free Dictionary API / Wiktionary の英語定義を出典付きで表示
- Tatoeba から最大 3 件の英語例文を自動取得
- 同じ単語を重複登録せず、出現回数と履歴を更新
- 単語、意味、例文、メモ、タグの検索と並べ替え
- `新着 / 学習中 / 覚えた` の復習状態を管理
- 自分の意味、例文、メモ、タグを追記
- スマートフォン対応 UI と JSON バックアップ
- 外部の辞書サービスが利用できない場合も、選択語そのものは保存

## 動作環境

- macOS 13 以降
- Preview
- [Node.js](https://nodejs.org/) 22.13 以降
- Xcode Command Line Tools（macOS 用ヘルパーのビルドに使用）
- Git

Node.js のバージョンは次のコマンドで確認できます。

```bash
node --version
```

Xcode Command Line Tools が未導入の場合は、次のコマンドでインストール画面を開きます。

```bash
xcode-select --install
```

## セットアップ

### 1. リポジトリを取得する

```bash
git clone https://github.com/Anpo13211/PaperLex.git
cd PaperLex
```

### 2. Mac にインストールする

Mac だけで使う場合は、ローカル専用の既定設定でインストールします。

```bash
./scripts/install-local.sh
```

同じ Wi-Fi 上のスマートフォンからも開きたい場合は、代わりに LAN モードを指定します。

```bash
./scripts/install-local.sh --lan
```

インストーラーは次の処理を自動で行います。

1. サーバーを `~/Library/Application Support/PaperLex` に配置
2. ブラウザ用パスワード、取り込み用トークン、セッション用秘密鍵を生成
3. macOS ログイン時にサーバーを起動する LaunchAgent を登録
4. 「調べる」を監視する `PaperLex Observer` を `~/Applications` に配置
5. 予備手段の `PaperLex に保存` サービスを登録

完了時に Mac 用 URL、ログイン用パスワード、LAN モードではスマートフォン用 URL が表示されます。パスワードは安全な場所に保存してください。インストーラーを再実行した場合、既存のパスワード、単語データ、有効な取り込み先設定は引き継がれます。

### 3. macOS の権限を許可する

初回のみ「システム設定 > プライバシーとセキュリティ」で、`PaperLex Observer` を次の 2 か所とも有効にします。

- `アクセシビリティ`：Preview のメニュー名と選択語を読むため
- `入力監視`：右クリックメニューの選択を受動的に検知するため

設定後に Observer を再起動します。

```bash
launchctl kickstart -k "gui/$UID/io.paperlex.lookup-observer"
```

許可状態は次のコマンドで確認できます。`TRUSTED` と表示されれば準備完了です。

```bash
"$HOME/Applications/PaperLex Observer.app/Contents/MacOS/PaperLexLookupObserver" --check-permissions
```

## 最初の単語を保存する

1. Preview で、PDF 内の単語または熟語を選択します。
2. 右クリックして「“単語”を調べる」を選びます。
3. Apple の辞書パネルが開き、同時に PaperLex へ単語が保存されます。
4. URL をブラウザで開きます。ローカル版ではインストール時に表示されたパスワード、プライベートクラウド版では公開先へのアクセス権がある ChatGPT アカウントでログインします。

自動保存できない場合でも、選択した文字を右クリックし「サービス > PaperLex に保存」を選べます。スキャン画像だけの PDF は、Preview で文字を選択できるように OCR してから使用してください。

### 辞書の表示

Apple 辞書の日本語定義は品詞ごとのグループに分け、発音や可算・不可算の情報を意味本文から分離します。`elucidator` のような派生語は番号付き語義ではなく「派生語」欄に表示します。この整形は、すでに保存済みの単語にも適用されます。

## Mac とスマートフォンから開く

### プライベートクラウド版を設定している場合

Preview の保存先をプライベートクラウド版にした場合、D1 の単語帳が唯一の正本です。Mac とスマートフォンのどちらからも、クラウド版の URL を開いてください。Mac が停止中でも、スマートフォンを別の Wi-Fi やモバイル回線から利用できます。

クラウド版の URL は、後述の手順で各自が作成したものを使用します。このリポジトリは共用の単語帳サイトを提供しません。ブラウザで単語帳を閲覧・編集するには、自分の公開先へのアクセス権がある ChatGPT アカウントでログインします。Preview からの自動保存はブラウザログインを使わず、Mac に設定した専用の取り込みトークンで認証します。

`capture.json` のクラウド設定を保ったままインストーラーを再実行すると、`http://127.0.0.1:8787` も同じクラウド版へ自動転送されます。移行前のローカル SQLite を確認する場合だけ、次の退避 URL を使います。

```text
http://127.0.0.1:8787/?local=1
```

### Mac 内だけで使う

```text
http://127.0.0.1:8787
```

既定のインストールではループバックアドレスだけを使用するため、ほかの端末からは接続できません。

### 同じ Wi-Fi 上のスマートフォンから使う

`./scripts/install-local.sh --lan` の完了時に表示された `http://<MacのIPアドレス>:8787` をスマートフォンで開きます。

- Mac とスマートフォンを同じ信頼できる Wi-Fi に接続してください。
- macOS のファイアウォール確認が表示された場合は、Node.js の受信接続を許可してください。
- LAN 版は HTTP 通信です。ポート転送を設定したり、インターネットへ直接公開したりしないでください。
- Mac がスリープまたは停止している間はアクセスできません。

## 設定と秘密情報

通常のローカルインストールでは、秘密情報を手動で作る必要はありません。生成された値は、権限を制限した LaunchAgent 設定に保存されます。

| 環境変数 | 用途 | 条件 |
| --- | --- | --- |
| `PAPERLEX_HOST` | 待ち受けアドレス | 既定値は `127.0.0.1` |
| `PAPERLEX_PORT` | Web サーバーのポート | 既定値は `8787` |
| `PAPERLEX_PASSWORD` | ブラウザへのログイン | LAN 公開時は 12 文字以上 |
| `PAPERLEX_CAPTURE_TOKEN` | Preview からの取り込み認証 | 24 文字以上、必須 |
| `PAPERLEX_SESSION_SECRET` | ログインセッションの署名 | ログイン有効時は 32 文字以上 |
| `PAPERLEX_SECURE_COOKIE` | Cookie を HTTPS 限定にする | `true` または `false` |
| `PAPERLEX_DATA_DIR` | SQLite データの保存先 | 既定値は `./data` |
| `PAPERLEX_LIBRARY_URL` | localhost から開くクラウド単語帳 | 認証情報・query・fragment を含まない外部 HTTPS hostname。通常は有効な remote `capture.json` から自動設定 |

秘密情報を Git にコミットしないでください。開発用に直接サーバーを起動する場合は、次のように一時的な値を生成できます。

```bash
export PAPERLEX_PASSWORD="$(openssl rand -hex 12)"
export PAPERLEX_CAPTURE_TOKEN="$(openssl rand -hex 24)"
export PAPERLEX_SESSION_SECRET="$(openssl rand -hex 32)"
export PAPERLEX_DATA_DIR="$PWD/data"
npm start
```

## トラブルシューティング

### `PaperLex Observer` が「入力監視」に表示されない

まず、インストール済み Observer から権限要求を実行します。

```bash
"$HOME/Applications/PaperLex Observer.app/Contents/MacOS/PaperLexLookupObserver" --request-permission
```

続いて「システム設定 > プライバシーとセキュリティ > 入力監視」を開きます。まだ一覧にない場合は `+` を押し、`~/Applications/PaperLex Observer.app` を追加して有効にしてください。同じアプリを「アクセシビリティ」にも追加します。その後、Observer を再起動して状態を確認します。

```bash
launchctl kickstart -k "gui/$UID/io.paperlex.lookup-observer"
"$HOME/Applications/PaperLex Observer.app/Contents/MacOS/PaperLexLookupObserver" --check-permissions
```

Observer はローカルの ad-hoc 署名でビルドされるため、更新や再インストール後に macOS が再許可を求める場合があります。

### 「調べる」を選んでも保存されない

1. 上記の権限確認コマンドが `TRUSTED` を返すことを確認します。
2. `http://127.0.0.1:8787/api/health` を開き、サーバーが動作しているか確認します。
3. 次のログを確認します。

```bash
tail -n 50 "$HOME/Library/Application Support/PaperLex/logs/observer-error.log"
tail -n 50 "$HOME/Library/Application Support/PaperLex/logs/server-error.log"
```

4. 予備手段の「サービス > PaperLex に保存」を試します。

### スマートフォンから接続できない

- LAN モードで再インストールしたことを確認してください。
- 端末が同じ Wi-Fi にあり、VPN やゲストネットワークで相互通信が遮断されていないか確認してください。
- Mac がスリープしていないことと、macOS ファイアウォールで Node.js が許可されていることを確認してください。

### パスワードを確認したい

ローカルインストーラーが保存した値は、次のコマンドで確認できます。画面共有中や配信中は実行しないでください。

```bash
/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:PAPERLEX_PASSWORD' \
  "$HOME/Library/LaunchAgents/io.paperlex.app.plist"
```

## バックアップ

画面右上の「バックアップ」を押すと、単語、履歴、学習状態、メモなどを JSON ファイルとして保存できます。定期的にこのファイルを別の安全な場所へコピーしてください。

ローカル版の SQLite データは次の場所にあります。

```text
~/Library/Application Support/PaperLex/data/paperlex.sqlite
```

JSON のエクスポートは利用できますが、ローカル版には JSON を読み戻す画面や API はまだありません。アンインストーラーは SQLite を削除せず、日時付きフォルダーへ退避します。

## アンインストール

リポジトリのルートで次を実行します。

```bash
./scripts/uninstall-local.sh
```

サーバーと Observer を停止し、LaunchAgent、Observer、サービス、設定、単語データを `~/Library/Application Support/PaperLex-uninstalled-<日時>` 系のパスへ移動します。データは自動削除されないため、不要であることを確認してから手動で削除できます。

## 任意: プライベートなクラウド版

`hosted/` には、OpenAI Sites と Cloudflare Worker / D1 互換環境向けのプライベート版が含まれています。ブラウザ UI は静的アセットとして配信し、単語と履歴は D1 に保存します。ローカル版を使うだけなら、この設定は不要です。

まずローカルで hosted 版を検証します。

```bash
cd hosted
npm ci
npm run db:generate
npm test
npm run build
```

クラウド版を作る場合は、Sites を利用できる Codex 環境で `hosted/` を作業フォルダーとして開き、次の依頼文をそのまま使用できます。

```text
この hosted フォルダーの PaperLex を、新しい OpenAI Sites プロジェクトとしてセットアップしてください。
所有者だけが閲覧できるプライベートサイトにし、D1 を論理名 DB で有効化して既存の
Drizzle migration を適用してください。PAPERLEX_CAPTURE_TOKEN と PAPERLEX_IMPORT_TOKEN には
互いに異なる十分に長いランダム値を生成して、Git ではなく Sites のランタイム Secret に設定してください。
ビルドとテストに成功したソースだけを保存・公開し、最後に自分のサイト URL と、Mac の
capture.json に設定する PAPERLEX_CAPTURE_TOKEN を一度だけ表示してください。
```

Codex が行う設定内容は次のとおりです。

1. `hosted/` を開き、Sites に「所有者だけが見られるプライベートサイトとして作成・公開する」と依頼します。
2. Sites が返した `project_id` を `hosted/.openai/hosting.json` に保存します。GitHub 版ではこの値を空にしてあるため、必ず自分のプロジェクトで発行された値を使用してください。
3. D1 を論理名 `DB` で有効にし、`db/schema.ts` と `drizzle/0000_eminent_banshee.sql` をデプロイ対象に含めます。
4. ランタイムの Secret として、互いに異なる `PAPERLEX_CAPTURE_TOKEN` と `PAPERLEX_IMPORT_TOKEN` を設定します。手動で用意する場合は、それぞれ `openssl rand -hex 32` で生成し、値をファイルや Git に保存しないでください。
5. ビルドとテストが成功したソースを保存し、所有者限定の private deployment として公開します。

このリポジトリだけでは、Sites アカウントの作成、D1 の準備、アクセス制御、Secret の登録までは自動化されません。一般公開やワンクリック公開を前提とした構成ではありません。

Preview からクラウドへ保存する場合は、Mac 側の `~/Library/Application Support/PaperLex/capture.json` を次の形に変更します。`baseURL` は自分の Sites URL、`token` はクラウド側に登録した `PAPERLEX_CAPTURE_TOKEN` と同じ値にします。

```json
{
  "baseURL": "https://your-private-paperlex.example",
  "token": "your-capture-token"
}
```

変更後に `./scripts/install-local.sh` を再実行すると、remote HTTPS の `baseURL` が表示用の `PAPERLEX_LIBRARY_URL` にも安全に引き継がれます。これ以降、`http://127.0.0.1:8787` はクラウド版を開き、Preview の保存先と表示先が分かれません。URL だけを引き継ぎ、`token` や `sitesBearerToken` をブラウザやリダイレクト先へ含めることはありません。

Sites のアクセス層が機械用 Bearer トークンを要求する場合だけ、プラットフォームから発行された値を `sitesBearerToken` として追加できます。ChatGPT のパスワードやセッションクッキーは使用しないでください。

既存の JSON バックアップを hosted 版へ移す場合は、一時的な `PAPERLEX_IMPORT_TOKEN` を使って `/api/import` へ送信します。移行後は、その Secret を削除またはローテーションしてください。

## Docker でローカルサーバーを動かす

macOS の Observer を使わず、Web サーバー部分だけをコンテナで動かす例です。

```bash
docker build -t paperlex .
docker run -d --name paperlex \
  -p 127.0.0.1:8787:8787 \
  -v paperlex-data:/data \
  -e PAPERLEX_PASSWORD='replace-with-a-long-password' \
  -e PAPERLEX_CAPTURE_TOKEN='replace-with-a-separate-random-token' \
  -e PAPERLEX_SESSION_SECRET='replace-with-another-random-secret-at-least-32-characters' \
  paperlex
```

インターネットから利用する場合は、HTTPS リバースプロキシの後ろに配置し、`PAPERLEX_SECURE_COOKIE=true` を設定してください。コンテナを公開しても、Mac 側の Observer や取り込みサービスは自動ではインストールされません。

## 開発とテスト

ローカル版には外部 npm パッケージの依存関係がありません。

```bash
npm test
npm run check
npm run build:mac
npm run check:mac
```

- `npm test`：Node.js のテストを実行
- `npm run check`：JavaScript の構文、Node.js テスト、macOS Observer を検証
- `npm run build:mac`：取り込みヘルパーと Observer をビルド
- `npm run check:mac`：Observer の判定、権限連携の契約、plist、署名を検証

`npm run check`、`npm run build:mac`、`npm run check:mac` は macOS と Xcode Command Line Tools が必要です。

## データとプライバシー

- ローカル SQLite：`~/Library/Application Support/PaperLex/data/paperlex.sqlite`
- サーバーログ：`~/Library/Application Support/PaperLex/logs/`
- Observer ログ：`~/Library/Application Support/PaperLex/logs/observer-error.log`
- 取り込み設定：`~/Library/Application Support/PaperLex/capture.json`
- ブラウザの表示用キャッシュ：そのブラウザのローカルストレージ

ローカル版は PDF 全体を送信しません。選択した単語や熟語を外部辞書・例文サービスへ問い合わせ、Apple 辞書の定義は Mac 上で取得します。クラウド版を設定した場合は、選択語、取得した定義、保存した出典や文脈が設定先へ送信され、D1 に保存されます。localhost の転送にはクラウド URL だけを使い、取り込み用の秘密値はブラウザへ渡しません。

- 英語定義：[Free Dictionary API](https://dictionaryapi.dev/)
- Free Dictionary API が利用できない場合の定義：[Wiktionary](https://en.wiktionary.org/)（[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)）
- 自動例文：[Tatoeba](https://tatoeba.org/)（画面に投稿者、原文ページ、API が示すライセンスを表示）

PaperLex Observer は Preview のアクセシビリティ情報を受動監視します。クリックを横取りせず、Apple の辞書表示を変更しません。この連携は Apple が PaperLex 向けに保証する拡張 API ではないため、macOS の更新後に権限の再設定や予備サービスが必要になる場合があります。
