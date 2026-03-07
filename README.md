# claude-proxy

Claude Code から upstream LLM エンドポイントまでの HTTP 通信を、ローカルで中継しながら観測するための TypeScript 製プロキシです。

現在の実装は transport-only です。Claude Code から受けたリクエストを upstream に転送し、レスポンスをそのまま返しつつ、相関 ID 付きの構造化ログを出力します。

## 前提

- Bun 1.3.10 以上

このプロジェクトは `.ts` を Bun で直接実行します。ビルドステップは不要です。ランタイム実装も Bun / Web API ベースです。

## できること

- 設定可能な upstream base URL へ HTTP リクエストを転送する
- ステータスコード、ヘッダー、ストリーミングレスポンスを維持する
- 相関 ID 付きの JSON ログを出力する
  - Claude Code から受けたリクエスト
  - upstream から返ったレスポンス
  - プロキシの起動 / 停止
  - プロキシエラー
- `authorization`, `x-api-key`, `cookie`, `set-cookie` などの機微ヘッダーをマスクする
- JSON リクエスト内の `x-anthropic-billing-header ... cch=xxxxx` を upstream 送信時だけ `cch=00000` に置き換え、レスポンス本文 / ヘッダーでは元の値へ戻す

## 設定

| 変数 | 必須 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `UPSTREAM_BASE_URL` | yes | - | upstream の base URL。例: `http://127.0.0.1:1234` |
| `PROXY_HOST` | no | `127.0.0.1` | プロキシが listen するホスト |
| `PROXY_PORT` | no | `9000` | プロキシが listen するポート |
| `REQUEST_TIMEOUT_MS` | no | `300000` | upstream リクエストのタイムアウト時間（ミリ秒） |
| `LOG_BODY_MAX_BYTES` | no | `262144` | ログに含めるリクエスト / レスポンス本文の最大バイト数 |
| `LOG_PRETTY` | no | `false` | `true` のとき JSON ログを見やすく整形して出力する |
| `LOG_FILE` | no | - | 指定したパスのファイルへ JSON ログを追記する。未指定時は stdout |

## 実行方法

1. 依存を入れます。

```bash
bun install
```

2. `.env` を作成します。

```bash
cp .env.example .env
```

3. `.env` の `UPSTREAM_BASE_URL` を実際の upstream に合わせて設定します。

```dotenv
UPSTREAM_BASE_URL=http://127.0.0.1:1234
```

4. プロキシを起動します。

```bash
bun run start
```

起動時に `.env` を自動で読み込みます。シェルで同じ変数を `export` している場合は、その値を優先します。

開発時に watch 付きで起動する場合:

```bash
bun run dev
```

テスト:

```bash
bun run test
```

型チェック:

```bash
bun run typecheck
```

Claude Code 側の接続先例:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:9000
```

## 補足

- このバージョンは transport-only で、Anthropic 形式のリクエストを別スキーマへ変換する処理はまだ入っていません。
- ログ出力と `cch` 置換のために、リクエスト本文は一度バッファしてから upstream に転送します。
- `LOG_FILE` 未指定時のログは stdout、指定時はそのファイルへ追記されます。
- `LOG_PRETTY=true` を指定しない限り、ログは 1 行 1 JSON の形式です。
- `UPSTREAM_BASE_URL` にパスが含まれている場合も、受信パスと正しく結合して転送します。例: `http://127.0.0.1:1234/lmstudio` + `/v1/messages`
- `typescript` と `@types/bun` を dev dependency に含めているので、エディタ上でも Bun / Web API と `.ts` import の型解決が効きます。
