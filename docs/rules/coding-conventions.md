# コーディング規約

## TypeScript

### 型注釈

以下の場合は常に明示的な型注釈を使用すること：
- 関数のパラメータと戻り値の型
- エクスポートされた定数と変数
- インターフェースと型の定義

```typescript
// 良い
export function parseConfig(env: EnvironmentMap): ProxyConfig { ... }
export const DEFAULT_PORT = 9000;

// 悪い - 型注釈がない
export function parseConfig(env) { ... }
```

### Interface vs Type

拡張される可能性のあるオブジェクト形状には `interface` を使用：
```typescript
export interface ProxyConfig {
  host: string;
  port: number;
}
```

ユニオン、プリミティブ、または合成が必要な場合は `type` を使用：
```typescript
type LogLevel = "debug" | "info" | "warn" | "error";
type Result<T> = { ok: true; value: T } | { ok: false; error: Error };
```

### ジェネリクス

再利用可能で型安全なユーティリティにはジェネリクスを使用：
```typescript
function parseJSON<T>(json: string): T { ... }
```

## コードスタイル

### 命名規則

| 種類 | 規約 | 例 |
|------|------------|---------|
| 変数/関数 | camelCase | `parseConfig`, `requestTimeout` |
| 定数 | UPPER_SNAKE_CASE | `DEFAULT_PORT`, `MAX_RETRIES` |
| 型/インターフェース/ケース | PascalCase | `ProxyConfig`, `LogLevel` |
| ファイル | lowercase + ハイフン | `coding-conventions.ts` |

### 文字列フォーマット

- 文字列補間にはテンプレートリテラルを使用：
  ```typescript
  const url = `${baseUrl}/${path}`;
  ```

- 通常の文字列にはダブルクォート、内部にダブルクォートを含む場合はシングルクォート：
  ```typescript
  const message = "Hello";
  const error = `Failed to parse "${input}"`;
  ```

### オブジェクトリテラル

複数行のオブジェクトではトレーリングカンマを使用：
```typescript
const config = {
  host: "127.0.0.1",
  port: 9000,
  timeout: 30000,
};
```

### アロー関数

コールバックと短いインライン関数にはアロー関数を使用：
```typescript
const items.map(item => item.value);
```

`this` を使用する可能性のある名前付き関数には function キーワードを使用：
```typescript
function parseConfig(env: EnvironmentMap): ProxyConfig {
  // ...
}
```

## エラーハンドリング

### 早期にエラーをスローする

関数の開始時に入力と設定を検証する：
```typescript
export function loadConfig(env: EnvironmentMap): ProxyConfig {
  if (!env.UPSTREAM_BASE_URL) {
    throw new Error("UPSTREAM_BASE_URL is required");
  }
  // ...
}
```

### ランタイム検証にはタイプガードを使用する

```typescript
function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
```

### エラーメッセージ

- 何が間違っていたかを具体的に記述する
- 必要に応じて無効な値を含める
- 可能であれば修正方法を提案する

```typescript
// 良い
throw new Error(`PROXY_PORT must be a positive integer, got: ${env.PROXY_PORT}`);

// 悪い
throw new Error("Invalid port");
```

## 関数

### 関数の長さ

関数は焦点を絞り、短く保つこと。約 50 行を超える場合は、より小さな部分に分割することを検討する。

### パラメータ数

関数のパラメータは 3 つ以下に抑えること。より複雑な設定にはオプションオブジェクトを使用：
```typescript
// 良い
function createProxy(options: ProxyOptions): Server { ... }

interface ProxyOptions {
  host: string;
  port: number;
  upstreamBaseUrl: URL;
  timeout: number;
}

// 避ける - パラメータが多すぎる
function createProxy(
  host: string,
  port: number,
  upstreamBaseUrl: URL,
  timeout: number,
  retries: number,
): Server { ... }
```

### 早期リターン

ガード節を使用してネストを減らす：
```typescript
// 良い
function parseValue(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = parseInt(value);
  return isNaN(parsed) ? fallback : parsed;
}

// 悪い - 不要なネスト
function parseValue(value: string | undefined, fallback: number): number {
  if (value !== undefined) {
    const parsed = parseInt(value);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
```

## テスト

### テスト構造

Bun のテスランナーを使用し、describe ブロックで整理する：
```typescript
import { describe, expect, it } from "bun:test";

describe("loadConfig", () => {
  it("UPSTREAM_BASE_URL が missing の場合、エラーをスローすること", () => {
    expect(() => loadConfig({})).toThrow("UPSTREAM_BASE_URL is required");
  });

  it("環境変数が設定されていない場合、デフォルト値を使用すること", () => {
    const config = loadConfig({ UPSTREAM_BASE_URL: "http://localhost" });
    expect(config.port).toBe(9000);
  });
});
```

### テスト命名

テスト名は期待される動作を記述すること：
- 期待される結果には "should" を使用する
- 関連する場合は前提条件を名前に含める

```typescript
// 良い
it("UPSTREAM_BASE_URL が missing の場合、エラーをスローすること");
it("PROXY_PORT が設定されていない場合、デフォルトポートを使用すること");

// 悪い
it("config テスト");
it("port テスト");
```

### テストの隔離

各テストは以下を満たすべき：
- 他のテストに依存しない
- 外部状態に依存しない
- 作成したリソースをクリーンアップする

## ロギング

`logging.ts` のロギングユーティリティを使用する：
```typescript
import { createStructuredLogger } from "./logging.ts";

const logger = createStructuredLogger({
  pretty: config.prettyLogs,
  filePath: config.logFile,
});
logger.log({
  timestamp: new Date().toISOString(),
  event: "proxy.started",
});
```

ログレベル：
- `debug` - 詳細な診断情報
- `info` - 一般的な運用メッセージ
- `warn` - 実行を停止しない潜在的な問題
- `error` - 操作を防止するエラー

### ログ出力の制御

ログ出力はコマンドライン引数 `--log` または `-l` が指定された場合のみ有効になる：

```typescript
// index.ts より
const cliOptions = parseCliArgs(process.argv.slice(2));
const config = loadConfig(await loadEnvironment(Bun.env), cliOptions);

// --log が指定された場合のみロギングを有効化
const logger = config.enableLogging
  ? createStructuredLogger({
      pretty: config.prettyLogs,
      filePath: config.logFile,
    })
  : undefined;
```

`LOG_FILE` 環境変数が設定されている場合はファイルに出力され、それ以外は標準出力に出力される。

## コメント

### コメントを書く場合

- コードが「何」をしているかではなく、「なぜ」しているかを説明する
- 自明でない決定や回避策を文書化する
- 複雑なアルゴリズムにはコンテキストを追加する

```typescript
// 良い：理由を説明している
// Bun の最大アイドルタイムアウトは 255 秒
const MAX_BUN_IDLE_TIMEOUT_SECONDS = 255;

// 悪い：当たり前を述べている
// カウンターを 1 増やす
counter++;
```

### TODO コメント

既知の改善点には TODO コメントを使用する：
```typescript
// TODO: 乱用防止のためにレートリミッティングを追加する
```

## インポートとエクスポート

### インポート順序

1. サードパーティパッケージ（このプロジェクトではなし）
2. 内部インポート、アルファベット順

```typescript
import { createLogger } from "./logging.ts";
import { resolvePath } from "./path.ts";
```

### エクスポート

デフォルトエクスポートより名前付きエクスポートを優先する：
```typescript
// 良い
export function loadConfig() { ... }
export interface ProxyConfig { ... }

// 避ける
export default function() { ... }
```
