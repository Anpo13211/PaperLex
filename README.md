# PaperLex

PaperLex は、macOS の Preview で論文を読みながら使える個人用単語帳です。選択した単語に対して Apple 標準の「調べる」を実行すると、いつもの辞書パネルを表示したまま、その単語と辞書情報を自動保存します。

Apple 辞書の定義に加えて、Free Dictionary API / Wiktionary の英語定義と Tatoeba の例文を表示できます。

ローカル版は Mac、または同じ Wi-Fi 上のスマートフォンから開けます。任意のクラウド版を用意すると、Mac が停止中でも別のネットワークから復習できます。クラウド版は Cloudflare か OpenAI Sites に置け、Cloudflare を選べば PaperLex 自身のパスワードで入れるため、開くたびに ChatGPT へログインする必要はありません。

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
4. URL をブラウザで開きます。ログイン方法は置き場所によって異なります。
   - ローカル版: インストール時に表示されたパスワード
   - Cloudflare 版: 自分で設定した `PAPERLEX_PASSWORD`
   - OpenAI Sites 版: 公開先へのアクセス権がある ChatGPT アカウント

自動保存できない場合でも、選択した文字を右クリックし「サービス > PaperLex に保存」を選べます。スキャン画像だけの PDF は、Preview で文字を選択できるように OCR してから使用してください。

### 辞書の表示

Apple 辞書の日本語定義は品詞ごとのグループに分け、発音や可算・不可算の情報を意味本文から分離します。`«…»` の共起パターン、`(!…)` の注記、`〘…〙` の分野表示、単独の `〈…〉` は意味本文から切り離し、「型・対象・用法・文体・注記」として語義の下に並べます。`〈物･事〉を` のように助詞が続く表記は自然な日本語なので本文に残します。用例は英文と和訳を行で分け、続けて書かれた成句は別の項目として表示します。`elucidator` のような派生語は番号付き語義ではなく「派生語」欄に表示します。この整形は、すでに保存済みの単語にも適用されます。

### 選択に句読点が混ざったとき

PDF では文末や引用符ごと選ばれることがあります。`suffice.`、`“suffice”`、`suffice[12]`、`suffice*` のような選択は、辞書を引く前に見出し語の `suffice` へ整えます。`e.g.` や `Ph.D.` のピリオド、`a-priori` や `state-of-the-art` のハイフン、`Occam's razor` のアポストロフィはそのまま残します。行末で分断された `suf-fice` は、連結した形が辞書にあるときだけ `suffice` として保存します。それでも辞書が引けなかった場合は、保存メッセージに「Apple辞書の定義が見つかりませんでした」と残るため、`~/Library/Application Support/PaperLex/logs/observer.log` で確認できます。

## Mac とスマートフォンから開く

### クラウド版を設定している場合

Preview の保存先をクラウド版にした場合、D1 の単語帳が唯一の正本です。Mac とスマートフォンのどちらからも、クラウド版の URL を開いてください。Mac が停止中でも、スマートフォンを別の Wi-Fi やモバイル回線から利用できます。

クラウド版の URL は、後述の手順で各自が作成したものを使用します。このリポジトリは共用の単語帳サイトを提供しません。閲覧・編集のログインは、Cloudflare 版なら `PAPERLEX_PASSWORD`、OpenAI Sites 版なら ChatGPT アカウントです。どちらの場合も、Preview からの自動保存はブラウザのログインを使わず、Mac に設定した専用の取り込みトークンで認証します。

`PAPERLEX_LIBRARY_URL` を設定しておくと、`http://127.0.0.1:8787` も同じクラウド版へ自動転送されます。移行前のローカル SQLite を確認する場合だけ、次の退避 URL を使います。

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

クラウド版（`hosted/`）では、次の値をランタイムの Secret として設定します。ローカル版とは別の値にしてください。

| 環境変数 | 用途 | 条件 |
| --- | --- | --- |
| `PAPERLEX_PASSWORD` | ブラウザへのログイン | 設定するとパスワード認証、未設定なら OpenAI Sites の認証に任せる |
| `PAPERLEX_SESSION_SECRET` | ログインセッションの署名 | パスワード認証時は 32 文字以上 |
| `PAPERLEX_CAPTURE_TOKEN` | Preview からの取り込み認証 | 24 文字以上、必須 |
| `PAPERLEX_IMPORT_TOKEN` | バックアップ取り込み | 移行時だけ設定し、終わったら削除する |

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

### インストーラーを再実行したら「調べる」が効かなくなった

`./scripts/install-local.sh` は `PaperLex Observer` を置き換えます。Observer はローカルの
ad-hoc 署名でビルドするため、置き換えると署名が変わり、macOS がアクセシビリティと入力監視の
許可を失効させます。ログには次の行が残ります。

```text
PaperLex lookup observer started (Accessibility needed, Input Monitoring needed).
```

「システム設定 > プライバシーとセキュリティ」のアクセシビリティと入力監視の両方で、
`PaperLex Observer` の項目を `−` で削除してから `+` で `~/Applications/PaperLex Observer.app`
を追加し直します。トグルの切り替えだけでは戻りません。そのうえで Observer を再起動します。

```bash
launchctl kickstart -k "gui/$UID/io.paperlex.lookup-observer"
tail -1 "$HOME/Library/Application Support/PaperLex/logs/observer-error.log"
```

`Accessibility allowed, Input Monitoring allowed` と出れば復旧しています。

クラウド版の URL を変えたいだけなら、インストーラーを使わず `capture.json` と
`PAPERLEX_LIBRARY_URL` を直接書き換えるほうが安全です（A-5 参照）。

### 単語は保存されたのに、日本語の意味が空になる

Apple 辞書の定義が取得できなかった場合です。保存メッセージに理由が残ります。

```bash
grep "見つかりませんでした" "$HOME/Library/Application Support/PaperLex/logs/observer.log"
```

選択に句読点が混ざっていた場合は自動で整形するため、通常は起きません。辞書に見出し語が
ない語（固有名詞や造語）では起こり得ます。その場合は、単語の詳細画面で自分の意味を追記できます。

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

## 任意: クラウド版（Mac が停止中でも、外出先から開く）

`hosted/` には、単語帳を自分専用のサイトとして公開するための一式が入っています。
ブラウザ UI は静的アセットとして配信し、単語と履歴は Cloudflare D1 に保存します。
Mac のローカル版だけで足りるなら、この章は不要です。

置き場所は2通りあり、**違いはログイン方法だけ**です。アプリのコードは共通で、
`PAPERLEX_PASSWORD` を設定したかどうかで認証方式が切り替わります。

| | A. Cloudflare へ直接置く | B. OpenAI Sites |
| --- | --- | --- |
| ログイン | PaperLex のパスワードを**初回に1回だけ** | 開くたびに ChatGPT アカウント |
| 必要なもの | Cloudflare アカウント（無料枠で足ります） | Sites を使える Codex 環境 |
| 保護される範囲 | `/api/` のデータ | ページ全体 |
| デプロイ | `./scripts/deploy-cloudflare.sh` | Codex に依頼 |

スマートフォンから毎回ログインしたくない場合は **A** を選んでください。
セッションは1年有効な HttpOnly cookie に入るため、ホーム画面に追加しておけば
以降はアイコンを押すだけで開きます。

なお A では、URL を知っている人にログイン欄までは見えます（単語は見えません）。
ページごと隠したい場合は B を選んでください。

まず、どちらの場合もローカルで検証しておきます。

```bash
cd hosted
npm ci
npm run db:generate
npm test
```

---

## A. Cloudflare へ直接置く

### A-1. Cloudflare にログインして D1 を作る

```bash
cd hosted
npx wrangler login
npx wrangler d1 create paperlex
```

`wrangler login` はブラウザが開き、Cloudflare アカウントの認可を求めます。

### A-2. Secret を3つ登録する

まず値を生成します。表示された文字列は、次のコマンドの入力待ちに貼り付けます。

```bash
openssl rand -hex 12   # PAPERLEX_PASSWORD
openssl rand -hex 32   # PAPERLEX_SESSION_SECRET
openssl rand -hex 24   # PAPERLEX_CAPTURE_TOKEN
```

```bash
npx wrangler secret put PAPERLEX_PASSWORD --name paperlex
npx wrangler secret put PAPERLEX_SESSION_SECRET --name paperlex
npx wrangler secret put PAPERLEX_CAPTURE_TOKEN --name paperlex
```

| Secret | 用途 | 控えておく必要 |
| --- | --- | --- |
| `PAPERLEX_PASSWORD` | スマートフォンで入力するパスワード | **必要**（パスワードマネージャーへ） |
| `PAPERLEX_SESSION_SECRET` | ログインセッションの署名鍵 | 不要 |
| `PAPERLEX_CAPTURE_TOKEN` | Preview からの取り込み認証 | 必要（A-5 で `capture.json` に書きます） |

`PAPERLEX_PASSWORD` が総当たりに対する唯一の防御なので、上のコマンドが生成する長さを保ってください。
値はファイルにも Git にも保存しないでください。Secret は Cloudflare 側にだけ残ります。

### A-3. テーブルを作ってデプロイする

```bash
npx wrangler d1 execute paperlex --remote --file drizzle/0000_eminent_banshee.sql
./scripts/deploy-cloudflare.sh
```

Worker 名や D1 名を変える場合は、`PAPERLEX_WORKER_NAME` と `PAPERLEX_D1_NAME` を指定します。
完了すると `https://<Worker名>.<サブドメイン>.workers.dev` が表示されます。

workers.dev のサブドメインを新規に作った直後は、証明書の発行に数分かかります。
その間は `curl` が `sslv3 alert handshake failure` を返しますが、待てば繋がります。

### A-4. 既存の単語を移す

移行元の画面右上「バックアップ」で JSON を保存してから、一時的な取り込みトークンで送ります。

```bash
npx wrangler secret put PAPERLEX_IMPORT_TOKEN --name paperlex

PAPERLEX_IMPORT_TOKEN='さきほどの値' ./scripts/import-backup.sh \
  ~/Downloads/paperlex-2026-01-01.json https://paperlex.example.workers.dev

npx wrangler secret delete PAPERLEX_IMPORT_TOKEN --name paperlex
```

取り込みが終わったら、最後の行で必ずトークンを削除してください。

### A-5. Preview の保存先を切り替える

`~/Library/Application Support/PaperLex/capture.json` を、新しい URL と A-2 の
`PAPERLEX_CAPTURE_TOKEN` に書き換えます。Cloudflare 版は Sites のアクセス層を使わないため、
`sitesBearerToken` があれば削除します。

```json
{
  "baseURL": "https://paperlex.example.workers.dev",
  "token": "A-2 で設定した PAPERLEX_CAPTURE_TOKEN と同じ値"
}
```

Mac から `http://127.0.0.1:8787` を開いたときもクラウド版へ転送したい場合は、
LaunchAgent の `PAPERLEX_LIBRARY_URL` を同じ URL に変更してサービスを入れ直します。

```bash
plist="$HOME/Library/LaunchAgents/io.paperlex.app.plist"
/usr/libexec/PlistBuddy -c 'Set :EnvironmentVariables:PAPERLEX_LIBRARY_URL https://paperlex.example.workers.dev' "$plist"
launchctl bootout "gui/$UID/io.paperlex.app"
launchctl bootstrap "gui/$UID" "$plist"
```

`launchctl kickstart` では plist を読み直さないため、`bootout` と `bootstrap` を使います。
`install-local.sh` を再実行しても同じ結果になりますが、そちらは Observer を置き換えるので
macOS の権限を再許可する必要が生じます（トラブルシューティング参照）。

### A-6. スマートフォンに登録する

Safari で Worker の URL を開き、A-2 のパスワードを入力します。
そのあと共有ボタンから「ホーム画面に追加」しておくと、次からはアイコンだけで開きます。

---

## B. OpenAI Sites に置く

Sites を利用できる Codex 環境で `hosted/` を作業フォルダーとして開き、次の依頼文をそのまま使用できます。

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

`PAPERLEX_PASSWORD` を設定しなければ、認証は Sites のプライベート配信に任されます。
このリポジトリだけでは、Sites アカウントの作成、D1 の準備、アクセス制御、Secret の登録までは自動化されません。

Preview からの保存先は A-5 と同じ `capture.json` で指定します。`baseURL` は自分の Sites URL、
`token` は Sites に登録した `PAPERLEX_CAPTURE_TOKEN` と同じ値にします。
Sites のアクセス層が機械用 Bearer トークンを要求する場合だけ、プラットフォームから発行された値を
`sitesBearerToken` として追加できます。ChatGPT のパスワードやセッションクッキーは使用しないでください。

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

クラウド版（`hosted/`）は npm パッケージを使うため、別に用意します。`npm test` はビルドも実行します。

```bash
cd hosted
npm ci
npm test
npm run dev    # ローカルの Workers ランタイムで動かす
```

`hosted/scripts/` には、Cloudflare へのデプロイ（`deploy-cloudflare.sh`）と
バックアップの取り込み（`import-backup.sh`）があります。

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
