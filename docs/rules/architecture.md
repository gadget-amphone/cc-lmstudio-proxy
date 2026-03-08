# アーキテクチャルール

## 概要

このプロジェクトは、Claude Code と上流の AI サービスプロバイダー（Anthropic API, LM Studio）間のリクエストをインターセプトしてログ記録するプロキシサーバーです。Bun と TypeScript で構築されています。

## コア原則

### 1. 単一責任
各モジュールは明確な 1 つの目的を持つべきです：
- `config.ts` - 設定の読み込みと検証
- `proxy.ts` - HTTP プロキシロジックとリクエストハンドリング
- `logging.ts` - 構造化ログユーティリティ
- `env.ts` - 環境変数のパース
- `codec.ts` - リクエスト/レスポンスボディのエンコーディングユーティリティ

### 2. 可能な限り純粋関数を使用
ビジネスロジックは純粋関数として実装すべきです：
- 明示的な入力を受け取る（隠れた依存関係がない）
- 副作用を生成しない
- 隔離された状態で簡単にテスト可能

`config.ts` の例：
```typescript
function parsePositiveInteger(value: string | undefined, label: string, fallback: number): number {
  // 明示的な入力と出力を持つ純粋関数
}
```

### 3. 依存性注入
外部依存（環境変数など）は直接アクセスせず、注入すべきです：
```typescript
// 良い：env が注入されている
function loadConfig(env: EnvironmentMap = Bun.env): ProxyConfig

// 悪い：関数内で直接 Bun.env にアクセスしている
function loadConfig(): ProxyConfig {
  const value = Bun.env.SOME_VAR;
}
```

### 4. エラーハンドリング戦略
- 起動時に設定を検証し、早期に失敗する
- ランタイムエラーは意味のあるエラーメッセージで適切に処理する
- デバッグに必要なコンテキストをログに記録する

## モジュール依存関係

```
index.ts (エントリーポイント)
├── config.ts
│   ├── path.ts
├── proxy.ts
│   ├── logging.ts
│   └── codec.ts
└── logging.ts
    └── env.ts
```

## リクエストフロー

1. サーバーが `/:path*` で受信リクエストを受け取る
2. プロキシが URL を書き換えて上流サーバーをターゲットにする
3. リクエストをログ記録（ヘッダー + サイズ制限内のボディ）
4. 上流にリクエストを転送
5. 上流からレスポンスを受信
6. レスポンスをログ記録
7. クライアントにレスポンスを返す

## 設定システム

設定は以下の優先順位に従います：
1. コマンドライン引数（最優先）
2. 環境変数（`.env` ファイルまたはプロセス環境）
3. コードで定義されたデフォルト値（最低優先）

すべての設定検証は `loadConfig()` 経由で起動時に実行されます。

### コマンドライン引数の処理

```typescript
// CLI オプションの解析
const cliOptions = parseCliArgs(process.argv.slice(2));

// loadConfig に CLI オプションを渡す
const config = loadConfig(await loadEnvironment(Bun.env), cliOptions);
```

`--log` フラグが指定された場合のみ、`LOG_FILE` 環境変数が有効になる。

## テストアーキテクチャ

テストは Bun の組み込みテスランナーを使用して記述します：
- テストファイルはソースファイルの構造をミラーリングする（`src/foo.ts` → `test/foo.test.ts`）
- テストは隔離されており、決定論的であるべき
- 外部依存をモックするために依存性注入を使用する
