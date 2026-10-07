# redaction-proxy

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語**

手元のマシンで動く小さなプロキシです。プロンプトがクラウドの LLM に届く前に、メールアドレス・API キー・個人番号などの個人情報をプレースホルダーに置き換え、返ってきた応答では元の値に戻します。

![AI ツールが lin@example.test を 127.0.0.1 の redaction-proxy に送り、クラウド LLM には ⟦EMAIL_1⟧ が届きます。応答は ⟦EMAIL_1⟧ のまま戻り、プロキシが lin@example.test に復元します。](docs/media/hero.svg)

OpenAI 互換・Anthropic 互換のクライアントならストリーミングも含めてそのまま使え、ローカルモデルは不要です。個人情報や認証情報の漏えいを**減らします**が、会話を**秘密にするものではありません**。

> **ステータス：** 正式リリース前で、npm には公開していません。テストはローカルのダミー上流サーバーに対してのみで、実際のサービスやクライアントでの検証はまだです。

## 紹介動画

[![30 秒のターミナル録画：pnpm demo がメールアドレス・身分証番号・ホームディレクトリのパスを送信し、クラウドにはプレースホルダーだけが届き、応答では元の値に戻ります。](docs/media/intro.gif)](docs/media/intro.mp4)

`pnpm demo` と、プロキシを通したもう 1 件のリクエストの実際の出力を再生しています（字幕は英語）。[MP4 版](docs/media/intro.mp4)

## 30 秒クイックスタート

Node 22.19 以上と pnpm が必要です。このリポジトリを clone したディレクトリで実行します。

```sh
pnpm install
pnpm demo          # API キー不要：ダミー上流 + プロキシ + ストリーミングリクエスト 1 件
pnpm build
node lib/cli.js    # プロキシを http://127.0.0.1:8787 で起動
```

`pnpm demo` の出力（デモの入力は繁体字中国語です）：

```text
client sends:      請寄信給 lin.fictional@example.test，身分證 A123456789，檔案在 /Users/fictional-user/notes.md
[proxy log] POST /v1/chat/completions -> 200 masked 3 (EMAIL 1, TWID 1, PATH 1) restored 3 unknown 0 8ms
upstream received: 請寄信給 ⟦EMAIL_1⟧，身分證 ⟦TWID_1⟧，檔案在 ⟦PATH_1⟧/notes.md
client receives:   I will email lin.fictional@example.test about /Users/fictional-user/notes.md (ID A123456789).
```

### Docker

まだビルドもテストもしていません。このイメージを書いた環境に Docker がありませんでした。

```sh
docker build -t redaction-proxy .
docker run --rm -p 127.0.0.1:8787:8787 redaction-proxy
```

> **必ず `-p 127.0.0.1:8787:8787` で公開し、`-p 8787:8787` は使わないでください。** プロキシには認証がありません。イメージはコンテナ内で `0.0.0.0` で待ち受けるため、`127.0.0.1:` の接頭辞だけが、プロキシと、ツールがそれを通して送る API キーをネットワークから守ります。

設定ファイル：`-v "$PWD/redaction.json:/redaction.json:ro"` を加え、末尾に `--config /redaction.json` を付けます。人名モデル：`--build-arg NAME_MODEL=1` でビルドし、`-v ~/models/nym:/models:ro -e REDACTION_PROXY_NAME_MODEL_DIR=/models` を加えます。

### npx（npm への初回公開後）

まだ npm には公開していません。公開後は次のとおりです。

```sh
npx redaction-proxy --demo
npx redaction-proxy           # プロキシを http://127.0.0.1:8787 で起動
```

## ツールの接続先を変える

> **実際のクライアントでは未検証です。** 実行済みなのは `pnpm demo` とダミー上流に対するテストだけです。実サービス向けの検証ツール（[e2e/real](e2e/real/README.md)）は用意してありますが、まだ実行していません。

API キーはこれまでどおりツールから送ってください。プロキシはそのまま転送し、保存しません。

| ツール | 設定 | 状態 |
| --- | --- | --- |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787 claude` | 未検証 |
| Anthropic SDK | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`（`/v1` なし） | 未検証 |
| OpenAI SDK と多くの互換ツール | `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`（`/v1` あり） | 未検証 |
| DeepSeek | `REDACTION_PROXY_OPENAI_UPSTREAM=https://api.deepseek.com node lib/cli.js` でプロキシを起動し、DeepSeek のキーと `OPENAI_BASE_URL=http://127.0.0.1:8787/v1` を使います。OpenAI の上流はこれで置き換わります。 | 未検証 |
| Cursor | 非対応：Cursor はカスタム base URL へのリクエストを Cursor 自身のサーバーから送るため、手元の `127.0.0.1` に届きません。 | — |

<details><summary>curl の例と設定ファイル</summary>

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer $OPENAI_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"lin@example.test にメールして"}]}'
```

`node lib/cli.js --config redaction.json` で JSON の設定ファイルを指定します。環境変数はファイルより優先されます。上流の API キーはファイルに書きません。知らない項目があると起動に失敗します。

| 項目 | 既定値 | 説明 |
| --- | --- | --- |
| `port` | `8787` | TCP ポート。 |
| `host` | `127.0.0.1` | 待ち受けるアドレス。ループバック以外（Docker の `0.0.0.0` など）では `authToken` が必須です。 |
| `authToken` | なし | クライアントが `x-redaction-proxy-token` ヘッダーで送るトークン。16 文字以上（`openssl rand -hex 32`）。ループバックでは省略できます。Claude Code は `ANTHROPIC_CUSTOM_HEADERS="x-redaction-proxy-token: <トークン>"` で送ります。SDK は既定ヘッダーのオプションを使います。 |
| `allowedOrigins` | なし | ループバックの `http(s)` ページ以外に受け付けるブラウザーや Electron の Origin。例：`app://my-client`。`null`（`file://` のページ）は指定できません。 |
| `openaiUpstream` | `https://api.openai.com` | Chat Completions と Responses の上流。 |
| `anthropicUpstream` | `https://api.anthropic.com` | Anthropic Messages の上流。 |
| `allowInsecureUpstream` | `false` | ループバック以外の上流への平文の `http://` を許可します。API キーが平文で流れます。 |
| `redaction.terms` | なし | マスクしたい人名などの語句。大文字小文字は区別しません。 |
| `redaction.projectNames` | なし | マスクしたいプロジェクトのコードネーム。 |
| `redaction.allowlist` | `git@github.com`、`noreply@github.com` | 決してマスクしない値。 |
| `redaction.rules` | `e164-phone` 以外すべて | 有効にする組み込みルール。`e164-phone` は数字で始まる diff の追加行を電話番号とみなしてしまうため、既定ではオフです。 |
| `nameModel` | なし | [実験的な人名モデル](#オプションの人名モデル実験的)を有効にします。 |
| `screen` | `replace` | 制御文字を見える文字に置き換える（`replace`）か、リクエストを拒否する（`refuse`）か。 |
| `debugMasked` | `false` | マスク後のリクエスト本文をログに出します。 |

```json
{
  "redaction": {
    "terms": ["林小明", "Denise Whitlock"],
    "projectNames": ["Nimbus"]
  }
}
```

環境変数とすべてのオプションは[技術詳細 第 12 節](docs/DETAILS.md#12-完整設定)（繁体字中国語）を参照してください。ログはリクエストごとに 1 行で、件数と所要時間を記録します。ツール呼び出しの引数にあるプレースホルダーは 1 つごとに 1 行（id、ツール、引数のパス）を記録します。元の値やヘッダーは一切含みません。

</details>

## マスクされるもの

![プロキシを通した実際のリクエスト：ツールはホスト名・プライベート IP・ホームディレクトリのパス・API キー・メールアドレスを送り、クラウド LLM には ⟦HOST_1⟧ や ⟦KEY_1⟧ などのプレースホルダーが届き、応答では元の値に戻ります。](docs/media/before-after.png)

| 種類 | 例 | クラウドに見えるもの |
| --- | --- | --- |
| メールアドレス | `lin@example.test` | `⟦EMAIL_1⟧` |
| API キーと認証情報 | `sk-…`、`ghp_…`、`AKIA…`、JWT、`Bearer …`、`password=…` | `⟦KEY_1⟧` |
| ホームディレクトリのパス（先頭部分のみ） | `/Users/lin/notes.md` | `⟦PATH_1⟧/notes.md` |
| プライベート IP、内部ホスト名 | `192.168.1.20`、`nas.local` | `⟦IP_1⟧`、`⟦HOST_1⟧` |
| カード番号（Luhn で検証） | 13〜19 桁 | `⟦CARD_1⟧` |
| 台湾の身分証番号・携帯番号・統一編号 | `A123456789`、`0912-345-678` | `⟦TWID_1⟧`、`⟦PHONE_1⟧` |
| ほか 10 の国・地域の ID、IBAN | マイナンバー、日本の携帯番号、米国 SSN、英国 NINO など | `⟦NATID_1⟧`、`⟦PHONE_1⟧`、`⟦IBAN_1⟧` |
| 長いランダム文字列 | 32 文字以上の hex や base64 | `⟦ENTROPY_1⟧` |
| 自分で指定した語句 | `terms`、`projectNames` | `⟦TERM_1⟧`、`⟦PROJECT_1⟧` |

同じ値はリクエスト全体で同じプレースホルダーになります。マスク後のリクエストに検出済みの値がまだ残っていれば、漏らす代わりに送信を拒否します（422）。全角数字・`＠`・ゼロ幅文字は正規化してから照合します。マイナンバーは「マイナンバー」「個人番号」などのキーワードの後にある場合だけ検出します。全ルールは[技術詳細 第 3 節](docs/DETAILS.md#3-偵測規則)にあります。

## オプションの人名モデル（実験的）

既定ではオフです。ルールだけでは人名は見つかりません。小さなローカルモデル（[`Wismut/nym-pii-multilingual-small`](https://huggingface.co/Wismut/nym-pii-multilingual-small)、MIT ライセンス、108 MB）を有効にすると、**あなたが書いた文章**の中の人名・会社名・地名・住所もマスクします（`⟦NAME_1⟧`、`⟦ORG_1⟧`、`⟦LOC_1⟧`、`⟦ADDR_1⟧`）。

```sh
pnpm add -D onnxruntime-node@1.30.0 tokenizers@0.23.2   # 実行環境、約 350 MB
node scripts/fetch-name-model.mjs ~/models/nym        # 約 125 MB、sha256 を検証
REDACTION_PROXY_NAME_MODEL_DIR=$HOME/models/nym node lib/cli.js
```

見逃す人名もあり、人名でない語をマスクすることもあります。合成データでの実測値：

| | 結果 |
| --- | --- |
| 文章中の人名：英語、日本語 | 再現率 1.00、1.00 |
| 貼り付けたコード・ログ・設定ファイル中の人名 | モデルは読みません。保留セットでは全人名の 65–70% を完全にマスク |
| 文章中の人名：繁体字中国語 | 再現率 **0.87**（8 人に 1 人ほど見逃す） |
| 貼り付けたコード・ログ・JSON 中の人名 | 再現率 0.10〜0.30：コードは読まないので、こうした人名は `terms` に入れてください |
| 適合率 | 0.94 |
| コスト | メモリ約 +420 MB、中国語の文章 2 KB あたり p95 約 130 ms |

日本語の名前の後の敬称や助詞（`さん`、`様`、`に` など）は範囲から外すので、`佐藤美咲さんに` は `⟦NAME_1⟧さんに` として送られます。読む範囲・全数値・オプションは[技術詳細 第 16 節](docs/DETAILS.md#16-人名模型實驗性)にあります。

## 結果

<!-- RESULTS:START -->
**held-out set (written blind, run once)：ホールドアウトセット（ルールを見ずに作成、1 回だけ実行）。** 7 言語（英語・繁体字中国語・簡体字中国語・日本語・韓国語・ドイツ語・フランス語）の合成プロンプト 1,518 件です。ルールを一度も見ていない人が作成し、SHA-256 で固定してから 1 回だけ採点しました。結果を見た後の修正はありません。

![棒グラフ：英語のホールドアウトプロンプトで種類ごとに完全にマスクされた割合。プロキシ既定のルール、ルール＋人名モデル、Presidio（cutoff 0.4）の比較。](docs/media/results.svg)

| ホールドアウト、英語プロンプト（330 件） | コア既定のルール | プロキシ既定のルール | ＋人名モデル（実験的） | Presidio、cutoff 0 | Presidio、cutoff 0.4 |
| --- | --- | --- | --- | --- | --- |
| 完全にマスク（10 種類のマクロ平均） | 34.6% | 54.1% | **61.1%** | 52.2% | 50.7% |
| マスクした範囲が実際に機密値だった割合 | 95.2% | **95.7%** | 92.5% | 64.7% | 69.0% |
| プロンプトあたりの処理時間の中央値 | 0.06 ms | 0.07 ms | 7.4 ms | 8.6 ms | 8.6 ms |
| 完全にマスク、全 7 言語 | 38.8% | 56.0% | 64.3% | 46.6%* | 43.0%* |

\* Presidio はすべてのプロンプトを英語として解析するため、全言語の結果は参考値です。

**100% の項目について。** メール・カード・IBAN が 100% なのは、このセットのそれらの値がすべて標準的な書き方だからです。難読化したメール（`name at example.com`、`name [at] example.com`）や小文字の IBAN はなく、IBAN は 7 か国分のみ、カード番号もよくある区切り方だけです。こうした書き方は見逃すことが分かっています（[守れないもの](#守れないもの)を参照）。サンプルも少ない（カード 107 件、IBAN 127 件）ため、ここでの 100% はおおよそ 97% 以上という意味です。次の保留セットではこれらの書き方を加えます。

自己チェック（スコアではありません）：すべてのプロンプトで、マスクしたテキストはバイト単位で元どおりに復元できました。これはプロキシ自身の置換を戻せるかの確認で、言語モデルは介在していません。

弱いところ：

- **電話番号。** プロキシ既定では英語の電話番号の 95% がまったくマスクされません（国際電話番号ルール `e164-phone` はオプトイン）。Presidio は 82〜85% を完全にマスクします。
- **パス**はほとんどが一部だけのマスクです。ユーザー名はマスクされ、パスの残りはそのまま残ります。
- **ホストと認証情報。** ホストの約 30%、認証情報の 26〜28% がまったくマスクされません。
- **住所。** 住所のルールはありません。
- **人名モデル**が完全にマスクする人名は 65〜70% で、user-agent 文字列も誤ってマスクします。

開発セット（dev set）のスコアはずっと高く出ました（プロキシ既定の英語マクロ平均 77.8%）。ルールと並行して作成したためで、現在は開発中の確認にだけ使っています。

詳しい表：[ホールドアウトの結果](bench/results/public-bench-held-out.md)、[開発セットの結果](bench/results/public-bench-dev.md)。方法とその他の計測：[技術詳細 第 18 節](docs/DETAILS.md#18-實測數字)。
<!-- RESULTS:END -->

## 守れないもの

- **意味。** プレースホルダーの周りはすべてクラウドに読まれます。`⟦PATH_1⟧/clients/acme-layoffs.md` でも多くが伝わります。
- **人名・住所・病状・給与**。`terms` に入れるか、人名モデルが見つけない限りそのまま送られます。
- **画像、PDF、音声、`url` フィールド、`metadata`、`stop` シーケンス、`name` フィールド（ツール名と参加者名）、署名付きの thinking。** これらはそのまま転送され、検査もしません。JSON オブジェクトのキーも同じです。マスク対象のテキストで検出した値がこの中にもあればリクエスト全体を 422 で拒否しますが、ここにしかない値はそのまま送られます。
- **変則的な書き方。** 空白を挟んだ `name @ domain`、`name at domain`、小文字の IBAN、二重にパーセントエンコードした値など、分割やエンコードされた形の一部は検出できません。
- **Cursor**、および自社サーバーからリクエストを送るツール。
- **同じマシン上の他のプログラム。** 既定では `127.0.0.1` だけで待ち受けます。`authToken` がなければ、同じマシン上のどのプログラムも使えます。Web ページからのリクエストは、Origin がループバックの `http(s)` ページか `allowedOrigins` にある場合を除き 403 で拒否します。別のホスト名を指定したリクエスト（DNS リバインディング）も 403 で拒否します。
- **モデルが値を書く場所。** プレースホルダーはモデルが書いた場所で復元されます。例外はツール呼び出しの引数の中の URL です。そこでは `https://example.test/?q=⟦EMAIL_1⟧` をそのまま残すので、Web 取得ツールは本物のメールアドレスを送れません。引数のほかの場所では復元されるため、モデルが書いたシェルコマンドが値を送ることはありえます。この復元はすべてログに残ります。

ほかにも：モデルが `⟦EMAIL_1⟧` を `[EMAIL_1]` と書き換えるとそのまま表示されます。マスクした値そのものを扱うタスクは精度が落ちます。制御文字は見える文字に置き換わります。再起動すると Responses API の会話の続きを忘れ、続きのリクエストは 422 で拒否します。64 MiB を超えるリクエストは 413 で拒否します。全一覧は[技術詳細 第 17 節](docs/DETAILS.md#17-完整限制清單)、脅威モデルは[第 11 節](docs/DETAILS.md#11-威脅模型)にあります。

## 詳しく

[docs/DETAILS.md](docs/DETAILS.md)（繁体字中国語）に、アーキテクチャ、dsh-privacy-router との比較、コア API、全ルール、ストリーミングの復元、422 の拒否、脅威モデル、全設定、テスト、計測方法、FAQ、このページの画像と動画の再生成方法をまとめています。

## ライセンス

[Apache-2.0](LICENSE)。ルールとエンジンの一部は [LYiHub/pub-dsh-privacy-router](https://github.com/LYiHub/pub-dsh-privacy-router)（MIT）に由来します。[NOTICE](NOTICE) を参照してください。
